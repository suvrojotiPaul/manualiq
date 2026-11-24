// Retrieval: rank whole manuals, pick sections inside them, send whole sections up to a token budget.
// Hybrid: keyword search (FTS5/BM25, exact match on model and part codes) blended with vector search
// (local embeddings, see embed.js). Manuals: card 0.35 + chunks 0.35 + vectors 0.30; sections: 50/50.
// See docs/how-it-works.md.
import { db, stmt, parseManual } from './db.js';
import { config } from './config.js';
import { vectorSearch } from './embed.js';

const STOP = new Set(('a an the and or of to in on for with by at from is are was were be been do does did how what which who ' +
  'when where why can could should would will i my me we our you your it its this that these those there here ' +
  'please need want get set up about into over under than then so if not no yes any some all more most very ' +
  'tell show give explain help using use used').split(' '));

// "set it up" style questions: whole manual only if the manual is small
const SETUP_RE = /\b(install|installation|set ?up|setup|assembl\w*|commission\w*|configure|wir(e|ing))\b/i;
// explicitly asking for everything: whole manual up to the larger limit
const ALL_RE = /\b(all (the )?steps|complete|full|whole|entire|overview|from scratch|start to finish|step[- ]by[- ]step guide)\b/i;
const WIRING_DOC_MAX = 8000; // tokens: send a wiring-diagram document whole up to this size
const CODE_RE = /\b(?=[A-Za-z0-9./-]*\d)(?=[A-Za-z0-9./-]*[A-Za-z-])[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+)*\b/g;

export function extractCodes(text) {
  const out = new Set();
  for (const m of text.matchAll(CODE_RE)) {
    const norm = m[0].replace(/[-./]/g, '').toLowerCase();
    if (norm.length >= 4 && /\d/.test(norm) && !/^\d{1,4}$/.test(norm)) out.add(norm);
  }
  return [...out];
}

function terms(text) {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w)))];
}

function ftsQuery(text, { codeCol = 'codes' } = {}) {
  const words = terms(text).map(w => `"${w}"`);
  const codes = extractCodes(text).map(c => `${codeCol}:"${c}"`);
  return [...codes, ...words].join(' OR ');
}

function normalize(map) {
  const vals = [...map.values()];
  const max = Math.max(...vals, 1e-9);
  return new Map([...map].map(([k, v]) => [k, v / max]));
}

/** Rank manuals for a question: manual-card search + aggregated chunk hits. */
/** Sum of each manual's top 3 hit scores. */
function aggByManual(hits) {
  const agg = new Map(), seen = new Map();
  for (const h of hits) {
    const n = seen.get(h.manual_id) || 0;
    if (n < 3) { agg.set(h.manual_id, (agg.get(h.manual_id) || 0) + h.score); seen.set(h.manual_id, n + 1); }
  }
  return agg;
}

/** Cosine scores sit in a narrow band (0.5-0.8): shift by the weakest returned hit so normalizing spreads them. */
function shiftScores(hits) {
  if (!hits.length) return hits;
  const floor = hits[hits.length - 1].score;
  return hits.map(h => ({ ...h, score: Math.max(0, h.score - floor) }));
}

function rankManuals(question, { boostManuals = [], qvec = null } = {}) {
  const q = ftsQuery(question);
  const vecHits = qvec ? shiftScores(vectorSearch(qvec, 300)) : [];
  if (!q && !vecHits.length) return { ranked: [], chunkHits: [], vecHits };
  const card = new Map();
  if (q) for (const r of stmt.searchManuals.all(q, 25)) card.set(r.manual_id, -r.score);
  const chunkHits = q ? stmt.searchChunks.all(q, 300).map(r => ({ ...r, score: -r.score })) : [];
  const nc = normalize(card), na = normalize(aggByManual(chunkHits)), nv = normalize(aggByManual(vecHits));
  // weights: keyword-only 0.45 card / 0.55 chunks (as before); hybrid gives the vector side a third
  const [wc, wa, wv] = vecHits.length ? [0.35, 0.35, 0.30] : [0.45, 0.55, 0];
  const all = new Map();
  for (const id of new Set([...nc.keys(), ...na.keys(), ...nv.keys()])) {
    all.set(id, wc * (nc.get(id) || 0) + wa * (na.get(id) || 0) + wv * (nv.get(id) || 0));
  }
  for (const id of boostManuals) if (all.has(id)) all.set(id, all.get(id) + 0.25);
  // wiring questions: wiring-diagram documents are mostly drawings with little text, so they score low on text
  const wiringQ = WIRING_Q.test(question);
  const rows = new Map();
  for (const [id] of [...all].sort((a, b) => b[1] - a[1]).slice(0, 40)) rows.set(id, parseManual(stmt.manual.get(id)));
  if (wiringQ) for (const [id, m] of rows) if (m && isWiringDoc(m)) all.set(id, all.get(id) + 0.2);
  const ranked = dedupeRevisions([...all].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score, m: rows.get(id) })));
  return { ranked, chunkHits, vecHits };
}

