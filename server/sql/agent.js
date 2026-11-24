// NL -> SQL agent: Claude (sonnet) writes one SQLite SELECT from the catalog, the guard checks it, it runs on the
// sandbox copy (read-only, time limit). One self-correction retry when the guard rejects it or SQLite errors.
// SQL_EXECUTE=false: stops after the guard and returns the SQL without running it.
import { askModel } from '../claude.js';
import { config } from '../config.js';
import { parseJsonReply } from '../router.js';
import { validateSql, SqlGuardError } from './guard.js';
import { runQuery } from './exec.js';
import { catalogText } from './schema.js';

export const SQL_SYSTEM = `You translate questions into ONE SQLite query over the databases described in <catalog>.
Rules:
- Exactly one statement: SELECT, or WITH ... SELECT. Never modify data. No PRAGMA, ATTACH, or parameters (?, :x).
- SQLite syntax and functions only: strftime(), date('now'), julianday(), ifnull(), group_concat(), LIKE (case-insensitive for ASCII).
- Use only tables and columns in the catalog. When a column lists its values, use them exactly as written.
- Dates are stored as text 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'. "This month" = strftime('%Y-%m', col) = strftime('%Y-%m', 'now').
- Join through the foreign keys. Prefer readable column aliases. For lists, add ORDER BY and LIMIT (at most 100).
- Return the columns a person needs to read the answer (e.g. names, not only ids).
- If the question also asks something only a manual or document could answer (what an alarm means, how to fix it), write SQL only for the data part.
- If the data cannot answer the question at all, say so instead of guessing.
Reply with JSON only, no prose:
{"database": "<name from the catalog>", "sql": "<the query>", "explanation": "<one short sentence>"}
or {"database": null, "sql": null, "cannot": "<why the data cannot answer this>"}`;

function buildSqlPrompt({ question, dbs, hintDb, feedback, previous, error }) {
  let p = `<catalog>\n${catalogText(dbs)}</catalog>\n<today>${new Date().toISOString().slice(0, 10)}</today>\n`;
  if (hintDb && dbs.length > 1) p += `<likely_database>${hintDb}</likely_database>\n`;
  p += `<question>${question}</question>\n`;
  if (previous) p += `<previous_sql database="${previous.database || ''}">${previous.sql}</previous_sql>\n`;
  if (feedback) p += `<user_feedback>The previous query was not what the user meant: "${feedback}". Write a different query that fits this feedback.</user_feedback>\n`;
  else if (previous && !error) p += `<user_feedback>The previous query was not what the user meant. Reconsider the interpretation and write a different query.</user_feedback>\n`;
  if (error) p += `<error>The previous attempt failed: ${error}. Fix the query.</error>\n`;
  return p;
}

/**
 * runSqlAgent({ question, dbs, dbPaths: {name: path}, hintDb, feedback, previous, onStatus, ask })
 *  -> { database, sql, explanation, executed, result?: {columns, rows, truncated, ms}, attempts: [{sql, error}], cannot?, error? }
 */
export async function runSqlAgent({ question, dbs, dbPaths, hintDb = null, feedback = '', previous = null, onStatus = () => {}, ask = askModel,
                                     execute = config.sqlExecute, maxRows = config.sqlMaxRows }) {
  const attempts = [];
  let error = null, costUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    onStatus(attempt ? 'Fixing the SQL…' : 'Writing SQL…');
    const prev = attempt ? attempts.at(-1) : previous;
    const r = await ask(buildSqlPrompt({ question, dbs, hintDb, feedback: attempt ? '' : feedback, previous: prev, error }), { system: SQL_SYSTEM, model: config.sqlModel });
    costUsd += r.costUsd || 0;
    let j;
    try { j = parseJsonReply(r.text); } catch (e) { error = `reply was not JSON (${e.message})`; attempts.push({ sql: String(r.text).slice(0, 500), error }); continue; }
    if (!j.sql) return { database: null, sql: null, cannot: j.cannot || 'the data cannot answer this', attempts, executed: false, costUsd };
    const database = dbPaths[j.database] ? j.database : (hintDb && dbPaths[hintDb] ? hintDb : Object.keys(dbPaths)[0]);
    let guarded;
    try { guarded = validateSql(j.sql, { maxRows }); }
    catch (e) {
      if (!(e instanceof SqlGuardError)) throw e;
      error = `rejected by the safety check: ${e.message}`;
      attempts.push({ database, sql: j.sql, error });
      continue;
    }
    const out = { database, sql: j.sql, runSql: guarded.sql, wrapped: guarded.wrapped, explanation: j.explanation || '', attempts, costUsd };
    if (!execute) return { ...out, executed: false };
    onStatus(`Running the query on ${database}…`);
    try {
      out.result = await runQuery(dbPaths[database], guarded.sql, { maxRows });
      out.executed = true;
      return out;
    } catch (e) {
      error = `SQLite error: ${e.message}`;
      attempts.push({ database, sql: j.sql, error });
    }
  }
  const last = attempts.at(-1) || {};
  return { database: last.database || null, sql: last.sql || null, executed: false, error: last.error || error, attempts, costUsd };
}

/** Rows as a compact Markdown table for the answer prompt (first `max` rows). */
export function rowsTable(result, max = 50) {
  if (!result) return '';
  const esc = v => (v === null || v === undefined ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 200));
  const head = `| ${result.columns.join(' | ')} |\n|${result.columns.map(() => '---').join('|')}|\n`;
  return head + result.rows.slice(0, max).map(r => `| ${r.map(esc).join(' | ')} |`).join('\n');
}
