// ManualIQ server: Datastar front end, manual retrieval (hybrid search), SQL agent, router; Claude Code CLI (headless) as the model.
//   node server/index.js        then open http://127.0.0.1:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { stmt, parseManual } from './db.js';
import { retrieve, retrieveMore } from './retrieval.js';
import { embedQuery } from './embed.js';
import { askModel } from './claude.js';
import { SYSTEM_PROMPT, buildPrompt, buildDataPrompt, classifyFollowup } from './prompts.js';
import { getChat, addTurn, updateChat, findTurn, lastQuestionTurn, withChatLock, log, newId } from './chats.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { openSSE, readJson } from './sse.js';
import { citeLinker, findCitations, pageRef, pdfHref, pageImgUrl } from './cite.js';
import { pageImage } from './pages.js';
import { pdfPath } from './config.js';
import { getCatalog } from './catalog.js';
import { routeQuestion } from './router.js';
import { runSqlAgent } from './sql/agent.js';
import { validateSql } from './sql/guard.js';
import { runQuery } from './sql/exec.js';
import { handleUpload, handleIngest, handleSources, handleRemoveSource, ingestInboxOnStart } from './uploads.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.webp': 'image/webp' };

const MSG_ID = /^[A-Za-z0-9_-]{1,40}$/; // message ids sent back by the page (ref=...), checked before they go into HTML

const ACTION_LABEL = { more: 'More detail', shorter: 'Make it shorter', retry: 'Not what I meant, try again' };

// ---------- rendering helpers ----------
function userBubble(text) {
  return `<div class="msg user"><div class="bubble">${escapeHtml(text)}</div></div>`;
}
function botBubble(id) {
  return `<div class="msg bot" id="m-${id}"><div class="bubble">` +
    `<div class="route" id="r-${id}"></div>` +
    `<div class="status" id="st-${id}"><span class="dot"></span>Working out where to look…</div>` +
    `<div class="body" id="b-${id}"></div><div class="sqlres" id="q-${id}"></div><div class="figs" id="f-${id}"></div><div class="sources" id="s-${id}"></div><div class="actions" id="x-${id}"></div>` +
    `</div></div>`;
}
function status(id, text) { return `<div class="status" id="st-${id}"><span class="dot"></span>${escapeHtml(text)}</div>`; }
function hiddenStatus(id) { return `<div class="status hidden" id="st-${id}"></div>`; }

// questions where a picture of the page matters even if the answer cites nothing
const DIAGRAM_Q = /\b(wir(e|ing)|diagram|schematic|drawing|figure|picture|image|layout|terminal|dimension|exploded|parts? (list|breakdown)|looks? like|where is)\b/i;

/** Pages to preview under an answer: the pages it cites; for diagram questions with no citations, drawing pages it was given. */
function pickFigures(text, manuals, question, retrieval) {
  const figs = findCitations(text, manuals, { max: 8 });
  if (figs.length || !retrieval || !DIAGRAM_Q.test(question)) return figs;
  const byId = new Map(manuals.map(m => [m.id, m]));
  for (const s of retrieval.sections) {
    const m = byId.get(s.manual_id);
    if (!m) continue;
    const pages = (m.image_pages || []).filter(p => p >= s.page_start && p <= s.page_end);
    if (s.needs_vision && !pages.length) pages.push(s.page_start);
    for (const p of pages) if (!figs.some(f => f.manual.id === m.id && f.page === p)) figs.push({ manual: m, page: p });
    if (figs.length >= 4) break;
  }
  return figs.slice(0, 4);
}

function figuresHtml(id, figs) {
  if (!figs.length) return `<div class="figs" id="f-${id}"></div>`;
  const items = figs.map(({ manual: m, page }) => {
    const label = `${escapeHtml(String(m.doc_number || '').split(/\s+-\s+|\s+/)[0])} p.${page}`;
    return `<a class="fig" href="${pdfHref(m, page)}" target="_blank" rel="noopener" data-pg="${escapeHtml(pageRef(m, page))}">` +
      `<img loading="lazy" src="${pageImgUrl(m, page, true)}" alt="${label}"><span>${label}</span></a>`;
  }).join('');
  return `<div class="figs" id="f-${id}"><div class="figs-label muted">Pages from the manual · tap to enlarge</div><div class="strip">${items}</div></div>`;
}

