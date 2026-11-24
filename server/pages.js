// Page images: render a PDF page to WebP on first request (Python + pypdfium2), cache under data/pages.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, pdfPath } from './config.js';

const SCRIPT = path.join(config.ROOT, 'ingest', 'render_page.py');
const MAX_PARALLEL = 2;
const inflight = new Map();   // "<manual>/<n>" -> Promise
const queue = [];
let running = 0;

const dirOf = manual => path.join(config.pagesDir, manual.id.replace(/[^\w.-]/g, '_'));

function runQueued(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const { job, resolve, reject } = queue.shift();
    running++;
    job().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

function render(pdf, n, full, thumb) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ['-I', SCRIPT, pdf, String(n), full, thumb], { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`render failed (${code}): ${err.trim().split('\n').pop() || 'no output'}`));
    });
  });
}

/** Path to the cached WebP of page n (1-based) of a manual row; renders it if needed. */
export async function pageImage(manual, n, { thumb = false } = {}) {
  const dir = dirOf(manual);
  const full = path.join(dir, `${n}.webp`), small = path.join(dir, `${n}.thumb.webp`);
  const want = thumb ? small : full;
  if (fs.existsSync(want)) return want;
  const key = `${manual.id}/${n}`;
  if (!inflight.has(key)) {
    fs.mkdirSync(dir, { recursive: true });
    const p = runQueued(() => render(pdfPath(manual.filename), n, full, small))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  await inflight.get(key);
  return want;
}
