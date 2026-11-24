// Router heuristics (no model calls): signals, decisions, the single-source shortcuts, and the LLM fallback path
// with a fake model.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { heuristics, decideFromScores, routeQuestion, parseJsonReply } from '../server/router.js';
import { introspect, vocabulary, catalogText } from '../server/sql/schema.js';
import path from 'node:path';
import { makeFixtures, FIXTURE_DIR } from './make_fixtures.mjs';

let dbs, vocab;
const manuals = { count: 6, titles: ['ClimaTrol 24 (CT-00580)', 'NovaLink Essential (NL-00703)', 'Turkey Feeder System (FD-255)'] };
before(() => {
  dbs = [introspect(makeFixtures(path.join(FIXTURE_DIR, 'router')).files.sqlite, 'support')];
  vocab = vocabulary(dbs);
});

const decide = q => decideFromScores(heuristics(q, vocab));

test('catalog: tables, keys, distinct values, samples', () => {
  const t = dbs[0].tables.find(x => x.name === 'service_tickets');
  assert.equal(t.rows, 60);
  assert.ok(t.columns.find(c => c.name === 'ticket_id').pk);
  assert.deepEqual(t.columns.find(c => c.name === 'status').values, ['closed', 'in_progress', 'open']);
  assert.deepEqual(t.fks, [{ col: 'device_id', ref: 'devices', refcol: 'device_id' }]);
  const text = catalogText(dbs);
  assert.match(text, /TABLE service_tickets \(60 rows\)/);
  assert.match(text, /FOREIGN KEY device_id -> devices\.device_id/);
  assert.match(text, /VIEW open_tickets/);
});

test('database questions', () => {
  for (const q of ['How many open tickets are there?', 'List all customers in the Midwest region',
    'Which technician closed the most tickets last month?', 'average hours spent per ticket by priority',
    'Show me every device with firmware 2.1', 'total number of sites per state'])
    assert.equal(decide(q), 'database', q);
});

test('manual questions', () => {
  for (const q of ['How do I wire the alarm relay on the NovaLink Essential?', 'How do I install the cable on a BFT ground control retrofit kit?',
    'What is the recommended wire gauge for the alarm relay?', 'How do I adjust the low temperature alarm on the ClimaTrol 24?',
    'Steps to assemble the pan feeder'])
    assert.equal(decide(q), 'manuals', q);
});

test('both: meaning from the manual + records from the database', () => {
  for (const q of ['What does the defective probe alarm mean and which customers reported it this month?',
    'How do I fix a water spill alarm, and how many tickets had it since June?'])
    assert.equal(decide(q), 'both', q);
});

test('unclear questions go to the model', () => {
  for (const q of ['ClimaTrol 24', 'probe problems', 'what about Maple Ridge?']) assert.equal(decide(q), null, q);
});

test('heuristics name the matching database and the signals', () => {
  const h = heuristics('how many service tickets per technician', vocab);
  assert.equal(h.database, 'support');
  assert.ok(h.signals.includes('table:service_tickets'));
  assert.ok(h.signals.some(s => s.startsWith('column:technician')));
});

test('only one kind of source: no model call', async () => {
  const ask = () => { throw new Error('should not be called'); };
  assert.equal((await routeQuestion('how many tickets?', { manuals, dbs: [], vocab, ask })).route, 'manuals');
  const r = await routeQuestion('How do I wire it?', { manuals: { count: 0, titles: [] }, dbs, vocab, ask });
  assert.equal(r.route, 'database');
  assert.equal(r.via, 'only-source');
});

test('unclear -> model (fake) decides; bad replies fall back', async () => {
  const calls = [];
  const fake = text => async (prompt, opts) => { calls.push(opts.model); return { text }; };
  let r = await routeQuestion('probe problems', { manuals, dbs, vocab, ask: fake('```json\n{"route":"clarify","database":null,"clarify":"Manuals or tickets?","reason":"vague"}\n```') });
  assert.deepEqual([r.route, r.via, r.clarify], ['clarify', 'llm', 'Manuals or tickets?']);
  assert.equal(calls[0], 'haiku');
  r = await routeQuestion('probe problems', { manuals, dbs, vocab, ask: fake('{"route":"database","database":"nope"}') });
  assert.deepEqual([r.route, r.database], ['database', 'support']);
  r = await routeQuestion('probe problems', { manuals, dbs, vocab, prevRoute: 'database', ask: async () => { throw new Error('offline'); } });
  assert.deepEqual([r.route, r.via], ['database', 'fallback']);
});

test('parseJsonReply tolerates fences and prose', () => {
  assert.deepEqual(parseJsonReply('Sure:\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.throws(() => parseJsonReply('no json here'));
});
