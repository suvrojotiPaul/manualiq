// Execute a guarded query against a sandbox database copy: separate process, read-only, time limit.
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exec_child.js');
export const SQL_TIMEOUT_MS = Number(process.env.SQL_TIMEOUT_MS || 5000);

export class SqlExecError extends Error {
  constructor(message, { timeout = false } = {}) { super(message); this.name = 'SqlExecError'; this.timeout = timeout; }
}

/** runQuery(dbPath, sql, { maxRows, timeoutMs }) -> { columns, rows, truncated, ms } */
export function runQuery(dbPath, sql, { maxRows = 100, timeoutMs = SQL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = fork(CHILD, [], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let done = false, stderr = '';
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => { child.kill(); finish(new SqlExecError(`query took longer than ${timeoutMs / 1000}s and was stopped`, { timeout: true })); }, timeoutMs);
    child.stderr.on('data', d => { stderr += d; });
    child.on('message', m => (m.ok ? finish(null, { columns: m.columns, rows: m.rows, truncated: m.truncated, ms: Date.now() - started }) : finish(new SqlExecError(m.error))));
    child.on('error', err => finish(new SqlExecError(`could not start query process: ${err.message}`)));
    child.on('exit', code => finish(new SqlExecError(`query process exited (${code}) ${stderr.trim().split('\n').pop() || ''}`)));
    child.send({ dbPath, sql, maxRows });
  });
}
