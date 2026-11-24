// Central configuration. Override any value with an environment variable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');

// Find the Claude Code CLI: $CLAUDE_BIN, then `claude` on PATH, then the newest VS Code extension copy.
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return p;
  }
  for (const base of ['.vscode', '.vscode-insiders', '.cursor'].map(d => path.join(os.homedir(), d, 'extensions'))) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('anthropic.claude-code-')).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'resources', 'native-binary', exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return exe; // last resort: hope it is on PATH at runtime
}

// Python for parsing, page images and embeddings: $PYTHON, else the project's .venv (made by `npm run setup`), else system.
function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = process.platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON = findPython();

export const config = {
  ROOT,
  port: Number(process.env.PORT || 5623),
  host: process.env.HOST || '127.0.0.1',
  claudeBin: findClaude(),
  model: process.env.CLAUDE_MODEL || 'sonnet',          // answers (manual, database, both)
  sqlModel: process.env.SQL_MODEL || 'sonnet',          // NL -> SQL
  routerModel: process.env.ROUTER_MODEL || 'haiku',     // routing / classification
  sqlExecute: !/^(0|false|no|off)$/i.test(process.env.SQL_EXECUTE || 'true'),
  sqlMaxRows: Number(process.env.SQL_MAX_ROWS || 100),  // outer LIMIT the guard enforces
  embedPython: process.env.EMBED_PYTHON || PYTHON,
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024,
  uploadsDir: path.join(DATA, 'uploads'),                 // sources.json registry, pdfs/, db/, tmp/
  uploadPdfDir: path.join(DATA, 'uploads', 'pdfs'),
  uploadDbDir: path.join(DATA, 'uploads', 'db'),
  inboxDir: path.join(DATA, 'inbox'),                     // drop folder: inbox/manuals, inbox/databases
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 6 * 60 * 1000),
  sessionsDir: path.join(DATA, 'claude-sessions'),        // cwd for claude: keeps app sessions out of your own list
  dbPath: path.join(DATA, 'index.sqlite'),
  pdfDir: process.env.PDF_DIR ? path.resolve(process.env.PDF_DIR) : path.join(DATA, 'pdfs'), // bulk-ingested PDFs
  pagesDir: path.join(DATA, 'pages'),                     // rendered page images (cache)
  python: PYTHON,
  appName: process.env.APP_NAME || 'ManualIQ',
  // one line telling the model what the documents are about, e.g. "home appliances (washers, dryers, fridges)"
  appContext: process.env.APP_CONTEXT || '',
  // example questions shown on the start screen, separated by |
  sampleQuestions: (process.env.SAMPLE_QUESTIONS || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 6),
  logsDir: path.join(DATA, 'logs'),
  stateDir: path.join(DATA, 'state'),
  promptsDir: path.join(ROOT, 'prompts'),
  webDir: path.join(ROOT, 'web'),
  // context budgets in (estimated) tokens
  budget: {
    normal: Number(process.env.BUDGET_TOKENS || 24000),
    more: Number(process.env.BUDGET_MORE_TOKENS || 40000),
    wholeManualMax: Number(process.env.WHOLE_MANUAL_MAX_TOKENS || 60000),
  },
};

for (const d of [config.sessionsDir, config.logsDir, config.stateDir, config.uploadPdfDir, config.uploadDbDir,
  path.join(config.uploadsDir, 'tmp'), path.join(config.inboxDir, 'manuals'), path.join(config.inboxDir, 'databases')]) fs.mkdirSync(d, { recursive: true });

/** Where a manual's PDF lives: uploaded/inbox manuals under uploads/pdfs, the base set under pdfs/. */
export function pdfPath(filename) {
  const up = path.join(config.uploadPdfDir, filename);
  return fs.existsSync(up) ? up : path.join(config.pdfDir, filename);
}
