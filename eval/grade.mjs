// Blind grading: every answer in eval/answers/<tool>/qNN.md is scored against the manual text and the
// key facts in questions.json, by Claude (Claude Code CLI, no API key). The grader never sees the tool name.
// Writes eval/results/<tool>/qNN.json and the summary eval/report.md.
//
//   node --disable-warning=ExperimentalWarning eval/grade.mjs                 grade new/changed answers, then report
//   node --disable-warning=ExperimentalWarning eval/grade.mjs --model sonnet  cheaper grader (default: opus)
//   node --disable-warning=ExperimentalWarning eval/grade.mjs --report        only rebuild the report
//   ... --force                                                               re-grade everything
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { askModel } from '../server/claude.js';
import { stmt } from '../server/db.js';
import { ROOT } from '../server/config.js';

const EVAL = path.join(ROOT, 'eval');
const args = process.argv.slice(2);
const force = args.includes('--force');
const reportOnly = args.includes('--report');
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'opus';
const questions = JSON.parse(fs.readFileSync(path.join(EVAL, 'questions.json'), 'utf8'));

const JUDGE_SYSTEM = `You grade answers to technical support questions against the official manual.
You get: the question, the reference text from the manual, the key facts a good answer must contain, known traps,
optional reviewer notes, and ONE answer to grade. You do not know who or what wrote the answer. Be strict and consistent.

For each key fact decide: "covered" (stated correctly), "partial" (incomplete or vague), "missing", or "contradicted" (stated wrongly).
"errors": statements in the answer that contradict the reference, or that give this product a specific value, terminal,
part number, setting or step that the reference shows differently. Generic safety advice or extra true context is not an error.
"unverified": specific claims (numbers, part numbers, terminals, steps) that the reference neither confirms nor contradicts.
Reviewer notes are facts observed by a human (e.g. which diagram was shown); count them.
"product": "correct" if the answer is about the right product/manual, "wrong" if it answers for a different model or product,
"unclear" if it never commits.
"cites": "page" if it points to a manual and page, "manual" if only a document, "none" otherwise.
"score": 0-10. 10 = all key facts, no errors, usable as is. Subtract heavily for errors and wrong product
(a wrong terminal or value can damage equipment), moderately for missing facts, a little for vagueness or padding.

Reply with JSON only, no other text:
{"facts": ["covered"|"partial"|"missing"|"contradicted", ...one per key fact, in order],
 "errors": ["..."], "unverified": ["..."], "trap_hit": true|false, "product": "correct"|"wrong"|"unclear",
 "cites": "page"|"manual"|"none", "score": 0-10, "comment": "one sentence"}`;

function readAnswer(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const notes = raw.split('\n').filter(l => /^\s*NOTE:/i.test(l)).map(l => l.replace(/^\s*NOTE:\s*/i, ''));
  const text = raw.split('\n').filter(l => !/^\s*NOTE:/i.test(l)).join('\n').trim();
  return { text, notes };
}

function referenceText(q) {
  return q.sections.map(id => {
    const s = stmt.section.get(id);
    const m = s && stmt.manual.get(s.manual_id);
    return s ? `[${m?.doc_number} "${m?.title}" — ${s.path}, pages ${s.page_start}-${s.page_end}]\n${s.text}` : '';
  }).join('\n\n');
}

function judgePrompt(q, ans) {
  return `<question>${q.question}</question>

<reference source="${q.source.manual}, p.${q.source.pages}${q.source.also ? `; also ${q.source.also}` : ''}">
${referenceText(q)}
</reference>

<key_facts>
${q.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}
</key_facts>

<traps>${q.traps.length ? q.traps.map(t => `\n- ${t}`).join('') : ' none'}
</traps>
${ans.notes.length ? `\n<reviewer_notes>\n${ans.notes.map(n => `- ${n}`).join('\n')}\n</reviewer_notes>\n` : ''}
<answer_to_grade>
${ans.text}
</answer_to_grade>`;
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('grader did not return JSON');
  return JSON.parse(m[0]);
}

