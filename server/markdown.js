// Minimal, safe Markdown -> HTML for chat answers (headings, lists, tables, bold, italics, code, links to PDF pages).
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s, cite) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); // may contain *italics*
  h = h.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  if (cite) h = cite(h);
  return h;
}

/** cite(html) may wrap citations like (AB-2566 p.3) in links. */
export function renderMarkdown(md, { cite } = {}) {
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '', i = 0;
  const listStack = [];
  const closeLists = (depth = 0) => { while (listStack.length > depth) html += `</${listStack.pop()}>`; };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      closeLists();
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim(), cite));
      html += '<div class="table-wrap"><table><thead><tr>' + cells(line).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html += '<tr>' + cells(lines[i]).map(c => `<td>${c}</td>`).join('') + '</tr>'; i++;
      }
      html += '</tbody></table></div>';
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeLists(); const n = Math.min(h[1].length + 2, 6); html += `<h${n}>${inline(h[2], cite)}</h${n}>`; i++; continue; }
    const li = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2) + 1;
      const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length > depth) html += `</${listStack.pop()}>`;
      if (listStack.length < depth) {
        const start = tag === 'ol' ? parseInt(li[2], 10) : 1;
        html += tag === 'ol' && start > 1 ? `<ol start="${start}">` : `<${tag}>`; listStack.push(tag);
      }
      html += `<li>${inline(li[3], cite)}</li>`; i++; continue;
    }
    if (/^\s*$/.test(line)) { closeLists(); i++; continue; }
    if (/^\s*>/.test(line)) { // blockquote (the model uses these for warnings)
      closeLists();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(q.join('\n'), { cite })}</blockquote>`;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeLists(); html += '<hr>'; i++; continue; }
    closeLists();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*•]|\d+[.)])\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    html += `<p>${para.map(p => inline(p, cite)).join('<br>')}</p>`;
  }
  closeLists();
  return html;
}

export { escapeHtml };