function sourcesHtml(id, retrieval, meta) {
  if (!retrieval) return `<div class="sources" id="s-${id}"></div>`;
  const byManual = new Map();
  for (const s of retrieval.sections) {
    if (!byManual.has(s.manual_id)) byManual.set(s.manual_id, []);
    byManual.get(s.manual_id).push(s);
  }
  const cards = new Map([...retrieval.manuals, ...(retrieval.candidates || [])].map(m => [m.id, m]));
  const items = [...byManual].map(([mid, secs]) => {
    const m = cards.get(mid) || {};
    const pages = secs.map(s => s.page_start === s.page_end ? `${s.page_start}` : `${s.page_start}-${s.page_end}`);
    const first = secs[0]?.page_start || 1;
    const pg = m.id ? ` data-pg="${escapeHtml(pageRef(m, first))}"` : '';
    return `<li><a href="/pdf/${encodeURIComponent(m.filename || '')}#page=${first}" target="_blank" rel="noopener"${pg}>` +
      `${escapeHtml(m.doc_number || '')} — ${escapeHtml(m.title || mid)}</a> <span class="muted">v${escapeHtml(m.version || '?')} · pages ${escapeHtml(pages.slice(0, 12).join(', '))}${pages.length > 12 ? '…' : ''}</span></li>`;
  }).join('');
  const how = meta ? `<div class="how muted">${escapeHtml(retrieval.mode)} · ${retrieval.sections.length} sections · ~${Math.round(retrieval.tokens / 100) / 10}k tokens of manual text` +
    (meta.durationMs ? ` · ${(meta.durationMs / 1000).toFixed(1)}s` : '') + (meta.costUsd != null ? ` · $${meta.costUsd.toFixed(3)} equiv.` : '') + '</div>' : '';
  return `<div class="sources" id="s-${id}">${items ? `<details><summary>Sources</summary><ul>${items}</ul>${how}</details>` : ''}</div>`;
}

function actionsHtml(id) {
  const b = (action, label) => `<button class="chip" data-on:click="@post('/chat?action=${action}&ref=${id}')" data-attr:disabled="$busy">${label}</button>`;
  return `<div class="actions" id="x-${id}">${b('more', 'More detail')}${b('shorter', 'Shorter')}${b('retry', 'Not what I meant')}` +
    `<span class="fb" id="fb-${id}"><button class="icon" title="Helpful" data-on:click="@post('/feedback?ref=${id}&v=up')">👍</button>` +
    `<button class="icon" title="Not helpful" data-on:click="@post('/feedback?ref=${id}&v=down')">👎</button></span></div>`;
}

const ROUTE_TEXT = { manuals: 'Manuals', both: 'Both', clarify: 'Clarify' };
function routeHtml(id, r, labels = {}) {
  if (!r) return `<div class="route" id="r-${id}"></div>`;
  const dbLabel = r.database ? labels[r.database] || r.database : '';
  const text = r.route === 'database' ? `Database: ${dbLabel}` : r.route === 'both' && dbLabel ? `Both: manuals + ${dbLabel}` : ROUTE_TEXT[r.route] || r.route;
  const why = `${r.via}${r.reason ? `: ${r.reason}` : ''}`;
  return `<div class="route" id="r-${id}"><span class="tag tag-${escapeHtml(r.route)}" title="${escapeHtml(why)}">${escapeHtml(text)}</span></div>`;
}

