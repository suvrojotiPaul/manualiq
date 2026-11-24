// Dense side of hybrid search: question -> vector (Python sidecar), vector -> nearest chunks (brute force over SQLite blobs).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

function readMeta() {
  const hasVec = !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_meta'").get();
  return hasVec ? db.prepare('SELECT model, dim FROM vec_meta').get() || null : null;
}
let meta = readMeta();
const vectorsOn = () => !!meta && process.env.HYBRID !== '0';

// ---- all chunk vectors in one Float32Array (22k x 768 floats ~ 70 MB)
let ids = null, manualOf = null, sectionOf = null, mat = null, dim = 0;

/** After a manual was added or removed: re-read vector metadata and reload the matrix on next search. */
export function reloadVectors() { mat = null; meta = readMeta(); }

function load() {
  if (mat) return;
  const rows = db.prepare('SELECT chunk_id, manual_id, section_id, vec FROM chunk_vec ORDER BY chunk_id').all();
  dim = meta.dim;
  mat = new Float32Array(rows.length * dim);
  ids = new Int32Array(rows.length); manualOf = new Array(rows.length); sectionOf = new Array(rows.length);
  rows.forEach((r, i) => {
    mat.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim), i * dim);
    ids[i] = r.chunk_id; manualOf[i] = r.manual_id; sectionOf[i] = r.section_id;
  });
}

// ---- query embedder process
let proc = null, ready = null, nextId = 1;
const pending = new Map();
function start() {
  if (proc) return ready;
  const py = process.env.EMBED_PYTHON || config.python;
  proc = spawn(py, ['-I', path.join(config.ROOT, 'ingest', 'embed_server.py'), meta.model], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  ready = new Promise((resolve, reject) => {
    proc.on('error', reject);
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) return resolve();
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(Float32Array.from(msg.v));
    });
  });
  proc.on('exit', () => { proc = null; for (const p of pending.values()) p.reject(new Error('embedder exited')); pending.clear(); });
  proc.unref?.();
  return ready;
}

export async function embedQuery(text) {
  if (!vectorsOn()) return null;
  await start();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, text }) + '\n');
  });
}

/** Top-k chunks by cosine similarity: [{ chunk_id, section_id, manual_id, score }]. manualIds limits the search. */
export function vectorSearch(qvec, k = 300, manualIds = null) {
  if (!qvec || !meta) return [];
  load();
  const n = ids.length, scores = [];
  for (let i = 0; i < n; i++) {
    if (manualIds && !manualIds.has(manualOf[i])) continue;
    let s = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) s += mat[off + j] * qvec[j];
    scores.push([i, s]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return scores.slice(0, k).map(([i, s]) => ({ chunk_id: ids[i], section_id: sectionOf[i], manual_id: manualOf[i], score: s }));
}

export function stopEmbedder() { if (proc) { proc.stdin.end(); proc.kill(); proc = null; } }
