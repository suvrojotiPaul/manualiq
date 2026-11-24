// Loaded sources: uploaded / inbox manuals (PDF) and databases (.sqlite/.db/.sql), in data/uploads/sources.json.
//
// Two ways in, same pipeline:
//   * upload in the UI   -> POST /upload (raw bytes to uploads/tmp) -> ingestFile()
//   * drop folder        -> data/inbox/manuals/*.pdf, data/inbox/databases/*.{sqlite,db,sql} -> scanInbox()
//                           (on server start and `npm run ingest-inbox`; skipped when the SHA-256 is unchanged)
// Manuals are added to the search index incrementally (parse -> index -> embed only that manual).
// Databases become a sandbox SQLite copy under uploads/db/<name>.sqlite; the original is never queried.
// All ingestion runs one at a time (a queue), because the index has a single writer.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { config, DATA } from './config.js';
import { loadDump } from './sql/dump.js';
import { introspect } from './sql/schema.js';

const REGISTRY = path.join(config.uploadsDir, 'sources.json');
const MANUAL_EXT = new Set(['.pdf']);
const DB_EXT = new Set(['.sqlite', '.sqlite3', '.db']);
const DUMP_EXT = new Set(['.sql']);

export const kindOfFile = name => {
  const ext = path.extname(name).toLowerCase();
  return MANUAL_EXT.has(ext) ? 'manual' : DB_EXT.has(ext) || DUMP_EXT.has(ext) ? 'database' : null;
};

// ---------------------------------------------------------------- registry
// File paths (dbPath, file) are stored relative to data/ so the folder can be copied to another machine or OS.
// Older registries hold absolute paths: if one no longer exists, look for the same file name in the uploads folder.
const PATH_KEYS = { dbPath: () => config.uploadDbDir, file: () => config.uploadPdfDir };
function toAbs(p, key) {
  if (!p) return p;
  if (!path.isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p)) return path.join(DATA, p);
  if (fs.existsSync(p)) return p;
  return path.join(PATH_KEYS[key](), p.split(/[\\/]/).pop());
}
const toRel = p => (p && path.isAbsolute(p) && !path.relative(DATA, p).startsWith('..') ? path.relative(DATA, p).split(path.sep).join('/') : p);
function readRegistry() {
  let list;
  try { list = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return []; }
  for (const e of list) for (const k of Object.keys(PATH_KEYS)) if (e[k]) e[k] = toAbs(e[k], k);
  return list;
}
function writeRegistry(list) {
  const tmp = REGISTRY + '.tmp';
  const out = list.map(e => { const c = { ...e }; for (const k of Object.keys(PATH_KEYS)) if (c[k]) c[k] = toRel(c[k]); return c; });
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
  fs.renameSync(tmp, REGISTRY);
}
function upsert(entry) {
  const list = readRegistry().filter(e => e.id !== entry.id);
  list.push(entry);
  writeRegistry(list);
  changed();
}

export function listSources() { return readRegistry().filter(e => e.status !== 'removed'); }
export function readyDatabases() {
  return readRegistry().filter(e => e.kind === 'database' && e.status === 'ready' && fs.existsSync(e.dbPath));
}

// listeners (catalog cache, vector matrix) are told when sources change
const listeners = new Set();
export function onSourcesChanged(fn) { listeners.add(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch (err) { console.error('[sources]', err); } } }

// ---------------------------------------------------------------- helpers
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const safeStem = name => path.basename(name, path.extname(name)).replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'file';

function uniqueName(stem, taken) {
  let n = stem, k = 2;
  while (taken.has(n.toLowerCase())) n = `${stem}_${k++}`;
  return n;
}

/** Run a Python step; resolves with its last JSON line ({ok, ...}). onLine gets every stdout line (progress). */
function py(exe, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-I', ...args], { cwd: config.ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = null, stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', line => {
      onLine?.(line);
      try { const j = JSON.parse(line); if (j && typeof j === 'object' && 'ok' in j) last = j; } catch {}
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (last && !last.ok) return reject(new Error(last.error));
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').slice(-2).join(' ') || `exit ${code}`));
      resolve(last || {});
    });
  });
}
const script = name => path.join(config.ROOT, 'ingest', name);

