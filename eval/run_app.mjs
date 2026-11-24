// Run the 20 test questions through this app's pipeline (same retrieval + prompt + model as the chat),
// each in a fresh session, and save the answers to eval/answers/app/qNN.md.
//
//   node --disable-warning=ExperimentalWarning eval/run_app.mjs            all questions (skips ones already answered)
//   node --disable-warning=ExperimentalWarning eval/run_app.mjs q03 q07    only these
//   ... --force                                                            re-run even if answered
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { retrieve } from '../server/retrieval.js';
import { embedQuery, stopEmbedder, vectorsEnabled } from '../server/embed.js';
import { askModel } from '../server/claude.js';
import { SYSTEM_PROMPT, buildPrompt } from '../server/prompts.js';
import { ROOT } from '../server/config.js';

const EVAL = path.join(ROOT, 'eval');
const args0 = process.argv.slice(2);
const TOOL = args0.includes('--tool') ? args0[args0.indexOf('--tool') + 1] : 'app';
const OUT = path.join(EVAL, 'answers', TOOL);
console.log(`tool ${TOOL}, hybrid ${vectorsEnabled}`);
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = new Set(args.filter(a => /^q\d+$/.test(a)));
const questions = JSON.parse(fs.readFileSync(path.join(EVAL, 'questions.json'), 'utf8'))
  .filter(q => !only.size || only.has(q.id));

const meta = fs.existsSync(path.join(OUT, '_meta.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, '_meta.json'), 'utf8')) : {};

for (const q of questions) {
  const file = path.join(OUT, `${q.id}.md`);
  if (!force && fs.existsSync(file)) { console.log(`${q.id} already answered (use --force to redo)`); continue; }
  const t0 = Date.now();
  const r = retrieve(q.question, { qvec: await embedQuery(q.question) });
  const res = await askModel(buildPrompt('ask', { question: q.question, retrieval: r }), {
    system: SYSTEM_PROMPT, sessionId: randomUUID(), resume: false,
  });
  fs.writeFileSync(file, res.text.trim() + '\n');
  meta[q.id] = {
    mode: r.mode, manuals: r.manuals.map(m => m.doc_number), sectionIds: r.sections.map(s => s.id), tokens: r.tokens,
    goldSectionsSent: q.sections.filter(id => r.sections.some(s => s.id === id)).length + '/' + q.sections.length,
    costUsd: res.costUsd, seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  fs.writeFileSync(path.join(OUT, '_meta.json'), JSON.stringify(meta, null, 2));
  console.log(`${q.id}  ${meta[q.id].seconds}s  $${(res.costUsd ?? 0).toFixed(3)}  gold sections sent ${meta[q.id].goldSectionsSent}  [${meta[q.id].manuals.join(', ')}]`);
}
stopEmbedder();
