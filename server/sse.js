// Datastar v1 server-sent events: patch HTML elements and signals in the browser.
export function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, lines) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n` + lines.map(l => `data: ${l}\n`).join('') + '\n');
  };
  return {
    /** Patch elements. Without selector, elements are matched by their id (morph). */
    patchElements(html, { selector, mode } = {}) {
      const lines = [];
      if (selector) lines.push(`selector ${selector}`);
      if (mode) lines.push(`mode ${mode}`);
      for (const l of html.split('\n')) lines.push(`elements ${l}`);
      send('datastar-patch-elements', lines);
    },
    removeElements(selector) { send('datastar-patch-elements', [`selector ${selector}`, 'mode remove']); },
    patchSignals(obj) { send('datastar-patch-signals', [`signals ${JSON.stringify(obj)}`]); },
    close() { if (!res.writableEnded) res.end(); },
  };
}

export async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('body too large'); }
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}
