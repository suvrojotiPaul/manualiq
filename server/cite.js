// Citations: find manual references in answers and turn them into page links / page previews.
// Document numbers come in many shapes (AB-2566, 123-00499 - REV03, 4801-5143, IM-010-01, DOC-3F2A1B),
// and the model writes them in many ways: (123-00499 p.1), 123-00499 REV03, PDF page 1, AB 2566 pp. 3-4.
// So the pattern is built from the manuals actually sent to the model, not from a fixed format.
import { escapeHtml } from './markdown.js';

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const baseNumber = doc_number => String(doc_number || '').trim().split(/\s+-\s+|\s+/)[0];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_RANGE = 4; // pages expanded from a range like "pp. 3-9"

function buildMatcher(manuals) {
  const byBase = new Map();
  for (const m of manuals) {
    const base = baseNumber(m.doc_number);
    if (norm(base).length < 4) continue;
    const k = norm(base);
    if (!byBase.has(k)) byBase.set(k, { base, list: [] });
    if (!byBase.get(k).list.some(x => x.id === m.id)) byBase.get(k).list.push(m);
  }
  if (!byBase.size) return null;
  const alts = [...byBase.values()].map(v => v.base).sort((a, b) => b.length - a.length)
    .map(b => escRe(b).replace(/\\?-/g, '[-\\s]?'));
  const re = new RegExp(
    `\\b(${alts.join('|')})(?![\\w-]*\\d)` +                                                  // the number (not a longer one)
    `(\\s*[-–]?\\s*(?:REV|RV|Rev\\.?|Ver(?:sion)?\\.?|V)\\s*(\\d[\\d.\\/-]*\\d|\\d))?` +       // optional revision
    `(?:(,?\\s*(?:on\\s+)?(?:PDF\\s+)?(?:pages?|pp?\\.|pg\\.?)\\s*)(\\d+)(?:(\\s*(?:[-–]|to)\\s*)(\\d+))?)?`, // optional page(s)
    'gi');
  const resolve = (num, rev) => {
    const entry = byBase.get(norm(num));
    if (!entry) return null;
    if (rev) return entry.list.find(m => norm(m.doc_number).endsWith(norm(rev))) || entry.list[0];
    return entry.list[0];
  };
  return { re, resolve };
}

const validPage = (m, p) => Number.isInteger(p) && p >= 1 && (!m.pages || p <= m.pages);

/** data-pg value read by the page viewer in index.html: id|page|total pages|pdf filename|label */
export function pageRef(m, page) {
  return [m.id, page, m.pages || '', m.filename || '', baseNumber(m.doc_number)].join('|');
}
export const pdfHref = (m, page) => `/pdf/${encodeURIComponent(m.filename || '')}${page ? `#page=${page}` : ''}`;
export const pageImgUrl = (m, page, thumb) => `/page/${encodeURIComponent(m.id)}/${page}${thumb ? '.thumb' : ''}.webp`;

/** Returns html => html that links citations. Used while rendering Markdown (input is already escaped). */
export function citeLinker(manuals) {
  const mt = buildMatcher(manuals);
  if (!mt) return html => html;
  return html => html.replace(mt.re, (all, num, _revPart, rev, _pm, page) => {
    const m = mt.resolve(num, rev);
    if (!m) return all;
    const p = page && validPage(m, Number(page)) ? Number(page) : null;
    const pg = p ? ` data-pg="${escapeHtml(pageRef(m, p))}"` : '';
    return `<a class="cite" href="${pdfHref(m, p)}" target="_blank" rel="noopener"${pg}>${all}</a>`;
  });
}

/** Cited pages in a finished answer, in order of first mention: [{ manual, page }]. */
export function findCitations(text, manuals, { max = 8 } = {}) {
  const mt = buildMatcher(manuals);
  if (!mt) return [];
  const out = [], seen = new Set();
  for (const [, num, , rev, , page, , end] of text.matchAll(mt.re)) {
    const m = mt.resolve(num, rev);
    if (!m || !page) continue;
    const a = Number(page), b = end ? Math.min(Number(end), a + MAX_RANGE - 1) : a;
    for (let p = a; p <= b; p++) {
      const k = `${m.id}#${p}`;
      if (!validPage(m, p) || seen.has(k)) continue;
      seen.add(k); out.push({ manual: m, page: p });
      if (out.length >= max) return out;
    }
  }
  return out;
}
