// Schema introspection of the sandbox databases -> a compact catalog for the SQL prompt and the router.
//   introspect(dbPath, name) -> { name, tables: [{ name, kind, rows, columns: [{ name, type, pk, notnull, values? }], fks, sample }] }
//   catalogText(dbs)         -> text block for prompts
// Short text columns with few distinct values (status, region, model...) list those values: it is what lets the
// model write WHERE status = 'in_progress' instead of guessing 'In Progress'.
import { DatabaseSync } from 'node:sqlite';

const qid = s => `"${String(s).replace(/"/g, '""')}"`;
const SAMPLE_ROWS = 3, MAX_DISTINCT = 12, MAX_VALUE_CHARS = 60;

const short = v => {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  const s = String(v);
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS - 1) + '…' : s;
};

export function introspect(dbPath, name) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const objs = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const tables = [];
    for (const o of objs) {
      const t = { name: o.name, kind: o.type, rows: null, columns: [], fks: [], sample: [] };
      try {
        t.columns = db.prepare('SELECT name, type, pk, "notnull" AS nn FROM pragma_table_info(?)').all(o.name)
          .map(c => ({ name: c.name, type: c.type || '', pk: c.pk > 0, notnull: !!c.nn }));
        t.fks = db.prepare('SELECT "from" AS col, "table" AS ref, "to" AS refcol FROM pragma_foreign_key_list(?)').all(o.name)
          .map(f => ({ col: f.col, ref: f.ref, refcol: f.refcol }));
        t.rows = Number(db.prepare(`SELECT count(*) AS n FROM ${qid(o.name)}`).get().n);
        t.sample = db.prepare(`SELECT * FROM ${qid(o.name)} LIMIT ${SAMPLE_ROWS}`).all().map(r => Object.values(r).map(short));
        if (t.rows <= 200000) {
          for (const c of t.columns) {
            if (c.pk || /INT|REAL|NUM|FLOA|DOUB|DEC|BLOB/i.test(c.type)) continue;
            const n = Number(db.prepare(`SELECT count(DISTINCT ${qid(c.name)}) AS n FROM ${qid(o.name)}`).get().n);
            if (n > 0 && n <= MAX_DISTINCT && n < t.rows) {
              const vals = db.prepare(`SELECT DISTINCT ${qid(c.name)} AS v FROM ${qid(o.name)} WHERE ${qid(c.name)} IS NOT NULL ORDER BY 1 LIMIT ${MAX_DISTINCT}`).all().map(r => String(r.v));
              if (vals.every(v => v.length <= 40)) c.values = vals;
            }
          }
        }
      } catch (err) {
        t.error = err.message;
      }
      tables.push(t);
    }
    return { name, tables };
  } finally {
    db.close();
  }
}

export function catalogText(dbs) {
  let out = '';
  for (const d of dbs) {
    out += `<database name="${d.name}">\n`;
    for (const t of d.tables) {
      out += `${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${t.name} (${t.rows ?? '?'} rows)\n`;
      for (const c of t.columns) {
        out += `  ${c.name} ${c.type || 'ANY'}${c.pk ? ' PRIMARY KEY' : ''}${c.notnull && !c.pk ? ' NOT NULL' : ''}` +
          (c.values ? `  -- values: ${c.values.map(v => `'${v}'`).join(', ')}` : '') + '\n';
      }
      for (const f of t.fks) out += `  FOREIGN KEY ${f.col} -> ${f.ref}.${f.refcol || '?'}\n`;
      if (t.sample.length) {
        out += `  sample rows (${t.columns.map(c => c.name).join(' | ')}):\n`;
        for (const r of t.sample) out += `    ${r.map(v => (v === null ? 'NULL' : v)).join(' | ')}\n`;
      }
    }
    out += '</database>\n';
  }
  return out;
}

/** Words the router matches against: table names, column names (split on _), short distinct values. */
export function vocabulary(dbs) {
  const tables = new Map(), columns = new Map(), values = new Map();
  for (const d of dbs) {
    for (const t of d.tables) {
      tables.set(t.name.toLowerCase(), d.name);
      for (const c of t.columns) {
        columns.set(c.name.toLowerCase(), d.name);
        for (const v of c.values || []) if (v.length >= 4 && /[a-z]/i.test(v)) values.set(v.toLowerCase(), d.name);
      }
    }
  }
  return { tables, columns, values };
}