const tools = fs.existsSync(path.join(EVAL, 'answers'))
  ? fs.readdirSync(path.join(EVAL, 'answers'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];

// ---------- grade ----------
if (!reportOnly) {
  // random order across tools so nothing about the order hints at the source
  const jobs = [];
  for (const tool of tools) for (const q of questions) {
    const file = path.join(EVAL, 'answers', tool, `${q.id}.md`);
    if (!fs.existsSync(file)) continue;
    const ans = readAnswer(file);
    if (!ans.text) continue;
    const hash = createHash('sha256').update(ans.text + ans.notes.join('|') + JSON.stringify(q) + model).digest('hex').slice(0, 16);
    const out = path.join(EVAL, 'results', tool, `${q.id}.json`);
    if (!force && fs.existsSync(out) && JSON.parse(fs.readFileSync(out, 'utf8')).hash === hash) continue;
    jobs.push({ tool, q, ans, hash, out });
  }
  jobs.sort(() => Math.random() - 0.5);
  console.log(`${jobs.length} answer(s) to grade with ${model}`);
  let i = 0;
  for (const j of jobs) {
    i++;
    try {
      const res = await askModel(judgePrompt(j.q, j.ans), { system: JUDGE_SYSTEM, sessionId: randomUUID(), model });
      const g = parseJson(res.text);
      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      fs.writeFileSync(j.out, JSON.stringify({ ...g, hash: j.hash, grader: model, costUsd: res.costUsd }, null, 2));
      console.log(`[${i}/${jobs.length}] graded (${g.score}/10)`);
    } catch (err) {
      console.error(`[${i}/${jobs.length}] ${j.tool} ${j.q.id} failed: ${err.message}`);
    }
  }
}

// ---------- report ----------
const FACT = { covered: 1, partial: 0.5, missing: 0, contradicted: 0 };
const rows = [];
const per = {};
for (const tool of tools) {
  per[tool] = {};
  for (const q of questions) {
    const f = path.join(EVAL, 'results', tool, `${q.id}.json`);
    if (fs.existsSync(f)) per[tool][q.id] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const gs = Object.values(per[tool]);
  if (!gs.length) continue;
  const avg = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const pct = n => `${Math.round(100 * n / gs.length)}%`;
  rows.push({
    tool, n: gs.length,
    score: avg(gs.map(g => g.score)).toFixed(1),
    facts: `${Math.round(100 * avg(gs.map(g => avg((g.facts || []).map(s => FACT[s] ?? 0)))))}%`,
    errors: gs.filter(g => (g.errors || []).length).length,
    wrong: gs.filter(g => g.product === 'wrong').length,
    traps: gs.filter(g => g.trap_hit).length,
    cites: pct(gs.filter(g => g.cites === 'page').length),
  });
}
rows.sort((a, b) => b.score - a.score);

const appMeta = fs.existsSync(path.join(EVAL, 'answers', 'app', '_meta.json'))
  ? JSON.parse(fs.readFileSync(path.join(EVAL, 'answers', 'app', '_meta.json'), 'utf8')) : {};

let md = `# Manuals test: results\n\n${questions.length} questions from your manuals, graded blind against the manual text (grader: ${model}). See eval/README.md for how it works.\n\n`;
md += `| Tool | Answered | Avg score /10 | Key facts covered | Answers with errors | Wrong product | Trap hit | Cites the page |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.tool} | ${r.n}/${questions.length} | **${r.score}** | ${r.facts} | ${r.errors} | ${r.wrong} | ${r.traps} | ${r.cites} |\n`;
md += `\n## Score per question\n\n| Question | Topic | ${rows.map(r => r.tool).join(' | ')} |\n|---|---|${rows.map(() => '---').join('|')}|\n`;
for (const q of questions) {
  md += `| ${q.id} ${q.question.slice(0, 60)}… | ${q.topic} | ${rows.map(r => {
    const g = per[r.tool][q.id];
    return g ? `${g.score}${g.product === 'wrong' ? ' ⚠wrong product' : ''}${(g.errors || []).length ? ` ✗${g.errors.length}` : ''}` : '–';
  }).join(' | ')} |\n`;
}
md += `\n✗n = number of statements that contradict the manual.\n\n## Errors found\n`;
for (const r of rows) {
  const errs = questions.flatMap(q => (per[r.tool][q.id]?.errors || []).map(e => `- **${q.id}**: ${e}`));
  md += `\n### ${r.tool} (${errs.length})\n${errs.join('\n') || '- none'}\n`;
}
if (Object.keys(appMeta).length) {
  md += `\n## This app: did retrieval send the right section?\n\n| Question | Right section sent | Manuals used | Time | $ equiv. |\n|---|---|---|---|---|\n`;
  for (const q of questions) {
    const m = appMeta[q.id];
    if (m) md += `| ${q.id} | ${m.goldSectionsSent} | ${m.manuals.join(', ')} | ${m.seconds}s | ${(m.costUsd ?? 0).toFixed(3)} |\n`;
  }
}
fs.writeFileSync(path.join(EVAL, 'report.md'), md);
console.log('\n' + rows.map(r => `${r.tool.padEnd(16)} score ${r.score}  facts ${r.facts}  errors ${r.errors}  wrong product ${r.wrong}`).join('\n'));
console.log('report: eval/report.md');
