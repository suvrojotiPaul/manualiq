// One-time setup:  npm run setup   (safe to re-run)
//  1. checks Node, Python and the Claude Code CLI
//  2. creates .env from .env.example (if missing) and a Python venv in .venv with requirements.txt
//  3. creates an empty index and ingests whatever is in data/inbox/ (manuals and databases)
//  --skip-claude   don't make the small test call to Claude
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const ok = m => console.log(`  ✓ ${m}`);
const fail = (m, fix) => { console.error(`  ✗ ${m}${fix ? `\n    fix: ${fix}` : ''}`); process.exit(1); };
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', windowsHide: true, ...opts });

console.log('ManualIQ setup\n');

// 1. Node
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) fail(`Node ${process.versions.node} is too old (need 22.13+)`, 'install Node 22 LTS or newer from https://nodejs.org');
ok(`Node ${process.versions.node}`);

// 2. .env
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) { fs.copyFileSync(path.join(ROOT, '.env.example'), envFile); ok('created .env from .env.example'); }
else ok('.env exists (left as is)');

// 3. Python venv + packages
const venvPy = win ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
if (!fs.existsSync(venvPy)) {
  const sysPy = process.env.PYTHON || (win ? 'python' : 'python3');
  const v = run(sysPy, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
  if (v.status !== 0) fail(`Python not found (${sysPy})`, 'install Python 3.11+ from https://www.python.org and re-run');
  const [pmaj, pmin] = v.stdout.trim().split('.').map(Number);
  if (pmaj < 3 || (pmaj === 3 && pmin < 11)) fail(`Python ${v.stdout.trim()} is too old (need 3.11+)`);
  ok(`Python ${v.stdout.trim()}`);
  console.log('  … creating .venv');
  if (run(sysPy, ['-m', 'venv', path.join(ROOT, '.venv')], { stdio: 'inherit' }).status !== 0) fail('could not create .venv');
}
console.log('  … installing Python packages (pdfplumber, pypdfium2, fastembed)');
if (run(venvPy, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', path.join(ROOT, 'requirements.txt')], { stdio: 'inherit' }).status !== 0) {
  fail('pip install failed', `run: ${venvPy} -m pip install -r requirements.txt`);
}
ok('Python packages installed in .venv');

// 4. Claude Code CLI (imports config only now, so .venv is picked up)
const { config } = await import('../server/config.js');
const ver = run(config.claudeBin, ['--version']);
if (ver.status !== 0) fail(`Claude Code CLI not found (${config.claudeBin})`, 'install Claude Code (https://claude.com/claude-code), run `claude` once to log in, or set CLAUDE_BIN in .env');
ok(`Claude Code CLI ${ver.stdout.trim()}`);
if (!args.includes('--skip-claude')) {
  console.log('  … test call to Claude (haiku, a few tokens)');
  const t = run(config.claudeBin, ['-p', '--model', 'haiku', '--tools', ''], { input: 'Reply with the single word: ready', timeout: 90000, cwd: config.sessionsDir });
  if (t.status !== 0 || !/ready/i.test(t.stdout)) fail('Claude did not answer', `run \`claude\` once in a terminal and log in, or put ANTHROPIC_API_KEY=... in .env, then re-run setup.\n    ${(t.stderr || t.stdout || '').trim().split('\n').slice(-2).join(' ')}`);
  ok('Claude answers');
}

// 5. index + inbox
const init = run(venvPy, ['-I', path.join(ROOT, 'ingest', 'add_manual.py'), 'init'], { cwd: ROOT });
if (init.status !== 0) fail('could not create the index', init.stderr.trim().split('\n').pop());
ok(`index ready at ${path.relative(ROOT, config.dbPath)}`);

const inbox = ['manuals', 'databases'].flatMap(d => fs.readdirSync(path.join(config.inboxDir, d)).map(f => `${d}/${f}`));
if (inbox.length) {
  console.log(`  … ingesting ${inbox.length} file(s) from data/inbox (manuals are parsed and embedded on your CPU; large sets take a while)`);
  const r = run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', 'ingest_inbox.mjs')], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) console.log('  ! some files failed; see above. The rest were loaded.');
} else {
  console.log('  · data/inbox is empty: add PDFs to data/inbox/manuals and databases to data/inbox/databases,');
  console.log('    or upload them in the app under Sources.');
}

console.log('\nDone. Start the app with:  npm start');
