// The outline in Zen's sidebar: the board of the tab you're on as a tree (a card, then what it needs).
// Live: the background page sends a new outline whenever the map or the active tab changes.
const port = browser.runtime.connect({ name: 'sidebar' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const closed = new Set(JSON.parse(localStorage.getItem('burrow.closed') || '[]'));
let data = null;

function render() {
  const tree = document.getElementById('tree');
  if (!data || !data.board) { tree.innerHTML = '<p class="empty">Burrow isn’t running, or there’s no board yet.</p>'; return; }
  document.getElementById('board').textContent = data.board.name;
  if (data.accent) document.documentElement.style.setProperty('--accent', data.accent);
  const q = document.getElementById('q').value.trim().toLowerCase();
  const open = new Set(data.open || []);
  let total = 0, done = 0;
  // With a filter, keep matching cards and the path to them.
  const keep = (n) => !q || n.title.toLowerCase().includes(q) || n.kids.some(keep);
  const li = (n) => {
    if (!keep(n)) return '';
    if (!n.repeat) { total++; if (n.status === 'done') done++; }
    const kids = n.kids.map(li).join('');
    const isClosed = !q && closed.has(n.id) && n.kids.length;
    return `<li class="s-${esc(n.status)}${n.repeat ? ' rep' : ''}${isClosed ? ' closed' : ''}">` +
      `<div class="row${n.id === data.activeCardId ? ' cur' : ''}" data-id="${esc(n.id)}" title="${esc(n.title)}${n.repeat ? ' (shown above too)' : ''}">` +
      `<span class="tw" data-tw="${n.kids.length ? esc(n.id) : ''}">${n.kids.length ? (isClosed ? '▸' : '▾') : ''}</span>` +
      `<span class="dot d-${esc(n.status)}"></span><span class="t">${esc(n.title || 'Untitled')}</span>${open.has(n.id) ? '<span class="tab" title="Open in a tab"></span>' : ''}</div>` +
      (kids ? `<ul>${kids}</ul>` : '') + '</li>';
  };
  const html = data.roots.map(li).join('');
  tree.innerHTML = html ? `<ul>${html}</ul>` : '<p class="empty">No cards match.</p>';
  document.getElementById('count').textContent = total ? `${done} of ${total} understood` : '';
  const cur = tree.querySelector('.row.cur');
  if (cur && !q) cur.scrollIntoView({ block: 'nearest' });
}

port.onMessage.addListener((m) => { if (m.t === 'outline') { data = m; render(); } });
document.getElementById('q').addEventListener('input', render);
document.getElementById('tree').addEventListener('click', (e) => {
  const tw = e.target.closest('[data-tw]');
  if (tw && tw.dataset.tw) {
    const id = tw.dataset.tw;
    closed.has(id) ? closed.delete(id) : closed.add(id);
    try { localStorage.setItem('burrow.closed', JSON.stringify([...closed])); } catch (err) { /* private storage */ }
    return render();
  }
  const row = e.target.closest('.row');
  if (row) port.postMessage({ t: 'go', cardId: row.dataset.id });
});