// Questions about wiring/diagrams, and documents that are wiring diagrams.
export const WIRING_Q = /\b(wir(e|es|ed|ing)|diagrams?|schematics?|terminals?|hook ?up|pin ?out|connect(ion|ions)? diagram)\b/i;
const isWiringDoc = m => /\b(wiring|diagrams?|schematics?)\b/i.test(`${m.title} ${m.description}`) || /wiring|diagram|schematic/i.test(m.id);

const baseNumber = doc_number => String(doc_number || '').trim().split(/\s+-\s+|\s+/)[0].toUpperCase();
const revOf = m => {
  const r = String(m.doc_number || '').match(/\b(?:REV|RV|Rev\.?|Ver(?:sion)?\.?|V)\s*(\d+)/i);
  return r ? Number(r[1]) : (parseFloat(m.version) || -1);
};
/** Several revisions of one document (e.g. 123-00609 REV00 and REV02) crowd out other manuals: keep the newest,
 *  at the best rank any of them had. */
function dedupeRevisions(ranked) {
  const best = new Map(); // base number -> entry
  for (const r of ranked) {
    const base = r.m && baseNumber(r.m.doc_number);
    if (!base || base.length < 4) continue;
    const cur = best.get(base);
    if (!cur) best.set(base, { keep: r, score: r.score });
    else if (revOf(r.m) > revOf(cur.keep.m)) cur.keep = r;
  }
  const out = [], used = new Set();
  for (const r of ranked) {
    const base = r.m && baseNumber(r.m.doc_number);
    const e = base && best.get(base);
    if (!e) { out.push(r); continue; }
    if (used.has(base)) continue;
    used.add(base);
    out.push({ ...e.keep, score: e.score });
  }
  return out;
}

function sectionScoreMap(hits, manualIds, exclude) {
  const scores = new Map();
  for (const h of hits) {
    if (!manualIds.has(h.manual_id) || exclude.has(h.section_id)) continue;
    const cur = scores.get(h.section_id);
    scores.set(h.section_id, cur ? cur + 0.3 * h.score : h.score);
  }
  return scores;
}

/** Section scores from keyword hits, blended 50/50 with vector hits when there are any. */
function sectionScores(chunkHits, manualIds, exclude, vecHits = []) {
  const kw = normalize(sectionScoreMap(chunkHits, manualIds, exclude));
  if (!vecHits.length) return [...kw].sort((a, b) => b[1] - a[1]);
  const vec = normalize(sectionScoreMap(vecHits, manualIds, exclude));
  const all = new Map();
  for (const id of new Set([...kw.keys(), ...vec.keys()])) all.set(id, 0.5 * (kw.get(id) || 0) + 0.5 * (vec.get(id) || 0));
  return [...all].sort((a, b) => b[1] - a[1]);
}

/** Re-search inside the chosen manuals using only words that tell sections apart
 *  (words from the manual's own title/description match every section, so they are dropped). */
const focusedStmt = db.prepare(`SELECT chunk_id, section_id, manual_id, bm25(chunks_fts, 0, 0, 0, 4.0, 1.0, 6.0) AS score
  FROM chunks_fts WHERE chunks_fts MATCH ? AND manual_id = ? ORDER BY score LIMIT 120`);

