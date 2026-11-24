// SQL guard + executor: allowed queries pass (and get a LIMIT), injection attempts are refused, and the executor's
// own layer (read-only, authorizer, time limit) stops what the guard is not meant to catch.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { validateSql, SqlGuardError } from '../server/sql/guard.js';
import { runQuery } from '../server/sql/exec.js';
import path from 'node:path';
import { makeFixtures, FIXTURE_DIR } from './make_fixtures.mjs';

const ok = (sql, opts) => validateSql(sql, opts);
const bad = (sql, re) => assert.throws(() => validateSql(sql), e => e instanceof SqlGuardError && (!re || re.test(e.message)), sql);

test('plain SELECT and WITH pass; outer LIMIT added when missing', () => {
  const r = ok('SELECT name FROM customers');
  assert.equal(r.wrapped, true);
  assert.match(r.sql, /^SELECT \* FROM \(\nSELECT name FROM customers\n\) LIMIT 100$/);
  assert.equal(ok('with x as (select 1 as a) select a from x').wrapped, true);
  assert.equal(ok('SELECT 1 LIMIT 10;').wrapped, false);              // own LIMIT within bounds, trailing ; ok
  assert.equal(ok('SELECT 1 LIMIT 5000').wrapped, true);              // too big: capped
  assert.equal(ok('SELECT * FROM t LIMIT 10 OFFSET 20').wrapped, false);
  assert.equal(ok('SELECT * FROM (SELECT * FROM t LIMIT 5)').wrapped, true); // inner LIMIT only: still wrapped
  assert.match(ok('SELECT 1', { maxRows: 7 }).sql, /LIMIT 7$/);
});

test('keywords inside strings and quoted names are fine', () => {
  ok("SELECT * FROM service_tickets WHERE resolution = 'Firmware update'");
  ok("SELECT * FROM t WHERE note LIKE '%drop table%; delete%'");
  ok('SELECT "update", [delete] FROM "insert"');
  ok("SELECT replace(name, 'a', 'b') FROM customers");            // replace() the function
  ok("SELECT 'it''s; fine' AS x");
});

test('multiple statements are refused', () => {
  bad('SELECT 1; DROP TABLE customers', /one statement|forbidden/);
  bad('SELECT 1; SELECT 2', /one statement/);
  bad("SELECT 1 /* hide */ ; DELETE FROM t", /one statement|forbidden/);
  bad("SELECT 1;\n-- comment\nSELECT 2", /one statement/);
});

test('writes, DDL, PRAGMA, ATTACH, transactions refused', () => {
  bad('DELETE FROM customers', /only SELECT/);
  bad('PRAGMA table_info(customers)', /only SELECT/);
  bad("ATTACH DATABASE 'x.db' AS x", /only SELECT/);
  bad('INSERT INTO t VALUES (1)', /only SELECT/);
  bad('UPDATE t SET a = 1', /only SELECT/);
  bad('CREATE TABLE x(a)', /only SELECT/);
  bad('BEGIN', /only SELECT/);
});

test('writes hidden inside CTEs or behind comments are refused', () => {
  bad('WITH x AS (SELECT 1) DELETE FROM customers', /DELETE/);
  bad('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', /INSERT|INTO/);
  bad('WITH x AS (SELECT 1) UPDATE t SET a = 1', /UPDATE/);
  bad('WITH x AS (SELECT 1) REPLACE INTO t VALUES (1)', /REPLACE|INTO/);
  bad('SELECT 1 FROM t WHERE 1 = 1 UNION SELECT load_extension(\'evil\')', /LOAD_EXTENSION/);
  bad("SELECT writefile('x', 'y')", /WRITEFILE/);
  bad('/* SELECT */ DROP TABLE customers', /only SELECT/);
  bad('-- SELECT\nDROP TABLE customers', /only SELECT/);
  bad('SEL/**/ECT 1', /only SELECT/);
  bad('SELECT 1 /* unterminated', /unterminated/);
  bad("SELECT 'unterminated", /unterminated/);
  bad('SELECT * FROM t WHERE a = ?', /parameters/);
  bad('select 1 into outfile', /INTO/);
  bad('', /no SQL/);
});

test('pragma table-valued functions are refused too', () => {
  bad("SELECT name FROM pragma_table_info('customers')", /PRAGMA/);
  bad('SELECT * FROM PRAGMA_database_list', /PRAGMA/);
});

let dbPath;
before(() => { dbPath = makeFixtures(path.join(FIXTURE_DIR, 'guard')).files.sqlite; });

test('executor runs guarded SQL read-only and returns columns + rows', async () => {
  const g = validateSql('SELECT model, count(*) AS n FROM devices GROUP BY model ORDER BY n DESC, model');
  const r = await runQuery(dbPath, g.sql, { maxRows: 100 });
  assert.deepEqual(r.columns, ['model', 'n']);
  assert.ok(r.rows.length >= 3);
  assert.equal(r.truncated, false);
});

test('executor: writes and PRAGMA are not authorized even if they got past the guard', async () => {
  await assert.rejects(runQuery(dbPath, 'DELETE FROM customers'), /not authorized|readonly/i);
  await assert.rejects(runQuery(dbPath, 'PRAGMA journal_mode = WAL'), /not authorized/i);
  await assert.rejects(runQuery(dbPath, "ATTACH DATABASE ':memory:' AS x"), /not authorized/i);
  await assert.rejects(runQuery(dbPath, "SELECT load_extension('x')"), /not authorized/i);
});

test('executor: time limit stops a runaway query', async () => {
  const sql = validateSql('WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT count(*) FROM r').sql;
  await assert.rejects(runQuery(dbPath, sql, { timeoutMs: 800 }), /stopped/);
});

test('executor: row cap reports truncation', async () => {
  const r = await runQuery(dbPath, 'SELECT * FROM service_tickets', { maxRows: 5 });
  assert.equal(r.rows.length, 5);
  assert.equal(r.truncated, true);
});
