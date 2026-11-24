// Bulk-load a large folder of PDFs (hundreds of manuals) faster than the inbox, which adds them one by one.
//   npm run ingest-bulk                 PDFs from PDF_DIR (default data/pdfs), metadata from data/documents.json (optional)
//   npm run ingest-bulk -- --no-embed   keyword index only (add vectors later with the same command)
// Parses new PDFs in parallel, REBUILDS the index from all parsed files (uploaded manuals are kept), then embeds
// every chunk. Stop the server first. Embedding runs on the CPU: roughly 10 chunks/s on a laptop.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../server/config.js';

const step = (label, script, extra = []) => {
  console.log(`\n== ${label}`);
  const r = spawnSync(config.python, ['-I', path.join(config.ROOT, 'ingest', script), ...extra],
    { stdio: 'inherit', cwd: config.ROOT, env: { ...process.env, PDF_DIR: config.pdfDir } });
  if (r.status !== 0) { console.error(`${script} failed`); process.exit(1); }
};

console.log(`PDFs: ${config.pdfDir}`);
step('parse PDFs', 'parse_manuals.py');
step('build keyword index', 'build_index.py');
if (!process.argv.includes('--no-embed')) step('embed chunks (local model, CPU)', 'embed_index.py');
console.log('\nDone. Start the app with:  npm start');