/** "4801-5134-HH-Belt-Tensioner.pdf" -> number "4801-5134", title "Belt Tensioner" (best effort; the base set has real metadata). */
function manualMeta(originalName, stem, sha) {
  let base = path.basename(originalName, path.extname(originalName));
  // "Fan20Mounting20Bracket": URL-encoded spaces that lost their %. Only then, so "Galaxy S20" or "2024" stay intact.
  if (!/\s/.test(base) && (base.match(/20(?=[A-Z])/g) || []).length >= 2) base = base.replace(/20/g, ' ');
  base = base.replace(/%20/g, ' ').replace(/[_]+/g, ' ');
  const num = (base.match(/^[A-Za-z]{0,5}-?\d{2,}(?:-\d{2,})?/) || [])[0];
  const title = base.replace(num || '', '').replace(/\b(HH|EN|MAN|REV\s?\d+)\b/gi, ' ').replace(/[-\s]+/g, ' ').trim() || base;
  return { title, doc_number: num || `DOC-${sha.slice(0, 6).toUpperCase()}`, version: '', description: `Uploaded document ${originalName}`,
           models: [], tags: ['Uploaded'], status: 'Uploaded', language: 'English', filename: `${stem}.pdf`, url: '' };
}

// ---------------------------------------------------------------- queue
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- ingestion
/**
 * Ingest a file (copied, never moved). origin: 'upload' | 'inbox'. onProgress({ stage, detail }) for the UI.
 * Returns the registry entry. If a source with the same SHA-256 is already loaded, returns it with duplicate=true.
 */
export function ingestFile(srcPath, { originalName = path.basename(srcPath), origin = 'upload', inboxPath = null, onProgress = () => {} } = {}) {
  return enqueue(async () => {
    const kind = kindOfFile(originalName);
    if (!kind) throw new Error(`unsupported file type: ${originalName} (use .pdf, .sqlite, .db or .sql)`);
    const sha = await sha256File(srcPath);
    const dup = readRegistry().find(e => e.sha256 === sha && e.status === 'ready');
    if (dup) { onProgress({ stage: 'ready', detail: `already loaded as ${dup.name}` }); return { ...dup, duplicate: true }; }
    return kind === 'manual'
      ? ingestManual(srcPath, { originalName, origin, inboxPath, sha, onProgress })
      : ingestDatabase(srcPath, { originalName, origin, inboxPath, sha, onProgress });
  });
}

async function ingestManual(srcPath, { originalName, origin, inboxPath, sha, onProgress }) {
  const { db } = await import('./db.js');
  const taken = new Set(db.prepare('SELECT id FROM manuals').all().map(r => r.id.toLowerCase()));
  for (const e of readRegistry()) if (e.manualId) taken.add(e.manualId.toLowerCase());
  const stem = uniqueName(safeStem(originalName), taken);
  const pdf = path.join(config.uploadPdfDir, `${stem}.pdf`);
  const entry = { id: `m-${sha.slice(0, 12)}`, kind: 'manual', name: originalName, origin, inboxPath, sha256: sha, manualId: stem,
                  file: pdf, status: 'processing', addedAt: new Date().toISOString() };
  upsert(entry);
  try {
    fs.copyFileSync(srcPath, pdf);
    onProgress({ stage: 'parsing', detail: 'reading the PDF' });
    const meta = manualMeta(originalName, stem, sha);
    const parsed = await py(config.python, [script('add_manual.py'), 'parse', pdf, '--meta', JSON.stringify(meta)]);
    entry.pages = parsed.pages;
    onProgress({ stage: 'indexing', detail: `${parsed.pages} pages, ${parsed.sections} sections` });
    const idx = await py(config.python, [script('add_manual.py'), 'index', parsed.parsed]);
    Object.assign(entry, { sections: idx.sections, chunks: idx.chunks, title: meta.title, number: meta.doc_number });
    onProgress({ stage: 'embedding', detail: `${idx.chunks} chunks` });
    try {
      await py(config.embedPython, [script('embed_index.py'), '--manual', stem], {
        onLine: line => { const m = line.match(/^\[(\d+)\/(\d+)\]/); if (m) onProgress({ stage: 'embedding', detail: `${m[1]}/${m[2]} chunks` }); },
      });
      entry.vectors = true;
    } catch (err) { // keyword search still works without vectors
      entry.vectors = false;
      entry.warning = `embedding failed (keyword search only): ${err.message.slice(0, 200)}`;
    }
    entry.status = 'ready';
    upsert(entry);
    onProgress({ stage: 'ready', detail: `${entry.pages} pages` + (entry.warning ? ' (keyword search only)' : '') });
    return entry;
  } catch (err) {
    Object.assign(entry, { status: 'error', error: err.message });
    upsert(entry);
    // leave nothing half-indexed behind
    await py(config.python, [script('add_manual.py'), 'remove', stem]).catch(() => {});
    throw err;
  }
}

