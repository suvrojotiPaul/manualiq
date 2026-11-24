// "Ask the model" adapter: runs the local Claude Code CLI headless. It uses ANTHROPIC_API_KEY (or Bedrock / Vertex
// settings) from .env when set, otherwise your Claude Code login; the CLI inherits this process's environment.
// Keep this the only place that knows how a model is called, so an API / Ollama adapter can replace it later.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config } from './config.js';

/**
 * askModel(prompt, { system, sessionId, resume, model, onText }) -> Promise<{ text, sessionId, costUsd, usage, durationMs }>
 *  - first turn of a chat: pass sessionId (new UUID) and resume=false  -> `--session-id <uuid>`
 *  - follow-ups:           pass the same sessionId and resume=true     -> `--resume <uuid>`
 *  - onText(delta) is called as answer text streams in
 */
export function askModel(prompt, { system, sessionId, resume = false, model = config.model, onText = () => {}, signal } = {}) {
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode',            // no CLAUDE.md, skills, plugins, hooks or MCP servers from your own setup
    '--strict-mcp-config',    // ...and no MCP servers at all
    '--tools', '',            // answering needs no tools (no file edits, no shell)
  ];
  if (system) args.push('--system-prompt', system);
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(config.claudeBin, args, { cwd: config.sessionsDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', streamed = false, result = null, stderr = '', settled = false;
    const finish = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Claude timed out after ${config.claudeTimeoutMs / 1000}s`)); }, config.claudeTimeoutMs);
    signal?.addEventListener('abort', () => { child.kill(); finish(new Error('cancelled')); });

    readline.createInterface({ input: child.stdout }).on('line', line => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        streamed = true; text += ev.event.delta.text; onText(ev.event.delta.text);
      } else if (ev.type === 'assistant' && !streamed) { // fallback if partial messages aren't emitted
        for (const b of ev.message?.content || []) if (b.type === 'text' && b.text) { text += b.text; onText(b.text); }
      } else if (ev.type === 'result') {
        result = ev;
      }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => finish(new Error(`Could not start Claude CLI at ${config.claudeBin}: ${err.message}`)));
    child.on('close', code => {
      if (result && !result.is_error) {
        finish(null, { text: text || result.result || '', sessionId: result.session_id, costUsd: result.total_cost_usd,
                       usage: result.usage, durationMs: Date.now() - started });
      } else {
        const msg = result?.result || stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
        finish(new Error(`Claude CLI failed: ${msg}`));
      }
    });
    child.stdin.end(prompt); // prompt via stdin: no command-line length limit (Windows caps args at ~32k chars)
  });
}