function focusedHits(question, manuals, manualWeight) {
  if (!manuals.length) return null;
  const codes = extractCodes(question);
  const rows = [];
  for (const m of manuals) { // per manual: drop only *that* manual's title words
    const routing = new Set(terms(`${m.title} ${m.description} ${(m.tags || []).join(' ')}`));
    const words = terms(question).filter(w => !routing.has(w));
    if (!words.length && !codes.length) continue;
    const q = [...codes.map(c => `codes:"${c}"`), ...words.map(w => `"${w}"`)].join(' OR ');
    const w = manualWeight.get(m.id) ?? 1;
    for (const r of focusedStmt.all(q, m.id)) rows.push({ ...r, score: -r.score * w });
  }
  return rows.length ? rows : null;
}

// sections that are rarely the answer unless the question is about them
const BOILER_TITLE = /\b(safety|caution|warning|hazard|danger|decal|sign-?off|warranty|contents|cautionary|symbol|precaution|disclaimer|copyright)\b/i;
const SAFETY_Q = /\b(safety|safe|danger|hazard|warning|caution|decal|ppe|warranty)\b/i;

function manualCard(m) {
  return { id: m.id, doc_number: m.doc_number, version: m.version, title: m.title, description: m.description, models: m.models,
           filename: m.filename, url: m.url, pages: m.pages, tokens: m.tokens,
           toc: m.toc.slice(0, 60).map(t => ({ title: t.title, page: t.page })) };
}

/**
 * Main entry. Returns { mode, manuals: [card], sections: [row], candidates: [card], tokens, reason }.
 * opts.exclude: section ids not to use (retry); opts.boostManuals: manual ids from earlier turns;
 * opts.budget: token budget; opts.preferManual: restrict to this manual (more).
 */
export function retrieve(question, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const budget = opts.budget || config.budget.normal;
  const { ranked, chunkHits } = rankManuals(question, { boostManuals: opts.boostManuals, qvec: opts.qvec });
  if (!ranked.length) return { mode: 'none', manuals: [], sections: [], candidates: [], tokens: 0, reason: 'no matches' };

  const top = ranked[0].score;
  let chosen = ranked.filter(r => r.score >= 0.6 * top).slice(0, 3);
  // wiring question: the best-matching wiring diagram goes in whole; diagrams for other models
  // (model 310 when asked about model 24) are dropped
  let wiringDocs = [];
  if (WIRING_Q.test(question) && !opts.preferManual) {
    const docs = ranked.slice(0, 6).filter(r => r.m && isWiringDoc(r.m) && r.m.tokens <= WIRING_DOC_MAX);
    if (docs.length && docs[0].score >= 0.5 * top) {
      wiringDocs = docs.filter(r => r.score >= 0.9 * docs[0].score).slice(0, 2);
      const keep = new Set(wiringDocs.map(r => r.id));
      chosen = [...wiringDocs, ...chosen.filter(r => !keep.has(r.id) && !(r.m && isWiringDoc(r.m)))].slice(0, 3);
    }
  }
  if (opts.preferManual) chosen = [{ id: opts.preferManual, score: top }];
  const chosenIds = new Set(chosen.map(c => c.id));
  const manuals = chosen.map(c => parseManual(stmt.manual.get(c.id))).filter(Boolean);
  const candidates = ranked.slice(0, 6).map(r => parseManual(stmt.manual.get(r.id))).filter(Boolean).map(manualCard);

  // Whole-manual mode: one clearly dominant manual + a broad question + it fits.
  const dominant = chosen.length === 1 || (ranked[1] && ranked[1].score < 0.5 * top);
  const primary = manuals[0];
  const wantsWhole = primary && (opts.wholeManual || primary.tokens <= 2500 ||
    (ALL_RE.test(question) && primary.tokens <= config.budget.wholeManualMax) ||
    (SETUP_RE.test(question) && primary.tokens <= Math.min(budget, 12000)));
  if (!exclude.size && dominant && wantsWhole) {
    const sections = stmt.sectionsOfManual.all(primary.id).filter(s => s.kind !== 'contents');
    return { mode: 'whole-manual', manuals: [manualCard(primary)], sections, candidates,
             tokens: sections.reduce((n, s) => n + s.tokens, 0), reason: 'dominant manual + broad question' };
  }

  // Section mode: best sections first, until the budget is used.
  const picked = [], used = new Set();
  let tokens = 0;
  const add = s => {
    if (!s || used.has(s.id) || exclude.has(s.id) || s.kind === 'contents') return false;
    if (tokens + s.tokens > budget && picked.length) return false;
    picked.push(s); used.add(s.id); tokens += s.tokens; return true;
  };
  for (const d of wiringDocs) { // whole diagram document first: its text is labels, any part may matter
    for (const s of stmt.sectionsOfManual.all(d.id)) add(s);
  }
  const manualWeight = new Map(chosen.map(c => [c.id, Math.max(0.5, c.score / top)]));
  const demote = !SAFETY_Q.test(question);
  // vector hits inside the chosen manuals only (their own ranking, not the global top 300)
  const vecInChosen = opts.qvec ? shiftScores(vectorSearch(opts.qvec, 150, chosenIds))
    .map(h => ({ ...h, score: h.score * (manualWeight.get(h.manual_id) ?? 1) })) : [];
  const scored = sectionScores(focusedHits(question, manuals, manualWeight) || chunkHits, chosenIds, exclude, vecInChosen)
    .map(([sid, score]) => { const s = stmt.section.get(sid); return [s, demote && BOILER_TITLE.test(s?.path || '') ? score * 0.35 : score]; })
    .sort((a, b) => b[1] - a[1]);
  const best = scored[0]?.[1] || 0;
  for (const [s, score] of scored) {
    if (score < 0.4 * best) break; // weak matches only add noise
    if (!add(s)) continue;
    // short section or a split procedure: bring the next part too so steps aren't cut off
    if (s.tokens < 250 || / \(part \d+\/\d+\)$/.test(s.title)) add(stmt.sectionByOrd.get(s.manual_id, s.ord + 1));
    if (tokens >= budget) break;
  }
  if (!picked.length && primary) { // nothing matched inside the manual text: give its first sections
    for (const s of stmt.sectionsOfManual.all(primary.id)) { if (!add(s) || tokens > budget / 2) break; }
  }
  picked.sort((a, b) => (a.manual_id === b.manual_id ? a.ord - b.ord : a.manual_id < b.manual_id ? -1 : 1));
  return { mode: 'sections', manuals: manuals.map(manualCard), sections: picked, candidates, tokens,
           reason: `${picked.length} sections from ${manuals.length} manual(s)` };
}

