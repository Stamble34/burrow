// The Burrow palette (Alt+Shift+K): jump to a card, make one, run a command.
// Used in pages (content.js mounts it in its Shadow DOM) and in palette.html for pages without content scripts.
// api: { query(q) -> Promise<items>, run(item), onClose() }. An item: { kind, label, sub, status, open, keys }.
(function () {
  const CSS = `
    .pal-wrap { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-start; padding-top: 14vh;
      background: rgba(0,0,0,.28); pointer-events: auto; font: 13.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .pal-wrap[hidden] { display: none; }
    .pal { width: min(620px, calc(100vw - 32px)); background: rgba(17,17,20,.97); color: #ececf1; border: 1px solid rgba(255,255,255,.09);
      border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden; }
    .pal input { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 15px 18px; font-size: 15px; color: #ececf1;
      border-bottom: 1px solid rgba(255,255,255,.07); }
    .pal input::placeholder { color: #6e6e7a; }
    .pal ul { list-style: none; margin: 0; padding: 6px; max-height: 52vh; overflow-y: auto; }
    .pal li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; min-width: 0; }
    .pal li.on { background: rgba(255,255,255,.07); }
    .pal .g { padding: 8px 10px 4px; color: #6e6e7a; font-size: 11.5px; letter-spacing: .02em; cursor: default; }
    .pal .ic { width: 16px; display: grid; place-items: center; flex: none; color: #a4a4b0; }
    .pal .lb { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pal .sb { color: #6e6e7a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; font-size: 12.5px; }
    .pal kbd { font: 11px/1 ui-monospace, monospace; color: #a4a4b0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08);
      border-radius: 5px; padding: 3px 5px; margin-left: 3px; }
    .pal .dot { width: 8px; height: 8px; border-radius: 50%; }
    .pal .s-todo { background: #8fb8ff; } .pal .s-doing { background: #f6d97a; }
    .pal .s-done { border: 1.5px solid #5f5f69; } .pal .s-parked { border: 1.5px dashed #9a8f80; }
    .pal .tabdot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent, #b8a4ff); flex: none; }
    .pal .empty { padding: 14px 12px; color: #6e6e7a; }
  `;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keys = (k) => (k ? String(k).split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('') : '');
  const icon = (it) => (it.kind === 'card' ? `<span class="dot s-${esc(it.status)}"></span>` : it.kind === 'create' ? '+' : '›');

  function mount(container, api) {
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'pal-wrap'; wrap.hidden = true;
    wrap.innerHTML = '<div class="pal" role="dialog"><input placeholder="Jump to a card, make one, or run a command" spellcheck="false"><ul></ul></div>';
    container.append(style, wrap);
    const input = wrap.querySelector('input'), list = wrap.querySelector('ul');
    let items = [], active = 0, seq = 0;

    async function refresh() {
      const mine = ++seq;
      const got = await api.query(input.value);
      if (mine !== seq) return; // a newer query won
      items = got || []; active = 0; paint();
    }
    function paint() {
      let html = '', group = null;
      items.forEach((it, i) => {
        if (it.group && it.group !== group) { group = it.group; html += `<li class="g">${esc(group)}</li>`; }
        html += `<li data-i="${i}" class="${i === active ? 'on' : ''}"><span class="ic">${icon(it)}</span><span class="lb">${esc(it.label)}</span>` +
          `${it.open ? '<span class="tabdot" title="Open in a tab"></span>' : ''}<span class="sb">${esc(it.sub || '')}</span>${keys(it.keys)}</li>`;
      });
      list.innerHTML = html || '<li class="empty">Nothing matches</li>';
      const on = list.querySelector('li.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    }
    function close() { wrap.hidden = true; api.onClose && api.onClose(); }
    function choose(i) { const it = items[i]; if (!it) return; close(); api.run(it); }

    input.addEventListener('input', refresh);
    // Keys stay in the palette: the page under it never sees them.
    for (const type of ['keydown', 'keyup', 'keypress']) wrap.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.code === 'KeyN')) { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.code === 'KeyP')) { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    list.addEventListener('mousemove', (e) => { const li = e.target.closest('li[data-i]'); if (li && +li.dataset.i !== active) { active = +li.dataset.i; paint(); } });
    list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });

    return {
      open() { wrap.hidden = false; input.value = ''; input.focus({ preventScroll: true }); refresh(); },
      close, get isOpen() { return !wrap.hidden; },
    };
  }

  (typeof window !== 'undefined' ? window : self).BurrowPalette = { mount };
})();
