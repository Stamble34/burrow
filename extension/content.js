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
    /* The transparent bottom border bridges the gap to the pill, so the line stays while the mouse moves up to it. */
    .ctx { pointer-events: auto; display: none; max-width: min(560px, calc(100vw - 28px)); padding: 7px 11px; border-radius: 10px;
      background: var(--bg); background-clip: padding-box; border: 1px solid var(--line); border-bottom: 7px solid transparent;
      color: var(--text-2); cursor: pointer; line-height: 1.4; }
    .ctx b { color: var(--text); font-weight: 600; }
    .ctx q { color: var(--text); }
    .ctx:hover { border-color: color-mix(in oklab, var(--accent) 45%, transparent); }
    .crumbs:hover .ctx, .ctx:hover { display: block; }
    .crumbs { display: flex; flex-direction: column; align-items: flex-start; }
    .in { animation: in .16s ease-out; }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
  </style>
  <div class="stack">
    <div class="box" id="prompt" tabindex="-1" hidden></div>
    <div class="box toast" id="toast" tabindex="-1" hidden></div>
    <div class="crumbs"><div class="ctx" id="ctx" title="Go back to where you dove from"></div><div class="pill" id="pill" hidden></div></div>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyHtml = (k) => (k ? String(k).split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('') : '');

  // ---------- palette ----------
  const palette = window.BurrowPalette.mount(root, {
    query: (q) => browser.runtime.sendMessage({ t: 'paletteQuery', q }),
    run: (item) => browser.runtime.sendMessage({ t: 'paletteRun', item }),
  });

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
    // Hovering the pill shows where this card came from: "From BFS: “…the sentence…”".
    const cur = view.bound && view.trail[last];
    const ctx = $('#ctx');
    if (cur && cur.context) {
      ctx.innerHTML = `From <b>${esc(cur.context.fromTitle || 'the page before')}</b>: <q>${esc(cur.context.text.length > 220 ? cur.context.text.slice(0, 217) + '…' : cur.context.text)}</q>`;
      ctx.dataset.id = cur.id;
      ctx.style.display = ''; // shown on hover by CSS
    } else { ctx.innerHTML = ''; ctx.removeAttribute('data-id'); ctx.style.display = 'none'; }
  }
  $('#ctx').addEventListener('click', () => { const id = $('#ctx').dataset.id; if (id) port.postMessage({ t: 'from', cardId: id }); });
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
    if (e.code === 'KeyZ' && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); port.postMessage({ t: 'undo' }); $('#toast').hidden = true; }
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

  // ---------- what you dove from ----------
  let lastContextTarget = null;
  document.addEventListener('contextmenu', (e) => { lastContextTarget = e.target; }, true);

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const blockOf = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return (el && el.closest('p, li, td, th, dd, dt, blockquote, figcaption, h1, h2, h3, h4, h5, h6, pre')) || (el && el.parentElement) || document.body;
  };
  // The sentence of `block` that contains `words`.
  function sentenceAround(block, words) {
    const text = clean(block.textContent);
    const at = Math.max(0, text.indexOf(words));
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/);
    let pos = 0;
    for (const p of parts) { if (at < pos + p.length + 1) return p.slice(0, 600); pos += p.length + 1; }
    return text.slice(0, 600);
  }
  // A #:~:text= link that scrolls to these words (short quotes whole, long ones by first and last words).
  function fragmentFor(words) {
    const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C');
    const w = clean(words).split(' ');
    const spec = w.length <= 8 ? enc(w.join(' ')) : enc(w.slice(0, 4).join(' ')) + ',' + enc(w.slice(-4).join(' '));
    return location.href.replace(/#.*$/, '') + '#:~:text=' + spec;
  }
  function grab(kind, url) {
    if (kind === 'selection') {
      const sel = getSelection();
      const text = clean(sel && sel.toString());
      if (!text) return null;
      const block = blockOf(sel.getRangeAt(0).startContainer);
      return { text, sentence: sentenceAround(block, text), fragmentUrl: fragmentFor(text) };
    }
    let a = lastContextTarget && lastContextTarget.closest && lastContextTarget.closest('a[href]');
    if (!a || a.href !== url) a = [...document.querySelectorAll('a[href]')].find((x) => x.href === url) || null;
    if (!a) return null;
    const text = clean(a.textContent);
    const sentence = sentenceAround(blockOf(a), text);
    return { text, sentence, fragmentUrl: fragmentFor(sentence.length > 4 ? sentence : text) };
  }
  browser.runtime.onMessage.addListener((m) => (m.t === 'grab' ? Promise.resolve(grab(m.kind, m.url)) : undefined));

  // ---------- return anchors ----------
  // When this tab is hidden, remember where you were: the scroll position, and the words at the top of
  // what you were reading (survives layout changes). Coming back to a reopened page uses them.
  function readingAnchor() {
    if (scrollY < 150) return { scroll: 0, fragment: null };
    const el = document.elementFromPoint(innerWidth / 2, Math.min(160, innerHeight / 4));
    const block = el && el !== document.body && el !== document.documentElement && el.closest('p, li, h1, h2, h3, h4, pre, td, blockquote');
    const words = block ? clean(block.textContent).split(' ').slice(0, 8).join(' ') : '';
    return { scroll: Math.round(scrollY), fragment: words.length > 12 ? words : null };
  }
  let lastAnchor = '';
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !view || !view.bound) return;
    const a = readingAnchor(); const key = a.scroll + '|' + a.fragment;
    if (key === lastAnchor) return;
    lastAnchor = key;
    port.postMessage({ t: 'anchor', url: location.href, ...a });
  });

  // Find these words on the page (text fragments don't fire for tabs an extension opens). Pages repeat
  // text, so with several matches take the one nearest where you were (`nearY`).
  function findText(words, nearY) {
    const want = clean(words).toLowerCase();
    if (!want) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (/^(P|LI|H[1-6]|PRE|TD|BLOCKQUOTE|DD|FIGCAPTION|SPAN|DIV)$/.test(n.tagName) && clean(n.textContent).toLowerCase().includes(want) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const hits = []; let n;
    while ((n = walker.nextNode())) hits.push(n);
    // Keep the innermost elements only (a <div> around a matching <p> is the same place).
    const inner = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)));
    if (!inner.length) return null;
    if (nearY == null) return inner[0];
    const top = (el) => el.getBoundingClientRect().top + scrollY;
    return inner.reduce((a, b) => (Math.abs(top(b) - nearY) < Math.abs(top(a) - nearY) ? b : a));
  }
  function restore(anchor) {
    if (!anchor) return;
    const go = () => {
      const el = anchor.fragment && findText(anchor.fragment, anchor.scroll ? anchor.scroll + Math.min(160, innerHeight / 4) : null);
      if (el) {
        el.scrollIntoView({ block: anchor.center ? 'center' : 'start' });
        if (anchor.center) flash(el);
        else scrollBy(0, -Math.min(160, innerHeight / 4));
      } else if (anchor.scroll) scrollTo(0, anchor.scroll);
    };
    go(); setTimeout(go, 600); // pages that lay out late
  }
  function flash(el) {
    const prev = el.style.backgroundColor, prevT = el.style.transition;
    el.style.transition = 'background-color 1.6s ease';
    el.style.backgroundColor = 'rgba(184,164,255,.35)';
    setTimeout(() => { el.style.backgroundColor = prev; setTimeout(() => { el.style.transition = prevT; }, 1700); }, 900);
  }

  // ---------- messages ----------
  port.onMessage.addListener((m) => {
    if (m.t === 'view') { view = m; renderPill(); }
    else if (m.t === 'prompt') showPrompt(m);
    else if (m.t === 'toast') showToast(m);
    else if (m.t === 'restore') restore(m.anchor);
    else if (m.t === 'palette') palette.isOpen ? palette.close() : palette.open();
  });
  port.onDisconnect.addListener(() => host.remove());
})();
