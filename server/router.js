// Decide where a question goes: 'manuals', 'database', 'both' or 'clarify'.
//   1. only one kind of source loaded  -> that one, no model call
//   2. cheap signals (scores below)     -> decide when they clearly point one way (or clearly both ways)
//   3. otherwise a short haiku call with the source catalog
import { askModel } from './claude.js';
import { config } from './config.js';

// --- database signals: counting / listing / filtering over records
const DB_PATTERNS = [
  /\bhow many\b/, /\bnumber of\b/, /\bcount(s|ed)?\b/, /\btotal\b/, /\bsum\b/, /\baverage\b|\bavg\b|\bmedian\b/,
  /\b(most|least|top \d+|highest|lowest|biggest|fewest)\b/, /\bper (customer|site|device|model|month|week|day|region|technician|state|status)\b/,
  /\bby (customer|site|device|model|month|week|day|region|technician|state|status|priority)\b/,
  /\b(list|show|give me|find) (me )?(all|every|the|each|which)\b/, /\bwhich (customers?|sites?|devices?|tickets?|technicians?|farms?|regions?)\b/,
  /\bwho (has|have|had|reported|opened|closed|owns?)\b/, /\b(this|last|past|previous) (month|week|year|quarter)\b/, /\blast \d+ (days|weeks|months)\b/,
  /\b(since|between|before|after) (\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/, /\b(percentage|percent|ratio|trend|breakdown)\b/,
  /\b(open|closed|unresolved|pending|in progress) tickets?\b/, /\b(records?|rows?|database|table|sql|query|data)\b/,
];
// --- manual signals: how-to, meaning, procedure, specs
const MANUAL_PATTERNS = [
  /\bhow (do|to|can|should|would) (i|you|we|one)?\b/, /\b(install|installation|assembl\w*|mount\w*)\b/, /\bwir(e|es|ing)\b/,
  /\b(replace|replacing|adjust\w*|calibrat\w*|configur\w*|set ?up|setting|settings|parameter)\b/, /\b(procedure|steps?|instructions?)\b/,
  /\b(troubleshoot\w*|fix|repair|diagnos\w*)\b/, /\bwhat (does|do|is|are) .{1,60}\b(mean|means|meaning|for|do)\b/, /\bmeaning of\b/,
  /\b(maintenance|clean\w*|lubricat\w*|torque|dimensions?|specs?|specifications?|diagram|schematic|terminal|menu|button|press|display)\b/,
  /\b(manual|manuals|documentation|page|datasheet|guide)\b/, /\b(safety|warning|caution)\b/, /\bwhy (does|is|do|would)\b/, /\bwhat causes\b/,
];

const words = s => s.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').split(/\s+/).filter(Boolean);
const singular = w => w.replace(/(ies)$/, 'y').replace(/(ses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, '');
const GENERIC_COLS = new Set(['id', 'name', 'type', 'date', 'status', 'notes', 'note', 'created', 'updated', 'description', 'title', 'value', 'code', 'model', 'number']);

/**
 * Score a question. vocab = schema.vocabulary(dbs) (tables/columns/values -> db name).
 * Returns { db, manual, signals: [..], database } where database is the best-matching db name (or null).
 */
export function heuristics(question, vocab = { tables: new Map(), columns: new Map(), values: new Map() }) {
  const q = question.toLowerCase();
  const signals = [];
  let db = 0, manual = 0;
  const dbVotes = new Map();
  const vote = (name, w) => name && dbVotes.set(name, (dbVotes.get(name) || 0) + w);

  for (const re of DB_PATTERNS) { const m = q.match(re); if (m) { db += 2; signals.push(`db:"${m[0]}"`); } }
  for (const re of MANUAL_PATTERNS) {
    const m = q.match(re);
    // "what does X mean" is a strong manual signal on its own
    if (m) { manual += /\bmean(s|ing)?\b/.test(m[0]) ? 3 : 2; signals.push(`manual:"${m[0].slice(0, 40)}"`); }
  }

  const ws = words(q), wsSing = ws.map(singular);
  const bag = new Set([...ws, ...wsSing]);
  const phrase = ' ' + ws.join(' ') + ' ';
  for (const [t, dbn] of vocab.tables) {
    const parts = t.split('_');
    const hit = parts.length > 1 ? phrase.includes(` ${parts.join(' ')} `) || phrase.includes(` ${parts.map(singular).join(' ')} `) || bag.has(t)
      : bag.has(t) || bag.has(singular(t));
    // a multi-word table name also matches on its last word ("tickets" for service_tickets)
    const tail = parts.length > 1 && (bag.has(parts.at(-1)) || bag.has(singular(parts.at(-1))));
    if (hit || tail) { db += hit ? 3 : 2; vote(dbn, 3); signals.push(`table:${t}`); }
  }
  for (const [c, dbn] of vocab.columns) {
    if (GENERIC_COLS.has(c) || c.length < 4 || /_id$/.test(c)) continue;
    const parts = c.split('_').filter(Boolean);
    const hit = parts.length > 1 ? phrase.includes(` ${parts.join(' ')} `) : bag.has(c);
    if (hit) { db += 1.5; vote(dbn, 1.5); signals.push(`column:${c}`); }
  }
  // values (a model name, an alarm name) are often in the manuals too: they only nudge, at most +1 in total
  let valueScore = 0;
  for (const [v, dbn] of vocab.values) {
    if (v.length >= 4 && q.includes(v)) { valueScore += 0.5; vote(dbn, 1); signals.push(`value:${v}`); }
  }
  db += Math.min(1, valueScore);
  const database = [...dbVotes].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { db, manual, signals, database };
}

/** Thresholds: a side "clearly applies" at >= 3, "barely" below 1.5. Returns a route or null (unclear). */
export function decideFromScores({ db, manual }) {
  if (db >= 3 && manual >= 3) return 'both';
  if (db >= 3 && manual < 1.5) return 'database';
  if (manual >= 3 && db < 1.5) return 'manuals';
  if (manual >= 2 && db === 0) return 'manuals';
  if (db >= 2 && manual === 0) return 'database';
  return null;
}

const ROUTER_SYSTEM = `You route questions in a support app to the right source. Sources:
- "manuals": equipment manuals (installation, wiring, operation, settings, alarms and what they mean, troubleshooting, parts).
- "database": SQL databases with operational records (listed with their tables and columns). Use for counting, listing, filtering, totals, who/which/when questions about records.
- "both": the question needs facts from a manual AND records from a database (e.g. "what does this alarm mean and which customers reported it?").
- "clarify": genuinely impossible to tell what is wanted; then ask ONE short question naming the options.
Reply with JSON only: {"route":"manuals|database|both|clarify","database":"<database name or null>","clarify":"<question, only for clarify>","reason":"<few words>"}`;

function sourceSummary({ manuals, dbs }) {
  let s = `<manuals count="${manuals.count}">${manuals.titles.slice(0, 40).join('; ')}</manuals>\n`;
  for (const d of dbs) {
    s += `<database name="${d.name}">` + d.tables.map(t => `${t.name}(${t.columns.map(c => c.name).join(', ')})`).join('; ') + '</database>\n';
  }
  return s;
}

/** Pull the first JSON object out of a model reply. */
export function parseJsonReply(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in model reply');
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * routeQuestion(question, { manuals: {count, titles}, dbs: [introspected], vocab, prevRoute, ask })
 *  -> { route, database, reason, via: 'only-source'|'heuristic'|'llm'|'fallback', clarify?, signals }
 */
export async function routeQuestion(question, { manuals, dbs, vocab, prevRoute = null, ask = askModel } = {}) {
  const haveManuals = manuals.count > 0, haveDbs = dbs.length > 0;
  const firstDb = dbs[0]?.name || null;
  if (!haveDbs) return { route: 'manuals', database: null, reason: 'no databases loaded', via: 'only-source', signals: [] };
  const h = heuristics(question, vocab);
  if (!haveManuals) return { route: 'database', database: h.database || firstDb, reason: 'no manuals loaded', via: 'only-source', signals: h.signals };
  const decided = decideFromScores(h);
  if (decided) return { route: decided, database: decided === 'manuals' ? null : h.database || firstDb, reason: `signals db=${h.db} manual=${h.manual}`, via: 'heuristic', signals: h.signals };

  const prompt = `${sourceSummary({ manuals, dbs })}\n${prevRoute ? `<previous_turn_route>${prevRoute}</previous_turn_route>\n` : ''}<question>${question}</question>`;
  try {
    const r = await ask(prompt, { system: ROUTER_SYSTEM, model: config.routerModel });
    const j = parseJsonReply(r.text);
    const route = ['manuals', 'database', 'both', 'clarify'].includes(j.route) ? j.route : 'manuals';
    const database = dbs.some(d => d.name === j.database) ? j.database : (route === 'manuals' || route === 'clarify' ? null : h.database || firstDb);
    return { route, database, reason: j.reason || '', clarify: route === 'clarify' ? (j.clarify || 'Do you want the answer from the manuals or from the database?') : undefined,
             via: 'llm', signals: h.signals, costUsd: r.costUsd };
  } catch (err) {
    console.error('[router]', err.message);
    const route = prevRoute && prevRoute !== 'clarify' ? prevRoute : 'manuals';
    return { route, database: route === 'manuals' ? null : h.database || firstDb, reason: `router call failed: ${err.message}`, via: 'fallback', signals: h.signals };
  }
}
