// Read-only access to the search index built by ingest/build_index.py.
// The ingest scripts (Python) write to the same file; this connection sees their commits on its next read.
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

if (!fs.existsSync(config.dbPath)) { // no index yet: start empty, manuals can be uploaded or dropped in the inbox
  const r = spawnSync(config.python, ['-I', path.join(config.ROOT, 'ingest', 'add_manual.py'), 'init'], { encoding: 'utf8', windowsHide: true });
  if (!fs.existsSync(config.dbPath)) {
    console.error(`Index not found at ${config.dbPath} and could not create an empty one: ${r.stderr || r.error?.message || ''}`);
    process.exit(1);
  }
}

export const db = new DatabaseSync(config.dbPath, { readOnly: true });

const q = sql => db.prepare(sql);

export const stmt = {
  manual: q('SELECT * FROM manuals WHERE id = ?'),
  manualByFilename: q('SELECT * FROM manuals WHERE filename = ?'),
  section: q('SELECT * FROM sections WHERE id = ?'),
  sectionsOfManual: q('SELECT * FROM sections WHERE manual_id = ? ORDER BY ord'),
  sectionByOrd: q('SELECT * FROM sections WHERE manual_id = ? AND ord = ?'),
  searchManuals: q(`SELECT manual_id, bm25(manuals_fts, 0, 6.0, 3.0, 10.0, 2.0, 1.5, 10.0) AS score
                    FROM manuals_fts WHERE manuals_fts MATCH ? ORDER BY score LIMIT ?`),
  searchChunks: q(`SELECT chunk_id, section_id, manual_id, bm25(chunks_fts, 0, 0, 0, 2.0, 1.0, 6.0) AS score
                   FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`),
  stats: q('SELECT (SELECT count(*) FROM manuals) AS manuals, (SELECT count(*) FROM sections) AS sections, (SELECT count(*) FROM chunks) AS chunks'),
};

export function parseManual(row) {
  if (!row) return null;
  return { ...row, models: JSON.parse(row.models || '[]'), tags: JSON.parse(row.tags || '[]'),
           toc: JSON.parse(row.toc || '[]'), image_pages: JSON.parse(row.image_pages || '[]') };
}
