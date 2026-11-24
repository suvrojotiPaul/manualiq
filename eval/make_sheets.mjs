// Create empty answer sheets for the tools you test by hand (paste each answer into its file).
//
//   node eval/make_sheets.mjs                       chatgpt, gemini, google-ai-mode
//   node eval/make_sheets.mjs claude-web perplexity other tool names (folder names)
// Existing files are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const tools = process.argv.slice(2).length ? process.argv.slice(2) : ['chatgpt', 'gemini', 'google-ai-mode'];
const questions = JSON.parse(fs.readFileSync(path.join(EVAL, 'questions.json'), 'utf8'));

for (const tool of tools) {
  const dir = path.join(EVAL, 'answers', tool);
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const q of questions) {
    const file = path.join(dir, `${q.id}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file,
`<!-- ${q.id} · ${tool}
Ask this (new chat, web search on):
${q.question}

Paste the full answer below this comment. If it showed images or files, add a line starting with
NOTE: saying what they were, e.g.  NOTE: showed a wiring diagram titled Model 22 controller.
-->

`);
    made++;
  }
  console.log(`${tool}: ${made} new sheet(s) in eval/answers/${tool}/`);
}

// one list to copy questions from
const list = questions.map(q => `${q.id}. ${q.question}`).join('\n\n');
fs.writeFileSync(path.join(EVAL, 'ASK_THESE.md'),
  `# The 20 test questions\n\nAsk each in a **new chat** with web search on. Don't add context, so every tool starts the same way.\n\n${list}\n`);
console.log('question list: eval/ASK_THESE.md');
