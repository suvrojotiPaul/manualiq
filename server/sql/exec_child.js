// Runs ONE query in its own process (forked by exec.js), so a slow query can be killed without
// blocking the server. Read-only connection + an authorizer that only allows reading.
import { DatabaseSync, constants as C } from 'node:sqlite';

const DENY_FUNCS = new Set(['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'sqlite_dbpage']);

process.once('message', ({ dbPath, sql, maxRows }) => {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false });
    try { db.enableDefensive(true); } catch {}
    db.setAuthorizer((code, a1, a2) => {
      if (code === C.SQLITE_SELECT || code === C.SQLITE_READ || code === C.SQLITE_RECURSIVE) return C.SQLITE_OK;
      if (code === C.SQLITE_FUNCTION) return DENY_FUNCS.has(String(a2).toLowerCase()) ? C.SQLITE_DENY : C.SQLITE_OK;
      return C.SQLITE_DENY;
    });
    const st = db.prepare(sql);
    st.setReturnArrays(true);
    const columns = st.columns().map(c => c.name);
    const rows = [];
    let truncated = false;
    for (const r of st.iterate()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(r.map(v => (v instanceof Uint8Array ? `<blob ${v.length} bytes>` : typeof v === 'bigint' ? v.toString() : v)));
    }
    process.send({ ok: true, columns, rows, truncated });
  } catch (err) {
    process.send({ ok: false, error: err.message });
  } finally {
    try { db?.close(); } catch {}
    process.disconnect();
  }
});
