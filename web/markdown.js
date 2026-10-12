// Markdown for card pages. A note is a list of blocks, one per line, except fenced code and tables,
// which stay whole. The page shows every block rendered and edits one at a time, so parse() and
// serialize() round-trip: what you type is what is saved.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurrowMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const depth = (ws) => Math.floor(ws.replace(/\t/g, '    ').length / 2);

  // A block: { type: p | h | ul | ol | todo | quote | code | hr | table, text, level (h), indent, marker (ul, todo),
  // num (ol), checked (todo), lang (code) }. `text` is the inline Markdown (raw source for code and tables).
  function parseLine(line) {
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) return { type: 'h', level: m[1].length, text: m[2] };
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return { type: 'hr', text: '' };
    if ((m = line.match(/^(\s*)([-*+])\s+\[([ xX])\](?:\s(.*))?$/))) return { type: 'todo', indent: depth(m[1]), marker: m[2], checked: m[3] !== ' ', text: m[4] || '' };
    if ((m = line.match(/^(\s*)([-*+])\s(.*)$/))) return { type: 'ul', indent: depth(m[1]), marker: m[2], text: m[3] };
    if ((m = line.match(/^(\s*)(\d{1,9})[.)]\s(.*)$/))) return { type: 'ol', indent: depth(m[1]), num: +m[2], text: m[3] };
    if ((m = line.match(/^>\s?(.*)$/))) return { type: 'quote', text: m[1] };
    return { type: 'p', text: line };
  }

  function parse(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].match(/^\s*(`{3,}|~{3,})\s*([^`\s]*)\s*$/);
      if (f) {
        const close = new RegExp('^\\s*' + (f[1][0] === '`' ? '`' : '~') + '{' + f[1].length + ',}\\s*$');
        const body = [];
        let j = i + 1;
        while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
        out.push({ type: 'code', lang: f[2], text: body.join('\n') });
        i = j;
        continue;
      }
      if (/^\s*\|/.test(lines[i])) {
        const rows = [lines[i]];
        while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
        out.push({ type: 'table', text: rows.join('\n') });
        continue;
      }
      out.push(parseLine(lines[i]));
    }
    return out;
  }

  const LISTS = new Set(['ul', 'ol', 'todo']);
  // Display numbers for numbered items: a run continues past deeper items and blank lines.
  function numbering(blocks) {
    let run = [];
    return blocks.map((b) => {
      const d = b.indent || 0;
      if (b.type === 'ol') { const n = run[d] != null ? run[d] + 1 : (b.num || 1); run.length = d + 1; run[d] = n; return n; }
      if (LISTS.has(b.type)) { run.length = d + 1; run[d] = null; return null; }
      if (!(b.type === 'p' && !b.text)) run = [];
      return null;
    });
  }

  // The Markdown in front of a block's text, e.g. "  - [ ] " or "## ".
  function prefix(b, num) {
    const pad = '  '.repeat(b.indent || 0);
    switch (b.type) {
      case 'h': return '#'.repeat(b.level || 1) + ' ';
      case 'ul': return pad + (b.marker || '-') + ' ';
      case 'todo': return pad + (b.marker || '-') + ' [' + (b.checked ? 'x' : ' ') + '] ';
      case 'ol': return pad + (num || b.num || 1) + '. ';
      case 'quote': return '> ';
      case 'code': return '```' + (b.lang || '') + '\n';
      default: return '';
    }
  }
  function lineOf(b, num) {
    if (b.type === 'hr') return '---';
    if (b.type === 'code') return prefix(b) + (b.text ? b.text + '\n' : '') + '```';
    if (b.type === 'quote' && !b.text) return '>';
    return prefix(b, num) + b.text;
  }
  function serialize(blocks) {
    const nums = numbering(blocks);
    return blocks.map((b, i) => lineOf(b, nums[i])).join('\n');
  }
  // Where block `i`, offset `at` in its text, lands in the serialized note (and back).
  function offsetOf(blocks, i, at) {
    const nums = numbering(blocks);
    let pos = 0;
    for (let k = 0; k < i; k++) pos += lineOf(blocks[k], nums[k]).length + 1;
    return pos + (blocks[i] && blocks[i].type !== 'hr' ? prefix(blocks[i], nums[i]).length : 0) + at;
  }
  function blockAt(blocks, offset) {
    const nums = numbering(blocks);
    let pos = 0;
    for (let k = 0; k < blocks.length; k++) {
      const len = lineOf(blocks[k], nums[k]).length;
      if (offset <= pos + len) {
        const pre = blocks[k].type === 'hr' ? 0 : prefix(blocks[k], nums[k]).length;
        return { i: k, at: Math.max(0, Math.min(blocks[k].text.length, offset - pos - pre)) };
      }
      pos += len + 1;
    }
    return { i: blocks.length - 1, at: 'end' };
  }

  // ---------- inline ----------
  const safeUrl = (u) => /^(https?:|mailto:)/i.test(u);
  // **bold**, *italic*, ~~strike~~, ==highlight==, `code`, [link](url), bare URLs, ![image](url) and
  // [[Card title]] links to other cards.
  function inline(src, noLinks) {
    const stash = [];
    const put = (html) => '\u0000' + (stash.push(html) - 1) + '\u0000';
    let s = esc(src);
    s = s.replace(/`([^`]+)`/g, (m, c) => put(`<code>${c}</code>`));
    if (!noLinks) {
      s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (m, t, alias) => put(`<a class="wiki" data-card="${t.trim()}">${inline(alias || t, true)}</a>`));
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => (safeUrl(url) ? put(`<img src="${url}" alt="${alt}">`) : m));
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) => (safeUrl(url) ? put(`<a href="${url}" target="_blank" rel="noopener">${inline(t, true)}</a>`) : m));
      s = s.replace(/\bhttps?:\/\/[^\s<\u0000]+[^\s<\u0000.,;:!?)\]'"]/g, (url) => put(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
    }
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
    for (let k = 0; k < 3 && s.includes('\u0000'); k++) s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => stash[+n]);
    return s;
  }

  function tableHtml(src) {
    const rows = src.split('\n').map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
    const sep = rows.length > 1 && rows[1].every((c) => /^:?-{1,}:?$/.test(c));
    const head = sep ? rows[0] : null;
    const body = sep ? rows.slice(2) : rows;
    return '<table>' + (head ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '') +
      `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  // Map a caret position in rendered text back to the source: walk the source, skipping the Markdown.
  function sourceOffset(src, shown, n) {
    let i = 0;
    for (let k = 0; k < n && k < shown.length; k++) {
      const j = src.indexOf(shown[k], i);
      if (j < 0) return src.length;
      i = j + 1;
    }
    return i;
  }

  // The plain text of a note, for search and previews.
  function plain(src) {
    return parse(src).map((b) => (b.type === 'hr' ? '' : b.type === 'code' || b.type === 'table' ? b.text : b.text
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, a) => a || t).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|==|`)/g, '').replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2'))).join('\n').trim();
  }

  return { parse, parseLine, serialize, numbering, prefix, lineOf, offsetOf, blockAt, inline, tableHtml, sourceOffset, plain, esc, LISTS };
});
