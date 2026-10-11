// Burrow on every page: the breadcrumb pill, the "add this page?" prompt and toasts.
// Everything lives in one closed Shadow DOM so the site's CSS can't touch it (and ours can't leak).
(() => {
  if (window.top !== window || window.__burrow) return;
  window.__burrow = true;
  if (/^http:\/\/(127\.0\.0\.1|localhost):7417\//.test(location.href)) return; // the Burrow app itself

  const port = browser.runtime.connect({ name: 'burrow' });
  let view = null, prompt = null;

  const host = document.createElement('burrow-ui');
  host.style.cssText = 'all: initial; position: fixed; inset: auto auto 0 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { --bg: rgba(17,17,20,.92); --bg-solid: #111114; --line: rgba(255,255,255,.09); --text: #ececf1; --text-2: #a4a4b0; --text-3: #6e6e7a;
      --todo: #8fb8ff; --doing: #f6d97a; --done: #5f5f69; --parked: #9a8f80; --accent: #b8a4ff; }
    * { box-sizing: border-box; }
    .stack { position: fixed; left: 14px; bottom: 14px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
      font: 12.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
    .pill, .box { pointer-events: auto; background: var(--bg); border: 1px solid var(--line); backdrop-filter: blur(14px) saturate(1.3);
      box-shadow: 0 8px 28px rgba(0,0,0,.35); }
    .pill { display: flex; align-items: center; gap: 2px; max-width: min(760px, calc(100vw - 28px)); height: 28px; padding: 0 10px 0 6px;
      border-radius: 999px; overflow: hidden; background: rgba(17,17,20,.94); }
    .pill:not(:hover) .seg:not(.cur) { color: var(--text-3); }
    .pill[hidden], .box[hidden] { display: none; }
    .seg { all: unset; display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 999px; cursor: pointer;
      color: var(--text-2); white-space: nowrap; min-width: 0; }
    .seg .t { overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
    .seg:hover { background: rgba(255,255,255,.07); color: var(--text); }
    .seg.cur { color: var(--text); font-weight: 600; }
    .seg.cur .t { max-width: 260px; }
    .sep { color: var(--text-3); padding: 0 1px; }
    .more { color: var(--text-3); padding: 0 4px; }
    .depth { color: var(--text-3); white-space: nowrap; padding-left: 6px; font-variant-numeric: tabular-nums; }
    .target { color: var(--text-3); white-space: nowrap; padding: 0 4px 0 4px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    .s-todo { background: var(--todo); } .s-doing { background: var(--doing); }
    .s-done { border: 1.5px solid var(--done); } .s-parked { border: 1.5px dashed var(--parked); }
    .open { box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 45%, transparent); }
    .box { border-radius: 12px; padding: 11px 13px; max-width: min(440px, calc(100vw - 28px)); outline: none; background: rgba(17,17,20,.94); }
    .box:focus { border-color: color-mix(in oklab, var(--accent) 60%, transparent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent), 0 8px 28px rgba(0,0,0,.35); }
    .q { font-size: 13.5px; line-height: 1.4; }
    .q b { font-weight: 600; }
    .note { color: var(--text-2); margin-top: 3px; }
    .keys { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 9px; color: var(--text-2); }
    .keys button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
    .keys button:hover { color: var(--text); }
    kbd { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); background: rgba(255,255,255,.08);
      border: 1px solid var(--line); border-radius: 5px; padding: 3px 5px; }
    .fading { transition: opacity 1.2s ease; opacity: .55; }
    .toast { display: flex; align-items: center; gap: 12px; }
    .toast .act { all: unset; cursor: pointer; color: var(--accent); white-space: nowrap; display: inline-flex; gap: 6px; align-items: center; }
    .in { animation: in .16s ease-out; }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
  </style>
  <div class="stack">
    <div class="box" id="prompt" tabindex="-1" hidden></div>
    <div class="box toast" id="toast" tabindex="-1" hidden></div>
    <div class="pill" id="pill" hidden></div>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyHtml = (k) => (k ? String(k).split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('') : '');

  // ---------- breadcrumb ----------
  const fullscreen = () => !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches;
  function renderPill() {
    const pill = $('#pill');
    if (!view || !view.show || !view.trail.length || fullscreen()) { pill.hidden = true; return; }
    if (view.accent) host.style.setProperty('--accent', view.accent);
    let items = view.trail.map((c, i) => ({ c, i }));
    // Long trails keep the top card and the last two.
    if (items.length > 4) items = [items[0], null, ...items.slice(-2)];
    const last = view.trail.length - 1;
    pill.innerHTML = (view.bound ? '' : '<span class="target" title="This tab isn’t on the map. Pages you add go under the card on the right.">Adding under</span>') +
      items.map((it, k) => {
        const sep = k ? '<span class="sep">/</span>' : '';
        if (!it) return sep + '<span class="more">…</span>';
        const { c, i } = it;
        return sep + `<button class="seg${i === last ? ' cur' : ''}" data-id="${esc(c.id)}" title="${esc(c.title)}${c.open ? ' (open in a tab)' : c.url ? ' (opens its page)' : ''}">` +
          `<span class="dot s-${esc(c.status)}${c.open ? ' open' : ''}"></span><span class="t">${esc(c.title || 'Untitled')}</span></button>`;
      }).join('') + (view.bound ? `<span class="depth">· ${view.trail.length} deep</span>` : '');
    pill.hidden = false;
  }
  $('#pill').addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (b) port.postMessage({ t: 'go', cardId: b.dataset.id });
  });
  document.addEventListener('fullscreenchange', renderPill);
  matchMedia('(display-mode: fullscreen)').addEventListener('change', renderPill);

  // ---------- prompt ----------
  // Takes focus when shown so Enter / Shift+Enter / Esc answer it. Clicking into the page gives focus back;
  // the prompt then stays a little while and fades out, which counts as ignoring it.
  let fadeT = null;
  function showPrompt(p) {
    prompt = p;
    const box = $('#prompt');
    box.innerHTML = `<div class="q">Add <b>“${esc(p.title)}”</b> under <b>“${esc(p.parent)}”</b>?</div>` +
      (p.note ? `<div class="note">${esc(p.note)}</div>` : '') +
      `<div class="keys"><button data-c="child">${keyHtml('↵')} Add</button><button data-c="sibling">${keyHtml('⇧+↵')} Next to “${esc(p.parent)}”</button>` +
      `<button data-c="ignore">${keyHtml('Esc')} Ignore</button></div>`;
    box.hidden = false; box.classList.remove('fading'); box.classList.add('in');
    clearTimeout(fadeT);
    box.focus({ preventScroll: true });
  }
  function answer(choice) {
    if (!prompt) return;
    prompt = null; clearTimeout(fadeT);
    $('#prompt').hidden = true;
    port.postMessage({ t: 'answer', choice });
  }
  $('#prompt').addEventListener('keydown', (e) => {
    if (!prompt) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); answer(e.shiftKey ? 'sibling' : 'child'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer('ignore'); }
  });
  $('#prompt').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-c]');
    if (b) return answer(b.dataset.c);
    clearTimeout(fadeT); $('#prompt').classList.remove('fading'); $('#prompt').focus({ preventScroll: true });
  });
  $('#prompt').addEventListener('blur', () => {
    if (!prompt) return;
    $('#prompt').classList.add('fading');
    clearTimeout(fadeT);
    fadeT = setTimeout(() => answer('timeout'), 10000);
  });

  // ---------- toasts ----------
  let toastT = null;
  function showToast(t) {
    const box = $('#toast');
    const act = t.undo ? `<button class="act" data-a="undo">Undo ${keyHtml(t.undo)}</button>`
      : t.redo ? `<button class="act" data-a="redo">Redo ${keyHtml(t.redo)}</button>` : '';
    box.innerHTML = `<span>${esc(t.text)}</span>${act}`;
    box.hidden = false; box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
    clearTimeout(toastT);
    toastT = setTimeout(() => { box.hidden = true; }, t.undo ? 7000 : 3500);
  }
  $('#toast').addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (a) { port.postMessage({ t: a.dataset.a }); $('#toast').hidden = true; }
    else $('#toast').focus({ preventScroll: true });
  });
  // With the toast focused (click it), Z undoes.
  $('#toast').addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'z' && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); port.postMessage({ t: 'undo' }); $('#toast').hidden = true; }
  });

  // ---------- shortcuts ----------
  // Sites define Alt+Shift accesskeys (Wikipedia: Alt+Shift+P prints, U uploads) and those beat extension
  // shortcuts. Catch ours first; the background runs the command (the browser's own copy is then skipped).
  function matches(e, shortcut) {
    const parts = shortcut.split('+');
    const key = parts.pop();
    const want = { Alt: false, Shift: false, Ctrl: false, MacCtrl: false, Command: false };
    for (const p of parts) want[p] = true;
    if (e.altKey !== want.Alt || e.shiftKey !== want.Shift || e.ctrlKey !== (want.Ctrl || want.MacCtrl) || e.metaKey !== want.Command) return false;
    if (!(want.Alt || want.Ctrl || want.Command)) return false; // never take plain typing
    if (/^[A-Z]$/.test(key)) return e.code === 'Key' + key;
    if (/^[0-9]$/.test(key)) return e.code === 'Digit' + key;
    return e.key === key;
  }
  window.addEventListener('keydown', (e) => {
    if (!view || !view.keys) return;
    const hit = view.keys.find((k) => matches(e, k.shortcut));
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    port.postMessage({ t: 'cmd', name: hit.name });
  }, true);

  // ---------- messages ----------
  port.onMessage.addListener((m) => {
    if (m.t === 'view') { view = m; renderPill(); }
    else if (m.t === 'prompt') showPrompt(m);
    else if (m.t === 'toast') showToast(m);
  });
  port.onDisconnect.addListener(() => host.remove());
})();
