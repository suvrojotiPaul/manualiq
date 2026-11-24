// HTTP side of sources: raw-body upload, ingest with SSE progress, the sources panel, removal, inbox scan on start.
//
// Upload flow (web/index.html): the browser POSTs each file's bytes to /upload?name=..&cid=.. (XHR, so it can show
// upload %), then fires a window event that makes Datastar POST /ingest?cids=a,b; that request streams the
// parsing -> indexing -> embedding -> ready progress into the panel and re-renders the source list.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { escapeHtml } from './markdown.js';
import { openSSE, readJson } from './sse.js';
import { ingestFile, kindOfFile, listSources, removeSource, scanInbox } from './sources.js';

const TMP = path.join(config.uploadsDir, 'tmp');
const pending = new Map(); // cid -> { file, name }
const CID_RE = /^[a-z0-9]{6,24}$/;

export async function handleUpload(req, res, url) {
  const name = path.basename(String(url.searchParams.get('name') || ''));
  const cid = String(url.searchParams.get('cid') || '');
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
  if (!CID_RE.test(cid)) return fail(400, 'bad upload id');
  if (!kindOfFile(name)) { req.resume(); return fail(415, 'Only .pdf, .sqlite, .db and .sql files can be added.'); }
  const len = Number(req.headers['content-length'] || 0);
  if (len > config.maxUploadBytes) { req.resume(); return fail(413, `File is larger than ${config.maxUploadBytes / 1048576} MB.`); }
  const file = path.join(TMP, `${cid}${path.extname(name).toLowerCase()}`);
  const out = fs.createWriteStream(file);
  let size = 0, aborted = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > config.maxUploadBytes && !aborted) { aborted = true; req.unpipe(out); out.destroy(); fs.rmSync(file, { force: true }); fail(413, 'File too large.'); req.destroy(); }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    pending.set(cid, { file, name });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cid, size }));
  });
  out.on('error', err => { if (!aborted) fail(500, err.message); });
}

const STAGE_TEXT = { parsing: 'Parsing', indexing: 'Indexing', embedding: 'Embedding', loading: 'Loading', ready: 'Ready', error: 'Error' };
function progressHtml(cid, name, stage, detail = '') {
  const cls = stage === 'ready' ? 'ok' : stage === 'error' ? 'err' : 'busy';
  return `<div class="upitem ${cls}" id="up-${cid}"><span class="upname">${escapeHtml(name)}</span>` +
    `<span class="upstage">${escapeHtml(STAGE_TEXT[stage] || stage)}${detail ? ` · ${escapeHtml(detail)}` : ''}</span></div>`;
}

export async function handleIngest(req, res, url) {
  await readJson(req);
  const sse = openSSE(res);
  const cids = String(url.searchParams.get('cids') || '').split(',').filter(c => CID_RE.test(c));
  for (const cid of cids) {
    const p = pending.get(cid);
    if (!p) { sse.patchElements(progressHtml(cid, 'upload', 'error', 'upload not found, try again')); continue; }
    pending.delete(cid);
    sse.patchElements(progressHtml(cid, p.name, 'loading', 'queued'));
    try {
      const e = await ingestFile(p.file, { originalName: p.name, origin: 'upload', onProgress: ({ stage, detail }) => sse.patchElements(progressHtml(cid, p.name, stage, detail)) });
      if (e.kind === 'database' && !e.duplicate) {
        const skipped = e.skipped?.length ? `, ${e.skipped.length} statements skipped` : '';
        sse.patchElements(progressHtml(cid, p.name, 'ready', `${e.tables.length} tables, ${e.tables.reduce((n, t) => n + t.rows, 0)} rows${skipped}`));
      }
    } catch (err) {
      sse.patchElements(progressHtml(cid, p.name, 'error', err.message));
    } finally {
      fs.rmSync(p.file, { force: true });
    }
    sse.patchElements(sourcesHtml());
  }
  sse.close();
}

