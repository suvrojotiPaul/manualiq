// End-to-end check against a running server (uses Claude: each question costs 1-3 model calls).
//   node test/e2e_chat.mjs [baseUrl] [outFile]
// Drives POST /chat the way the Datastar page does (JSON signals in, SSE patches out) and records, per turn:
// route label, SQL, row count, answer text, time. Results go to data/e2e/results.json (git-ignored).
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5623';
const OUT = process.argv[3] || path.join('data', 'e2e', 'results.json');

const strip = html => html.replace(/<br>/g, '\n').replace(/<\/(p|li|h\d|tr)>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

async function turn(chatId, question, { action, ref } = {}) {
  const qs = new URLSearchParams();
  if (action) qs.set('action', action);
  if (ref) qs.set('ref', ref);
  const started = Date.now();
  const res = await fetch(`${BASE}/chat${qs.size ? `?${qs}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Datastar-Request': 'true' },
    body: JSON.stringify({ chatId, question, busy: false }),
  });
  const text = await res.text();
  const els = new Map(); let newChat = chatId, msgId = null;
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find(l => l.startsWith('event: '))?.slice(7);
    const data = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    if (ev === 'datastar-patch-signals') {
      const s = JSON.parse(data.find(d => d.startsWith('signals ')).slice(8));
      if (s.chatId) newChat = s.chatId;
    } else if (ev === 'datastar-patch-elements') {
      const html = data.filter(d => d.startsWith('elements ')).map(d => d.slice(9)).join('\n');
      const m = html.match(/id="m-([0-9a-f]+)"/);
      if (m) msgId = m[1];
      for (const id of ['r', 'b', 'q', 'st']) {
        const mm = html.match(new RegExp(`^<div class="[^"]*" id="${id}-([0-9a-f]+)"`));
        if (mm) els.set(id, html);
      }
    }
  }
  const sqlHtml = els.get('q') || '';
  const sql = (sqlHtml.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/) || [])[1];
  return {
    chatId: newChat, msgId, question, action: action || 'ask', seconds: Math.round((Date.now() - started) / 100) / 10,
    route: strip(els.get('r') || ''), sql: sql ? strip(sql) : null,
    sqlInfo: strip(sqlHtml.replace(/<details[\s\S]*<\/details>/, '').replace(/<table[\s\S]*<\/table>/, '')),
    rows: (sqlHtml.match(/<tr>/g) || []).length - (sqlHtml.includes('<thead>') ? 1 : 0),
    answer: strip(els.get('b') || ''),
  };
}

const PLAN = [
  { kind: 'manual', q: 'How do I wire the alarm relay on the NovaLink Essential?' },
  { kind: 'manual', q: 'How do I adjust the low and high temperature alarm limits on the ClimaTrol 24?', then: { action: 'shorter' } },
  { kind: 'database', q: 'How many service tickets are still open or in progress?', then: { action: 'retry', feedback: 'only tickets opened in November 2026, split by status' } },
  { kind: 'database', q: 'Which customers have NovaLink Essential controllers, and how many devices each?' },
  { kind: 'database', q: 'What is the average hours spent on closed tickets per technician?' },
  { kind: 'both', q: 'What does the defective probe alarm mean on the ClimaTrol controllers, and which customers reported it this month?' },
  { kind: 'both', q: 'How do I fix a water spill alarm, and how many tickets had a water spill alarm since June?' },
  { kind: 'ambiguous', q: 'probe problems' },
  // extra flows (run with E2E_ONLY=8,9)
  { kind: 'database', q: 'What is the average hours spent on closed tickets per technician?', then: { action: 'more' } },
  { kind: 'ambiguous', q: 'probe problems', then: { typed: 'the service records' } }, // typed answer to the clarifying question
];

const only = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',').map(Number)) : null;
const results = [];
for (const [i, p] of PLAN.entries()) {
  if (only && !only.has(i)) continue;
  const r = await turn('', p.q);
  r.kind = p.kind;
  results.push(r);
  console.log(`\n[${i}] (${p.kind}) ${p.q}\n  route: ${r.route} · ${r.seconds}s${r.sql ? `\n  sql: ${r.sql.replace(/\s+/g, ' ')}` : ''}${r.rows > 0 ? `\n  rows shown: ${r.rows}` : ''}\n  answer: ${r.answer.slice(0, 600).replace(/\n/g, '\n          ')}`);
  if (p.then) {
    const f = p.then.typed ? await turn(r.chatId, p.then.typed) : await turn(r.chatId, p.then.feedback || '', { action: p.then.action, ref: r.msgId });
    f.kind = `${p.kind} follow-up: ${p.then.action || `typed "${p.then.typed}"`}`;
    results.push(f);
    console.log(`  -> ${p.then.action}${p.then.feedback ? ` "${p.then.feedback}"` : ''}: route ${f.route} · ${f.seconds}s${f.sql ? `\n     sql: ${f.sql.replace(/\s+/g, ' ')}` : ''}\n     answer: ${f.answer.slice(0, 500).replace(/\n/g, '\n             ')}`);
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`\nsaved ${results.length} turns to ${OUT}`);
