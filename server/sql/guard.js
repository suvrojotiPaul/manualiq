// The gate every model-written query passes before it runs (SQLite flavour).
//   * exactly one statement (one trailing ';' is fine, any other top-level ';' is not)
//   * starts with SELECT or WITH
//   * no forbidden keyword outside string literals / quoted names (writes, DDL, PRAGMA, ATTACH, transactions,
//     extension loading, file functions), so  WHERE resolution = 'Firmware update'  is still allowed
//   * an outer LIMIT (default 100): queries without one, or with a bigger one, are wrapped
// Second line of defence (sql/exec.js): read-only connection, an authorizer that only allows reads,
// a separate process with a time limit, and the query runs on a sandbox copy.

export class SqlGuardError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'SqlGuardError'; this.details = details; }
}

export const FORBIDDEN = [
  'insert', 'update', 'delete', 'upsert', 'merge', 'replace', // replace( ) the string function is allowed, see below
  'create', 'alter', 'drop', 'truncate', 'rename', 'reindex', 'vacuum', 'analyze',
  'attach', 'detach', 'pragma',
  'begin', 'commit', 'rollback', 'savepoint', 'release', 'transaction',
  'grant', 'revoke', 'into', // SELECT ... INTO / INSERT INTO
  'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'zipfile', 'sqlar_compress', 'sqlar_uncompress',
  'sqlite_dbpage', 'sqlite_dbdata', 'sqlite_stmt',
];

/**
 * Lex the SQL once: comments removed, and a "masked" copy where string literals and quoted identifiers are blanked
 * (keywords are only looked for there). SQLite quoting: '...' strings, "..." `...` [...] identifiers, no backslash escapes.
 */
export function lex(sql) {
  let clean = '', masked = '', i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; clean += ' '; masked += ' '; continue; }
    if (c === '/' && d === '*') {
      const e = sql.indexOf('*/', i + 2);
      if (e < 0) throw new SqlGuardError('unterminated comment');
      i = e + 2; clean += ' '; masked += ' '; continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new SqlGuardError('unterminated quoted text');
        if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      const lit = sql.slice(i, j + 1);
      clean += lit;
      masked += c === "'" ? "''" : '""'; // keep the shape (string vs name), drop the content
      i = j + 1;
      continue;
    }
    clean += c; masked += c; i++;
  }
  return { clean, masked };
}

/** masked text at parenthesis depth 0 only (for top-level LIMIT / ';' checks) */
function topLevel(masked) {
  let depth = 0, out = '';
  for (const ch of masked) {
    if (ch === '(') depth++;
    if (depth === 0) out += ch; else out += ' ';
    if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return out;
}

/**
 * validateSql(raw, { maxRows }) -> { sql, wrapped, limit }   (throws SqlGuardError)
 */
export function validateSql(raw, { maxRows = 100 } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new SqlGuardError('no SQL was produced');
  let { clean, masked } = lex(raw);
  clean = clean.trim(); masked = masked.trim();
  // one trailing semicolon (possibly followed by blanks) is fine
  if (masked.endsWith(';')) { masked = masked.replace(/;\s*$/, '').trim(); clean = clean.replace(/;\s*$/, '').trim(); }
  if (!clean) throw new SqlGuardError('SQL is empty after removing comments');
  if (masked.includes(';')) throw new SqlGuardError('only one statement is allowed');
  if (!/^(select|with)\b/i.test(masked)) throw new SqlGuardError('only SELECT or WITH queries are allowed', { start: clean.slice(0, 20) });
  const low = masked.toLowerCase();
  for (const kw of FORBIDDEN) {
    const re = kw === 'replace' ? /\breplace\b(?!\s*\()/ : new RegExp(`\\b${kw}\\b`);
    if (re.test(low)) throw new SqlGuardError(`forbidden keyword "${kw.toUpperCase()}"`, { keyword: kw });
  }
  if (/\bpragma_\w+/.test(low)) throw new SqlGuardError('forbidden keyword "PRAGMA" (pragma_* functions)', { keyword: 'pragma' });
  // parameters would be unbound: refuse rather than run with NULLs
  if (/[?]|(^|[^:]):[a-z_]|[@$][a-z_]/i.test(masked)) throw new SqlGuardError('query parameters are not allowed; put the values in the SQL');

  const top = topLevel(masked);
  const m = /\blimit\s+(\d+)(\s*(,|offset)\s*\d+)?\s*$/i.exec(top);
  let sql = clean, wrapped = false, limit = maxRows;
  if (!m || Number(m[1]) > maxRows) {
    sql = `SELECT * FROM (\n${clean}\n) LIMIT ${maxRows}`;
    wrapped = true;
  } else limit = Number(m[1]);
  return { sql, wrapped, limit };
}
