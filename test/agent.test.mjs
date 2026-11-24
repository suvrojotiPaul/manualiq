// SQL agent with a scripted fake model (no Claude calls): self-correction after a SQLite error or a guard
// rejection, SQL_EXECUTE=false, "cannot answer", and the prompt pieces built from the result.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runSqlAgent } from '../server/sql/agent.js';
import { introspect } from '../server/sql/schema.js';
import { databaseBlock, columnSums } from '../server/prompts.js';
import { makeFixtures, FIXTURE_DIR } from './make_fixtures.mjs';

let dbs, dbPaths;
before(() => {
  const file = makeFixtures(path.join(FIXTURE_DIR, 'agent')).files.sqlite;
  dbs = [introspect(file, 'support')];
  dbPaths = { support: file };
});

/** fake model: returns the scripted replies in order, records the prompts */
function script(...replies) {
  const prompts = [];
  const ask = async (prompt, opts) => { prompts.push({ prompt, model: opts.model }); return { text: replies.shift(), costUsd: 0 }; };
  return { ask, prompts };
}
const reply = (sql, database = 'support') => JSON.stringify({ database, sql, explanation: 'x' });

test('happy path: one call, guarded, executed', async () => {
  const m = script(reply('SELECT status, count(*) AS n FROM service_tickets GROUP BY status ORDER BY status'));
  const r = await runSqlAgent({ question: 'tickets by status', dbs, dbPaths, ask: m.ask, execute: true });
  assert.equal(m.prompts.length, 1);
  assert.equal(m.prompts[0].model, 'sonnet');
  assert.match(m.prompts[0].prompt, /<catalog>[\s\S]*TABLE service_tickets/);
  assert.equal(r.executed, true);
  assert.deepEqual(r.result.columns, ['status', 'n']);
  assert.equal(r.wrapped, true); // no LIMIT in the model's SQL -> outer LIMIT added
});

test('SQLite error -> one self-correction with the error message', async () => {
  const m = script(reply('SELECT nonexistent_col FROM service_tickets'), reply('SELECT count(*) AS n FROM service_tickets'));
  const r = await runSqlAgent({ question: 'how many tickets', dbs, dbPaths, ask: m.ask, execute: true });
  assert.equal(m.prompts.length, 2);
  assert.match(m.prompts[1].prompt, /<error>.*no such column: nonexistent_col/);
  assert.match(m.prompts[1].prompt, /<previous_sql database="support">SELECT nonexistent_col/);
  assert.equal(r.executed, true);
  assert.equal(r.result.rows[0][0], 60);
  assert.equal(r.attempts.length, 1);
});

test('guard rejection -> retry; two failures -> error, no third call', async () => {
  const m = script(reply('DELETE FROM customers'), reply('SELECT 1; DROP TABLE customers'), reply('SELECT 1'));
  const r = await runSqlAgent({ question: 'delete all customers', dbs, dbPaths, ask: m.ask, execute: true });
  assert.equal(m.prompts.length, 2);
  assert.match(m.prompts[1].prompt, /rejected by the safety check/);
  assert.equal(r.executed, false);
  assert.match(r.error, /safety check/);
});

test('SQL_EXECUTE=false: SQL returned, nothing run', async () => {
  const m = script(reply('SELECT * FROM customers'));
  const r = await runSqlAgent({ question: 'list customers', dbs, dbPaths, ask: m.ask, execute: false });
  assert.equal(r.executed, false);
  assert.equal(r.result, undefined);
  assert.equal(r.sql, 'SELECT * FROM customers');
  assert.match(databaseBlock(r), /SQL_EXECUTE=false/);
});

test('model says the data cannot answer', async () => {
  const m = script('{"database": null, "sql": null, "cannot": "no weather data"}');
  const r = await runSqlAgent({ question: 'what was the weather', dbs, dbPaths, ask: m.ask });
  assert.equal(r.cannot, 'no weather data');
  assert.match(databaseBlock(r), /cannot answer this: no weather data/);
});

test('retry with user feedback includes previous SQL and the feedback', async () => {
  const m = script(reply('SELECT count(*) FROM service_tickets WHERE status = \'open\''));
  await runSqlAgent({ question: 'open tickets', dbs, dbPaths, ask: m.ask, feedback: 'only November', previous: { database: 'support', sql: 'SELECT 1' } });
  assert.match(m.prompts[0].prompt, /<previous_sql database="support">SELECT 1<\/previous_sql>/);
  assert.match(m.prompts[0].prompt, /only November/);
});

test('column sums: counts summed, ids and averages skipped', () => {
  const s = columnSums({ columns: ['customer_id', 'name', 'devices', 'avg_hours'], rows: [[1, 'a', 3, 2.5], [2, 'b', 7, 3.5]] });
  assert.equal(s, 'devices=10');
});