/** The list of loaded sources (manuals in the index, uploaded/inbox files, databases with their tables). */
export function sourcesHtml() {
  const list = listSources();
  const total = db.prepare('SELECT count(*) AS n FROM manuals').get().n;
  const manuals = list.filter(e => e.kind === 'manual'), dbs = list.filter(e => e.kind === 'database');
  const base = total - manuals.filter(e => e.status === 'ready').length;
  const rm = e => `<button class="icon rm" title="Remove ${escapeHtml(e.name)}" data-attr:disabled="$busy" ` +
    `data-on:click="confirm('Remove ${escapeHtml(e.name.replace(/['\\]/g, ''))}?') && @post('/sources/remove?id=${encodeURIComponent(e.id)}')">✕</button>`;
  const state = e => (e.status === 'ready' ? '' : e.status === 'error' ? ` <span class="err">error: ${escapeHtml(e.error || '')}</span>` : ' <span class="muted">processing…</span>');
  const origin = e => `<span class="pill">${e.origin === 'inbox' ? 'inbox' : 'upload'}</span>`;
  const mItems = manuals.map(e => `<li>${rm(e)}<span class="sname">${escapeHtml(e.name)}</span> ${origin(e)}` +
    ` <span class="muted">${e.pages ? `${e.pages} pages` : ''}${e.number ? ` · cite as ${escapeHtml(e.number)}` : ''}${e.warning ? ' · keyword search only' : ''}</span>${state(e)}</li>`).join('');
  const dItems = dbs.map(e => {
    const tables = (e.tables || []).map(t => `${escapeHtml(t.name)} <span class="muted">(${t.rows})</span>`).join(', ');
    const skipped = e.skipped?.length
      ? `<details class="skipped"><summary>${e.skipped.length} statement(s) skipped</summary><ul>` +
        e.skipped.slice(0, 200).map(s => `<li><code>${escapeHtml(s.sql.slice(0, 120))}</code> <span class="muted">${escapeHtml(s.reason)}</span></li>`).join('') + '</ul></details>' : '';
    const notes = e.notes?.length ? `<div class="muted small">${escapeHtml(e.notes.slice(0, 5).join('; '))}</div>` : '';
    return `<li>${rm(e)}<span class="sname">${escapeHtml(e.name)}</span> ${origin(e)} <span class="muted">${escapeHtml(e.dialect || '')}${e.views?.length ? ` · views: ${escapeHtml(e.views.join(', '))}` : ''}</span>${state(e)}` +
      (tables ? `<div class="tables">${tables}</div>` : '') + notes + skipped + '</li>';
  }).join('');
  return `<div id="sources"><div class="src-group"><h3>Manuals <span class="muted">${total} in the index${base > 0 && manuals.length ? ` (${base} built in)` : ''}</span></h3>` +
    (mItems ? `<ul class="srclist">${mItems}</ul>` : '<p class="muted small">Only the built-in manuals. Add PDFs above.</p>') + '</div>' +
    `<div class="src-group"><h3>Databases <span class="muted">${dbs.filter(e => e.status === 'ready').length}</span></h3>` +
    (dItems ? `<ul class="srclist">${dItems}</ul>` : '<p class="muted small">None yet. Add a .sqlite, .db or .sql file to ask questions about its data.</p>') + '</div></div>';
}

export async function handleSources(req, res) {
  if (req.method === 'POST') await readJson(req);
  const sse = openSSE(res);
  sse.patchElements(sourcesHtml());
  sse.patchSignals({ nsources: listSources().filter(e => e.status === 'ready').length });
  sse.close();
}

export async function handleRemoveSource(req, res, url) {
  await readJson(req);
  const sse = openSSE(res);
  try { await removeSource(String(url.searchParams.get('id') || '')); }
  catch (err) { sse.patchElements(`<div id="uperr" class="err small">Could not remove: ${escapeHtml(err.message)}</div>`); }
  sse.patchElements(sourcesHtml());
  sse.patchSignals({ nsources: listSources().filter(e => e.status === 'ready').length });
  sse.close();
}

export function ingestInboxOnStart() {
  scanInbox({ onProgress: p => console.log(`[inbox] ${p.file}: ${p.stage}${p.detail ? ` (${p.detail})` : ''}`) })
    .then(r => { const n = r.filter(x => x.action !== 'unchanged').length; if (n) console.log(`[inbox] ${n} file(s) processed`, r.map(x => `${x.file}: ${x.action}${x.error ? ` ${x.error}` : ''}`)); })
    .catch(err => console.error('[inbox]', err));
}