/** Copy of a SQLite file, made self-contained (no WAL) so it opens read-only. Throws if it isn't SQLite. */
function copySqlite(src, dest) {
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'SQLite format 3\0') throw new Error('not a SQLite database file');
  for (const f of [dest, dest + '-wal', dest + '-shm', dest + '-journal']) fs.rmSync(f, { force: true });
  fs.copyFileSync(src, dest);
  for (const sfx of ['-wal']) if (fs.existsSync(src + sfx)) fs.copyFileSync(src + sfx, dest + sfx);
  const db = new DatabaseSync(dest);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    const ok = db.prepare('PRAGMA quick_check').get();
    if (ok && Object.values(ok)[0] !== 'ok') throw new Error(`database check failed: ${Object.values(ok)[0]}`);
  } finally { db.close(); }
}

async function ingestDatabase(srcPath, { originalName, origin, inboxPath, sha, onProgress }) {
  const taken = new Set(readRegistry().filter(e => e.kind === 'database' && e.dbName).map(e => e.dbName.toLowerCase()));
  const dbName = uniqueName(safeStem(originalName).replace(/[.-]/g, '_'), taken);
  const dest = path.join(config.uploadDbDir, `${dbName}.sqlite`);
  const entry = { id: `d-${sha.slice(0, 12)}`, kind: 'database', name: originalName, origin, inboxPath, sha256: sha, dbName,
                  dbPath: dest, status: 'processing', addedAt: new Date().toISOString() };
  upsert(entry);
  try {
    const ext = path.extname(originalName).toLowerCase();
    if (DUMP_EXT.has(ext)) {
      onProgress({ stage: 'loading', detail: 'translating the SQL dump' });
      const buf = fs.readFileSync(srcPath);
      // SSMS saves scripts as UTF-16 ("Unicode") by default: detect it from the byte-order mark
      const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le')
        : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le') : buf.toString('utf8');
      const r = loadDump(text, dest);
      Object.assign(entry, { dialect: r.dialect, skipped: r.skipped, notes: r.notes });
    } else {
      onProgress({ stage: 'loading', detail: 'copying the database' });
      copySqlite(srcPath, dest);
      entry.dialect = 'sqlite file';
    }
    const info = introspect(dest, dbName);
    entry.tables = info.tables.filter(t => t.kind === 'table').map(t => ({ name: t.name, rows: t.rows }));
    entry.views = info.tables.filter(t => t.kind === 'view').map(t => t.name);
    if (!entry.tables.length) throw new Error('no tables could be loaded' + (entry.skipped?.length ? ` (${entry.skipped.length} statements skipped)` : ''));
    entry.status = 'ready';
    upsert(entry);
    onProgress({ stage: 'ready', detail: `${entry.tables.length} tables` });
    return entry;
  } catch (err) {
    for (const f of [dest, dest + '-journal', dest + '-wal', dest + '-shm']) fs.rmSync(f, { force: true }); // no empty sandbox left behind
    Object.assign(entry, { status: 'error', error: err.message });
    upsert(entry);
    throw err;
  }
}

