// What is loaded right now, cached until a source is added or removed:
// databases (introspected schema, vocabulary for the router, sandbox paths) and manual counts/titles.
import { db } from './db.js';
import { reloadVectors } from './embed.js';
import { readyDatabases, onSourcesChanged } from './sources.js';
import { introspect, vocabulary } from './sql/schema.js';

let cache = null;
onSourcesChanged(() => { cache = null; reloadVectors(); });

export function getCatalog() {
  if (cache) return cache;
  const dbs = [], dbPaths = {}, labels = {};
  for (const e of readyDatabases()) {
    try {
      dbs.push(introspect(e.dbPath, e.dbName));
      dbPaths[e.dbName] = e.dbPath;
      labels[e.dbName] = e.name;
    } catch (err) { console.error(`[catalog] ${e.dbName}: ${err.message}`); }
  }
  const titles = db.prepare('SELECT doc_number, title FROM manuals ORDER BY title').all().map(r => `${r.title} (${r.doc_number})`);
  cache = { dbs, dbPaths, labels, vocab: vocabulary(dbs), manuals: { count: titles.length, titles } };
  return cache;
}

export function invalidateCatalog() { cache = null; }
