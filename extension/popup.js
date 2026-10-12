// The toolbar popup: this tab's card (with a quick note) and the commands, each with its shortcut.
// ↑/↓ and Enter run a command; Ctrl+Enter in the note box adds the note.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyHtml = (k) => (k ? String(k).split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('') : '');
// Same colors as the app, so a tag looks the same everywhere.
const TAG_COLORS = ['#b8a4ff', '#7ef0c0', '#ffb48a', '#ff9fc8', '#86d4ff', '#eef08a', '#ff8f8f', '#79e6e6'];
const tagColor = (t) => { let h = 0; for (const ch of t.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0; return TAG_COLORS[h % TAG_COLORS.length]; };
const ICON = { notes: '▤', done: '✓', up: '↑', unrelated: '×', 'capture-page': '+', palette: '⌕', sidebar: '☰', 'open-app': '↗' };

let data = null, rows = [], active = -1;

async function load() {
  data = await browser.runtime.sendMessage({ t: 'popup' });
  if (data.accent) document.documentElement.style.setProperty('--accent', data.accent);
  render();
}

function render() {
  const d = data, k = d.keys || {};
  $('#board').textContent = d.board ? '· ' + d.board : '';
  $('#conn').classList.toggle('off', !d.online);
  $('#conn').title = d.online ? 'Connected to Burrow' : 'Burrow isn’t running';
  let html = '';
  const items = [];
  if (!d.online) {
    html += '<div class="off-msg">Burrow isn’t running. Start it with<br><code>systemctl --user start burrow</code></div>';
  } else if (d.bound && d.card) {
    const c = d.card, up = d.trail.slice(0, -1);
    html += `<section class="card">${up.length ? `<div class="trail">${up.map((x) => esc(x.title)).join(' / ')}</div>` : ''}` +
      `<div class="title"><span class="dot s-${esc(c.status)}"></span><span>${esc(c.title)}</span></div>` +
      (c.tags.length ? `<div class="tags">${c.tags.map((t) => `<span class="tag" style="--tag:${tagColor(t)}">${esc(t)}</span>`).join('')}</div>` : '') +
      (c.note.trim() ? `<div class="preview">${esc(c.note.trim().split('\n').slice(-3).join('\n'))}</div>` : '') +
      `<textarea id="note" placeholder="Jot a note for “${esc(c.title)}”…"></textarea>` +
      `<div class="note-foot"><span id="hint">${keyHtml('Ctrl+Enter')} adds it to the notes</span><button class="btn" id="add" disabled>Add note</button></div></section>`;
    items.push(['notes', 'Open the notes in Burrow'], ['done', 'Understood, go to the next one']);
    if (up.length) items.push(['up', `Up to “${up[up.length - 1].title}”`]);
    items.push(['unrelated', 'Not related, remove it']);
  } else if (d.tab && d.tab.page) {
    const target = d.trail[d.trail.length - 1];
    html += `<section class="card"><div class="muted">This page isn’t on the map.</div>${target ? `<div class="trail" style="margin:4px 0 0">Adding goes under “${esc(target.title)}”</div>` : ''}</section>`;
    items.push(['capture-page', 'Add this page to the map']);
  }
  if (items.length) items.push(['g']);
  items.push(['palette', 'Search cards, make one'], ['sidebar', 'Outline in the sidebar'], ['open-app', 'Open Burrow']);
  const keyOf = { sidebar: '_execute_sidebar_action' };
  html += '<ul>' + items.map(([name, label]) => (name === 'g' ? '<li class="g"></li>' :
    `<li class="row" data-run="${name}"><span class="ic">${ICON[name] || '›'}</span><span class="lb">${esc(label)}</span>` +
    `<span class="k">${keyHtml(k[keyOf[name] || name])}</span></li>`)).join('') + '</ul>';
  html += `<footer><button data-run="toggle-breadcrumb" title="${esc(k['toggle-breadcrumb'] || '')}">Breadcrumb <b>${d.settings.crumb ? 'on' : 'off'}</b></button>` +
    `<button data-run="focus" title="Hide tabs off the current trail">Focus mode <b>${d.settings.focus === 'off' ? 'off' : 'on'}</b></button>` +
    '<button class="gear" data-run="options" title="Settings">⚙</button></footer>';
  $('#main').innerHTML = html;
  rows = [...document.querySelectorAll('li.row')];
  const note = $('#note');
  if (note) {
    note.addEventListener('input', () => { $('#add').disabled = !note.value.trim(); note.style.height = 'auto'; note.style.height = Math.min(180, Math.max(64, note.scrollHeight + 2)) + 'px'; });
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); }
      if (e.key === 'Escape') { e.preventDefault(); window.close(); }
    });
    $('#add').addEventListener('click', addNote);
    note.focus();
  }
}

async function addNote() {
  const note = $('#note'), text = note.value.trim();
  if (!text || !data.card) return;
  $('#add').disabled = true;
  const r = await browser.runtime.sendMessage({ t: 'popupNote', cardId: data.card.id, text, tabId: data.tab.id });
  if (!r || !r.ok) { $('#hint').textContent = 'Couldn’t reach Burrow'; $('#add').disabled = false; return; }
  window.close();
}

function run(name) {
  // These two need the click itself (a user action) to be allowed.
  if (name === 'sidebar') browser.sidebarAction.open();
  else if (name === 'options') browser.runtime.openOptionsPage();
  else browser.runtime.sendMessage({ t: 'popupRun', name, tabId: data.tab ? data.tab.id : null });
  window.close();
}

function paint() { rows.forEach((r, i) => r.classList.toggle('on', i === active)); }
document.addEventListener('click', (e) => { const r = e.target.closest('li.row, footer button'); if (r) run(r.dataset.run); });
document.addEventListener('mousemove', (e) => { const r = e.target.closest('li.row'); const i = rows.indexOf(r); if (r && i !== active) { active = i; paint(); } });
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'note' && !(e.key === 'ArrowDown' && e.target.selectionStart === e.target.value.length)) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (e.target.id === 'note') e.target.blur();
    active = active < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    paint();
  } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); run(rows[active].dataset.run); }
  else if (e.key === 'Escape') window.close();
});

load();
