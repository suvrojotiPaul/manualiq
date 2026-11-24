// Builds the user message sent to Claude for each kind of turn (PLAN.md sections 5 and 5a).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { rowsTable } from './sql/agent.js';

export const SYSTEM_PROMPT = fs.readFileSync(path.join(config.promptsDir, 'system.md'), 'utf8')
  .replace('{{APP_CONTEXT}}', config.appContext ? ` They are about: ${config.appContext}.` : '');

const esc = s => String(s ?? '').replace(/"/g, "'");

export function contextBlock(retrieval) {
  if (!retrieval.sections.length) {
    return '<manual_context>\n(no new manual sections for this turn. If the manual content given earlier in this conversation ' +
      'applies, use it; otherwise say the manuals you have do not cover this.)\n</manual_context>';
  }
  const byManual = new Map();
  for (const s of retrieval.sections) {
    if (!byManual.has(s.manual_id)) byManual.set(s.manual_id, []);
    byManual.get(s.manual_id).push(s);
  }
  const cards = new Map([...retrieval.manuals, ...(retrieval.candidates || [])].map(m => [m.id, m]));
  let out = '<manual_context>\n';
  for (const [mid, secs] of byManual) {
    const m = cards.get(mid) || { id: mid };
    out += `<manual number="${esc(m.doc_number)}" version="${esc(m.version)}" title="${esc(m.title)}" models="${esc((m.models || []).join(', '))}" total_pages="${m.pages ?? ''}">\n`;
    if (m.description) out += `<description>${m.description}</description>\n`;
    for (const s of secs) {
      out += `<section id="${s.id}" path="${esc(s.path)}" pages="${s.page_start}-${s.page_end}">\n${s.text}\n</section>\n`;
    }
    out += '</manual>\n';
  }
  out += '</manual_context>';
  return out;
}

function otherCandidates(retrieval) {
  const used = new Set(retrieval.sections.map(s => s.manual_id));
  const others = (retrieval.candidates || []).filter(c => !used.has(c.id)).slice(0, 4);
  if (!others.length) return '';
  return '\n<other_possibly_relevant_manuals>\n' +
    others.map(c => `- ${c.doc_number} v${c.version}: ${c.title}${c.models?.length ? ` (models: ${c.models.join(', ')})` : ''}`).join('\n') +
    '\n</other_possibly_relevant_manuals>';
}

export function buildPrompt(action, { question, retrieval, feedback }) {
  switch (action) {
    case 'more':
      return `${contextBlock(retrieval)}\n\n<request>The user wants MORE than your previous answer gave${feedback ? `: "${feedback}"` : ''}. ` +
        `Additional manual sections are above. Expand the answer: add the missing steps, details, related warnings, specs or parts. ` +
        `Continue from where the previous answer stopped instead of repeating it, unless repeating a step is needed for clarity.</request>`;
    case 'shorter':
      return `<request>The user wants a SHORTER answer${feedback ? `: "${feedback}"` : ''}. Rewrite your previous answer much more concisely: ` +
        `keep the essential steps and values and the most important safety warning(s) (shortened), drop explanations. Keep the citations.</request>`;
    case 'retry':
      return `${contextBlock(retrieval)}${otherCandidates(retrieval)}\n\n<request>The user said your previous answer was NOT what they were looking for` +
        `${feedback ? `: "${feedback}"` : ''}. Their original question was: "${question}". ` +
        `Different manual sections are above (the ones used before were left out on purpose). Work out what they most likely meant and answer that. ` +
        `If it is still ambiguous, ask ONE short clarifying question that lists the concrete options (manual number + model/variant).</request>`;
    case 'followup':
      return `${contextBlock(retrieval)}${otherCandidates(retrieval)}\n\n<question>${question}</question>\n` +
        `(This is a follow-up in the same conversation; earlier context still applies.)`;
    default:
      return `${contextBlock(retrieval)}${otherCandidates(retrieval)}\n\n<question>${question}</question>`;
  }
}

/** The SQL that ran and its rows (or why there are none), for answers that use a database. */
/** Sums of all-numeric columns (not ids), so the answer doesn't have to add numbers up itself. */
export function columnSums(result) {
  if (!result || result.rows.length < 2) return '';
  const out = [];
  result.columns.forEach((c, i) => {
    if (/(^|_)id$/i.test(c) || /avg|average|mean|median|ratio|rate|pct|percent|share|min|max|year|month|day|date|price/i.test(c)) return;
    const vals = result.rows.map(r => r[i]);
    if (!vals.every(v => typeof v === 'number')) return;
    const s = vals.reduce((a, b) => a + b, 0);
    out.push(`${c}=${Math.round(s * 1000) / 1000}`);
  });
  return out.join(', ');
}

export function databaseBlock(run, { maxRows = 50 } = {}) {
  if (!run) return '';
  const attrs = `database="${esc(run.database)}" executed="${!!run.executed}"` +
    (run.result ? ` rows_returned="${run.result.rows.length}" truncated="${!!run.result.truncated}"` : '');
  let body = '';
  if (run.cannot) body = `The SQL agent found the data cannot answer this: ${run.cannot}`;
  else if (run.error) body = `The query failed: ${run.error}\n<sql>${run.sql || ''}</sql>`;
  else if (!run.executed) body = `<sql>${run.sql}</sql>\n(Query execution is switched off in this app (SQL_EXECUTE=false): no rows. Tell the user the query was written but not run.)`;
  else {
    body = `<sql>${run.sql}</sql>\n` + (run.result.rows.length ? rowsTable(run.result, maxRows) : '(no rows)');
    if (run.result.rows.length > maxRows) body += `\n(${run.result.rows.length - maxRows} more rows not shown here)`;
    const sums = columnSums(run.result);
    if (sums) body += `\n<column_sums note="computed by the app over all ${run.result.rows.length} returned rows. If you state a total, use these instead of adding up yourself; otherwise ignore them and do not mention them">${sums}</column_sums>`;
  }
  return `<database_result ${attrs}>\n${body}\n</database_result>`;
}

/** Prompt for turns that use a database (route 'database' or 'both'). */
export function buildDataPrompt(action, { question, retrieval, sqlRun, feedback }) {
  const manual = retrieval ? `${contextBlock(retrieval)}${otherCandidates(retrieval)}\n\n` : '';
  const data = databaseBlock(sqlRun, { maxRows: action === 'more' ? 200 : 50 });
  switch (action) {
    case 'more':
      return `${manual}${data}\n\n<request>The user wants MORE detail than your previous answer gave${feedback ? `: "${feedback}"` : ''}. ` +
        `Use the full result above (and the manual sections, if any): give the breakdown, notable rows and patterns. Keep it readable.</request>`;
    case 'retry':
      return `${manual}${data}\n\n<request>The user said your previous answer was NOT what they meant${feedback ? `: "${feedback}"` : ''}. ` +
        `Their original question was: "${question}". A new query was written with that in mind; answer from its result.</request>`;
    case 'followup':
      return `${manual}${data}\n\n<question>${question}</question>\n(This is a follow-up in the same conversation; earlier context still applies.)`;
    default:
      return `${manual}${data}\n\n<question>${question}</question>`;
  }
}

/** Quick intent check for typed follow-ups (PLAN.md 5a). Claude also sees the history, so this only steers retrieval. */
export function classifyFollowup(text) {
  const t = text.toLowerCase().trim();
  if (/^(more|go on|continue|keep going|and then\??|what next\??|next)\b|more detail|in detail|elaborate|full (steps|procedure)|all (the )?steps|not (enough|everything)|that'?s not all|incomplete/.test(t)) return 'more';
  if (/^(shorter|tl;?dr|summari[sz]e)|too long|shorter|brief(ly)?|just the steps|in short|summary/.test(t)) return 'shorter';
  if (/^(no\b|nope|wrong|try again|not (it|that|this|what|quite|exactly))|not what i|doesn'?t (help|answer)|didn'?t (help|answer)|wrong (one|manual|model)|that'?s not/.test(t)) return 'retry';
  return 'followup';
}