/**
 * Remove a source (registry entry + its index rows or sandbox file). Base-index manuals are not sources.
 * A source that came from the inbox has its file moved to data/inbox/removed/, so the inbox always shows what is
 * loaded (moveInboxFile=false when a changed inbox file is being re-ingested in place).
 */
export function removeSource(id, { moveInboxFile = true } = {}) {
  return enqueue(async () => {
    const e = readRegistry().find(x => x.id === id && x.status !== 'removed');
    if (!e) throw new Error('unknown source');
    if (e.kind === 'manual') {
      if (e.manualId) await py(config.python, [script('add_manual.py'), 'remove', e.manualId]);
      if (e.file) fs.rmSync(e.file, { force: true });
      fs.rmSync(path.join(config.pagesDir, String(e.manualId || '').replace(/[^\w.-]/g, '_')), { recursive: true, force: true });
    } else if (e.dbPath) {
      for (const f of [e.dbPath, e.dbPath + '-journal']) fs.rmSync(f, { force: true });
    }
    const rest = readRegistry().filter(x => x.id !== id);
    if (e.inboxPath && moveInboxFile) {
      const src = path.join(config.inboxDir, e.inboxPath);
      let moved = !fs.existsSync(src);
      if (!moved) {
        try {
          const destDir = path.join(config.inboxDir, 'removed', path.dirname(e.inboxPath));
          fs.mkdirSync(destDir, { recursive: true });
          let dest = path.join(destDir, path.basename(src));
          if (fs.existsSync(dest)) dest = dest.replace(/(\.[^.]+)$/, `-${Date.now()}$1`);
          fs.renameSync(src, dest);
          moved = true;
        } catch { /* fall back to remembering the removal below */ }
      }
      // if the file could not be moved it would come straight back on the next scan: remember it was removed
      // (by content hash), so only a changed file is ingested again
      if (!moved) rest.push({ id: e.id, kind: e.kind, name: e.name, origin: 'inbox', inboxPath: e.inboxPath, sha256: e.sha256, status: 'removed', removedAt: new Date().toISOString() });
    }
    writeRegistry(rest);
    changed();
    return e;
  });
}

// ---------------------------------------------------------------- inbox
/**
 * Ingest new or changed files in data/inbox/{manuals,databases}. Unchanged files (same SHA-256 as when they were
 * ingested) are skipped; a changed file replaces the source it produced before. Removing a source in the UI moves its
 * file to data/inbox/removed/. Deleting a file from the inbox by hand does not unload it (remove it in the UI).
 */
export async function scanInbox({ onProgress = () => {} } = {}) {
  const results = [];
  for (const [sub, kind] of [['manuals', 'manual'], ['databases', 'database']]) {
    const dir = path.join(config.inboxDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile() || kindOfFile(f) !== kind) continue;
      const rel = `${sub}/${f}`;
      try {
        const sha = await sha256File(full);
        const prev = readRegistry().find(e => e.inboxPath === rel);
        if (prev && prev.sha256 === sha && prev.status === 'ready') { results.push({ file: rel, action: 'unchanged' }); continue; }
        if (prev && prev.sha256 === sha && prev.status === 'removed') { results.push({ file: rel, action: 'removed earlier' }); continue; }
        if (prev?.status === 'removed') writeRegistry(readRegistry().filter(x => !(x.inboxPath === rel && x.status === 'removed')));
        else if (prev) await removeSource(prev.id, { moveInboxFile: false });
        onProgress({ file: rel, stage: 'start', detail: prev ? 'changed, re-ingesting' : 'new file' });
        const e = await ingestFile(full, { originalName: f, origin: 'inbox', inboxPath: rel, onProgress: p => onProgress({ file: rel, ...p }) });
        if (e.duplicate && !e.inboxPath) { // same content already uploaded: adopt it so the next scan skips the file
          upsert({ ...e, duplicate: undefined, inboxPath: rel });
        }
        results.push({ file: rel, action: e.duplicate ? 'duplicate' : prev ? 'replaced' : 'added', entry: e });
      } catch (err) {
        results.push({ file: rel, action: 'error', error: err.message });
        onProgress({ file: rel, stage: 'error', detail: err.message });
      }
    }
  }
  return results;
}