/** "More": stay in the same manual(s), add neighbouring and next-best sections not yet sent. */
export function retrieveMore(question, prev) {
  const sent = new Set(prev.sectionIds || []);
  const manualIds = prev.manualIds || [];
  const budget = config.budget.more;
  const primary = manualIds[0] && parseManual(stmt.manual.get(manualIds[0]));
  if (!primary) return retrieve(question, { budget, exclude: [...sent], qvec: prev.qvec });
  const all = stmt.sectionsOfManual.all(primary.id).filter(s => s.kind !== 'contents');
  const remaining = all.filter(s => !sent.has(s.id));
  const remainingTokens = remaining.reduce((n, s) => n + s.tokens, 0);
  if (remainingTokens <= budget) {
    return { mode: 'rest-of-manual', manuals: [manualCard(primary)], sections: remaining, candidates: [],
             tokens: remainingTokens, reason: 'rest of the manual fits' };
  }
  const sentOrds = all.filter(s => sent.has(s.id)).map(s => s.ord);
  const near = s => Math.min(...sentOrds.map(o => Math.abs(o - s.ord)));
  const r = retrieve(question, { budget, exclude: [...sent], preferManual: primary.id, qvec: prev.qvec });
  const ranked = new Map(r.sections.map((s, i) => [s.id, i]));
  remaining.sort((a, b) => (near(a) - near(b)) || ((ranked.get(a.id) ?? 99) - (ranked.get(b.id) ?? 99)));
  const picked = [];
  let tokens = 0;
  for (const s of remaining) { if (tokens + s.tokens > budget) continue; picked.push(s); tokens += s.tokens; }
  picked.sort((a, b) => a.ord - b.ord);
  return { mode: 'more', manuals: [manualCard(primary)], sections: picked, candidates: [], tokens, reason: 'neighbouring + next-best sections' };
}