const SHOW_ROWS = Number(process.env.SQL_SHOW_ROWS || 20);
function sqlHtml(id, run, labels = {}) {
  if (!run) return `<div class="sqlres" id="q-${id}"></div>`;
  const cell = v => (v === null || v === undefined ? '<span class="muted">NULL</span>' : escapeHtml(String(v)));
  let table = '';
  if (run.executed && run.result) {
    const { columns, rows, truncated, ms } = run.result;
    table = rows.length
      ? `<div class="table-wrap"><table><thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>` +
        rows.slice(0, SHOW_ROWS).map(r => `<tr>${r.map(v => `<td>${cell(v)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>' +
        `<div class="muted small">${rows.length > SHOW_ROWS ? `Showing ${SHOW_ROWS} of ${rows.length} rows` : `${rows.length} row${rows.length === 1 ? '' : 's'}`}` +
        `${truncated ? ' (row limit reached)' : ''} · ${ms} ms</div>`
      : '<div class="muted small">The query returned no rows.</div>';
  }
  const status = run.cannot ? `No query: ${escapeHtml(run.cannot)}` : run.error ? `Query failed: ${escapeHtml(run.error)}`
    : !run.executed ? 'Not executed (SQL_EXECUTE=false)' : '';
  const retried = run.attempts?.length && run.sql
    ? `<div class="muted small">Self-corrected after: ${escapeHtml(run.attempts[0].error || '')}</div>` : '';
  const sqlBlock = run.sql ? `<details class="sql"${run.executed ? '' : ' open'}><summary>SQL · ${escapeHtml(labels[run.database] || run.database || '')}</summary>` +
    `<pre><code>${escapeHtml(run.sql)}</code></pre>${run.wrapped ? '<div class="muted small">Ran with an outer row limit added by the safety check.</div>' : ''}${retried}</details>` : '';
  return `<div class="sqlres" id="q-${id}">${status ? `<div class="sqlstatus">${status}</div>` : ''}${table}${sqlBlock}</div>`;
}

/** Re-run a previous turn's SQL with a bigger row limit ("More detail" on a database answer; no model call). */
async function rerunMore(prev, dbPaths) {
  if (!prev?.sql || !dbPaths[prev.database]) return prev ? { ...prev, executed: false, error: prev.error || 'database no longer loaded' } : null;
  const g = validateSql(prev.sql, { maxRows: 500 });
  try {
    const result = await runQuery(dbPaths[prev.database], g.sql, { maxRows: 500 });
    return { ...prev, runSql: g.sql, wrapped: g.wrapped, result, executed: true, attempts: [] };
  } catch (err) { return { ...prev, executed: false, error: err.message, attempts: [] }; }
}

// ---------- chat turn ----------
async function handleChat(req, res, url) {
  const signals = await readJson(req);
  const sse = openSSE(res);
  const chat = getChat(signals.chatId);
  if (chat.id !== signals.chatId) sse.patchSignals({ chatId: chat.id });

  const typed = String(signals.question || '').trim();
  let action = url.searchParams.get('action');
  const ref = MSG_ID.test(url.searchParams.get('ref') || '') ? url.searchParams.get('ref') : null;
  if (!action) {
    if (!typed) { sse.close(); return; }
    action = chat.turns.length ? classifyFollowup(typed) : 'ask';
  }
  // the question being refined: the one the clicked answer belongs to, else the latest question
  const refTurn = ref ? findTurn(chat, ref) : null;
  const base = refTurn ? (refTurn.baseMsgId ? findTurn(chat, refTurn.baseMsgId) : refTurn) : lastQuestionTurn(chat);
  if (['more', 'shorter', 'retry'].includes(action) && !base) action = 'ask';
  let question = ['more', 'shorter', 'retry'].includes(action) ? base.question : typed;
  const feedback = ['more', 'shorter', 'retry'].includes(action) && typed ? typed : '';
  // the answer to a clarifying question completes the question that was asked
  const lastTurn = chat.turns.at(-1);
  const answeringClarify = !url.searchParams.get('action') && lastTurn?.action === 'clarify';
  if (answeringClarify) { action = 'ask'; question = `${lastTurn.question} (${typed})`; }

  const msgId = newId().slice(0, 8);
  sse.patchElements(userBubble(typed || ACTION_LABEL[action] || action), { selector: '#messages', mode: 'append' });
  sse.patchElements(botBubble(msgId), { selector: '#messages', mode: 'append' });
  sse.patchSignals({ question: '', busy: true });

  await withChatLock(chat.id, async () => {
    const started = Date.now();
    let retrieval = null, sqlRun = null, route = null;
    try {
      const catalog = getCatalog();
      // 0. route: refinements stay on the route of the answer they refine
      if (['more', 'shorter', 'retry'].includes(action)) {
        route = base.route || { route: 'manuals', database: null, via: 'previous', reason: 'manual answer' };
        route = { ...route, via: 'previous', reason: `refining a ${route.route} answer` };
      } else {
        route = await routeQuestion(question, { manuals: catalog.manuals, dbs: catalog.dbs, vocab: catalog.vocab,
                                               prevRoute: action === 'followup' ? base?.route?.route : null });
      }
      sse.patchElements(routeHtml(msgId, route, catalog.labels));

      if (route.route === 'clarify') {
        const text = route.clarify;
        sse.patchElements(hiddenStatus(msgId));
        sse.patchElements(`<div class="body" id="b-${msgId}">${renderMarkdown(text)}</div>`);
        addTurn(chat, { msgId, action: 'clarify', question, route, answer: text, durationMs: Date.now() - started, at: new Date().toISOString() });
        log('turns', { chatId: chat.id, msgId, action: 'clarify', question, route });
        return;
      }
      const useManuals = route.route === 'manuals' || route.route === 'both';
      const useDb = route.route === 'database' || route.route === 'both';

      // 1a. manual retrieval, depending on the kind of turn (PLAN.md 5a)
      const manualJob = async () => {
        if (!useManuals) return null;
        const sentForQuestion = chat.turns.filter(t => t.baseMsgId === (base?.msgId) || t.msgId === base?.msgId).flatMap(t => t.retrieval?.sectionIds || []);
        const searchText = action === 'retry' ? `${question} ${feedback}`.trim() : question;
        const qvec = action === 'shorter' ? null : await embedQuery(searchText).catch(err => { console.error('[embed]', err.message); return null; });
        if (action === 'ask') return retrieve(question, { qvec });
        if (action === 'followup') return retrieve(question, { boostManuals: base?.retrieval?.manualIds || [], qvec });
        if (action === 'more') return retrieveMore(question, { sectionIds: sentForQuestion, manualIds: base?.retrieval?.manualIds || [], qvec });
        if (action === 'retry') return retrieve(searchText, { exclude: sentForQuestion, qvec });
        return null; // shorter: no retrieval, rewrite from what Claude already has
      };
      // 1b. SQL: write + run a query (ask/followup), rewrite it with the feedback (retry), more rows (more)
      const sqlJob = async () => {
        if (!useDb || action === 'shorter') return null;
        if (!catalog.dbs.length) return { cannot: 'no database is loaded any more', executed: false, attempts: [] };
        if (action === 'more') return rerunMore(base.sql, catalog.dbPaths);
        return runSqlAgent({
          question, dbs: catalog.dbs, dbPaths: catalog.dbPaths, hintDb: route.database,
          feedback: action === 'retry' ? feedback : '', previous: action === 'retry' ? base.sql : null,
          onStatus: s => sse.patchElements(status(msgId, s)),
        });
      };
      [retrieval, sqlRun] = await Promise.all([manualJob(), sqlJob()]);

      if (sqlRun) sse.patchElements(sqlHtml(msgId, sqlRun, catalog.labels));
      if (retrieval) {
        const names = retrieval.manuals.map(m => m.doc_number).filter(Boolean).slice(0, 3).join(', ');
        sse.patchElements(status(msgId, retrieval.sections.length
          ? `Reading ${retrieval.sections.length} section(s) from ${names || 'the manuals'}…`
          : chat.started ? 'Looking again at the sections already found…' : 'No matching manual found, asking anyway…'));
      } else {
        sse.patchElements(status(msgId, action === 'shorter' ? 'Rewriting…' : 'Reading the query result…'));
      }

      // SQL_EXECUTE=false on a database-only question: the SQL is the answer, no model call
      const sqlOnly = route.route === 'database' && sqlRun && sqlRun.sql && !sqlRun.executed && !sqlRun.error;
      let text = '', result = {};
      const prompt = useDb && action !== 'shorter'
        ? buildDataPrompt(action, { question, retrieval, sqlRun, feedback })
        : buildPrompt(action, { question, retrieval, feedback });
      // full manual rows (number, pages, filename, drawing pages) for citation links and previews
      const cardIds = retrieval ? [...retrieval.manuals, ...(retrieval.candidates || [])].map(m => m.id)
        : (base?.retrieval?.manualCards || []).map(m => m.id);
      const allManuals = [...new Set(cardIds)].map(mid => parseManual(stmt.manual.get(mid))).filter(Boolean);
      const cite = citeLinker(allManuals);
      const paint = (() => {
        let lastPaint = 0;
        return (force = false) => {
          const now = Date.now();
          if (!force && now - lastPaint < 120) return;
          lastPaint = now;
          sse.patchElements(`<div class="body" id="b-${msgId}">${renderMarkdown(text, { cite })}</div>`);
        };
      })();
      if (sqlOnly) {
        text = 'Query execution is switched off (`SQL_EXECUTE=false`), so here is the SQL that would answer this, without results.';
        paint(true);
      } else {
        // 2. ask Claude (streams back)
        let firstToken = true;
        result = await askModel(prompt, {
          system: SYSTEM_PROMPT,
          sessionId: chat.sessionId,
          resume: chat.started,
          onText: d => { if (firstToken) { firstToken = false; sse.patchElements(hiddenStatus(msgId)); } text += d; paint(); },
        });
        text = result.text || text;
        paint(true);
        updateChat(chat, { started: true, sessionId: result.sessionId || chat.sessionId });
      }
      sse.patchElements(hiddenStatus(msgId));
      const figs = useManuals ? pickFigures(text, allManuals, question, retrieval || (base?.retrieval && { sections: [] })) : [];
      sse.patchElements(figuresHtml(msgId, figs));
      sse.patchElements(sourcesHtml(msgId, retrieval, result));
      sse.patchElements(actionsHtml(msgId));

      // a refinement without new data keeps the base turn's SQL (so "Shorter" then "More detail" still has it)
      const keptSql = sqlRun || (useDb ? base?.sql : null);
      const turn = {
        msgId, action, question, feedback, baseMsgId: action === 'ask' || action === 'followup' ? null : base?.msgId,
        route: { route: route.route, database: route.database, via: route.via, reason: route.reason },
        retrieval: retrieval ? { mode: retrieval.mode, manualIds: retrieval.manuals.map(m => m.id), sectionIds: retrieval.sections.map(s => s.id),
                                  tokens: retrieval.tokens, manualCards: allManuals.map(m => ({ id: m.id, doc_number: m.doc_number, filename: m.filename })) }
          : (useManuals && base?.retrieval) || null,
        sql: keptSql && { database: keptSql.database, sql: keptSql.sql, executed: !!keptSql.executed, error: keptSql.error || null,
                          cannot: keptSql.cannot || null, rows: keptSql.result?.rows.length ?? null, attempts: (keptSql.attempts || []).length },
        figures: figs.map(f => `${f.manual.id}#${f.page}`),
        answer: text, costUsd: result.costUsd, durationMs: Date.now() - started, at: new Date().toISOString(),
      };
      addTurn(chat, turn);
      log('turns', { chatId: chat.id, sessionId: chat.sessionId, model: config.model, ...turn, retrieval: turn.retrieval && { ...turn.retrieval, manualCards: undefined } });
    } catch (err) {
      console.error('[chat]', err);
      sse.patchElements(hiddenStatus(msgId));
      sse.patchElements(`<div class="body error" id="b-${msgId}">Sorry, something went wrong: ${escapeHtml(err.message)}</div>`);
      log('errors', { chatId: chat.id, msgId, action, question, route: route?.route, error: err.message });
      if (/No conversation found|session/i.test(err.message) && chat.started) {
        updateChat(chat, { started: false, sessionId: newId() }); // lost session: start a fresh one next turn
      }
    } finally {
      sse.patchSignals({ busy: false });
      sse.close();
    }
  });
}

async function handleFeedback(req, res, url) {
  const signals = await readJson(req);
  const sse = openSSE(res);
  const chat = getChat(signals.chatId);
  const ref = url.searchParams.get('ref') || '';
  if (!MSG_ID.test(ref)) { sse.close(); return; }
  const v = url.searchParams.get('v') === 'up' ? 'up' : 'down';
  const turn = findTurn(chat, ref);
  if (turn) {
    turn.feedback_vote = v;
    updateChat(chat, {});
    log('feedback', { chatId: chat.id, msgId: ref, vote: v, action: turn.action, question: turn.question, retrieval: turn.retrieval && { ...turn.retrieval, manualCards: undefined } });
  }
  sse.patchElements(`<span class="fb done" id="fb-${ref}">${v === 'up' ? '👍 Thanks!' : '👎 Thanks, noted. Try “Not what I meant” to get another answer.'}</span>`);
  sse.close();
}

async function handleNew(req, res) {
  await readJson(req);
  const sse = openSSE(res);
  const chat = getChat(null);
  sse.patchSignals({ chatId: chat.id, question: '', busy: false });
  sse.patchElements('<div id="messages"></div>');
  sse.close();
}

// ---------- static files ----------
/** index.html with the app name and the example questions from .env filled in. */
function sendIndex(res) {
  const chips = config.sampleQuestions.map(q => {
    const js = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<button class="chip" data-attr:disabled="$busy" data-on:click="$question = '${escapeHtml(js)}'; @post('/chat')">${escapeHtml(q)}</button>`;
  }).join('');
  const html = fs.readFileSync(path.join(config.webDir, 'index.html'), 'utf8')
    .replaceAll('{{APP_NAME}}', escapeHtml(config.appName)).replace('{{SAMPLE_CHIPS}}', chips);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function sendFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let url; // a fixed base: a malformed Host header must not throw here (outside the try it would crash the server)
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
  // refuse POSTs that another website makes the visitor's browser send (CSRF); the app's own page is same-origin
  if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') {
    req.resume(); res.writeHead(403); return res.end('Cross-site request refused');
  }
  try {
    if (req.method === 'POST' && url.pathname === '/chat') return await handleChat(req, res, url);
    if (req.method === 'POST' && url.pathname === '/feedback') return await handleFeedback(req, res, url);
    if (req.method === 'POST' && url.pathname === '/new') return await handleNew(req, res);
    if (req.method === 'POST' && url.pathname === '/upload') return await handleUpload(req, res, url);
    if (req.method === 'POST' && url.pathname === '/ingest') return await handleIngest(req, res, url);
    if (url.pathname === '/sources' && (req.method === 'GET' || req.method === 'POST')) return await handleSources(req, res);
    if (req.method === 'POST' && url.pathname === '/sources/remove') return await handleRemoveSource(req, res, url);
    if (req.method === 'GET' && url.pathname === '/') return sendIndex(res);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...stmt.stats.get(), model: config.model }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/pdf/')) {
      const name = decodeURIComponent(url.pathname.slice(5));
      const m = stmt.manualByFilename.get(name); // only files that are in the index — no path traversal
      if (!m) { res.writeHead(404); return res.end('Not found'); }
      return sendFile(res, pdfPath(m.filename), { 'Content-Disposition': `inline; filename="${m.filename.replace(/"/g, '')}"` });
    }
    const pm = req.method === 'GET' && url.pathname.match(/^\/page\/([^/]+)\/(\d+)(\.thumb)?\.webp$/);
    if (pm) { // page image, rendered on first request; only manuals in the index, only real pages
      const m = stmt.manual.get(decodeURIComponent(pm[1]));
      const n = Number(pm[2]);
      if (!m || n < 1 || n > m.pages) { res.writeHead(404); return res.end('Not found'); }
      try {
        const file = await pageImage(m, n, { thumb: !!pm[3] });
        return sendFile(res, file, { 'Cache-Control': 'public, max-age=604800' });
      } catch (err) {
        console.error('[page]', err.message);
        res.writeHead(500); return res.end('Could not render page');
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
      const file = path.normalize(path.join(config.webDir, url.pathname.slice('/static/'.length)));
      if (!file.startsWith(config.webDir + path.sep)) { res.writeHead(403); return res.end(); }
      return sendFile(res, file);
    }
    res.writeHead(404); res.end('Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// one failed request or background job must not take the whole server down
process.on('unhandledRejection', err => console.error('[unhandled]', err));

server.listen(config.port, config.host, () => {
  const s = stmt.stats.get();
  console.log(`${config.appName} on http://${config.host}:${config.port}`);
  console.log(`  index: ${s.manuals} manuals, ${s.sections} sections, ${s.chunks} chunks`);
  console.log(`  model: ${config.model} (SQL ${config.sqlModel}, router ${config.routerModel}) via ${config.claudeBin}`);
  const c = getCatalog();
  console.log(`  databases: ${c.dbs.map(d => d.name).join(', ') || 'none'} · SQL_EXECUTE=${config.sqlExecute}`);
  ingestInboxOnStart(); // data/inbox/{manuals,databases}: new or changed files, in the background
});
