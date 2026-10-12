/* Burrow UI. Plain JS, no build step. */
(() => {
  'use strict';
  const S = window.BurrowShared;
  const $ = (s, r = document) => r.querySelector(s);
  const CARD_W = 240, GAP_X = 24, GAP_Y = 76, MIN_Z = 0.12, MAX_Z = 2.5;
  const clientId = S.uid('cl_');
  const desktop = window.burrowDesktop || null;
  const STATUS_LABEL = { todo: 'To learn', doing: 'Learning', done: 'Understood', parked: 'Parked' };
  const ACCENTS = [
    ['Lilac', '#b8a4ff'], ['Mint', '#7ef0c0'], ['Peach', '#ffb48a'], ['Rose', '#ff9fc8'],
    ['Sky', '#86d4ff'], ['Lemon', '#eef08a'], ['Coral', '#ff8f8f'], ['Aqua', '#79e6e6'],
  ];

  // ---------- state ----------
  let state = S.emptyState();
  let rev = -1;
  let loaded = false;
  const view = { x: 0, y: 0, z: 1 };
  let selected = new Set();
  let selectedLink = null;
  let edit = null;           // { id, isNew, ta }
  let linkMode = null;       // { from }
  let detailsId = null;
  let pendingReveal = null;  // a card the browser asked to show before the state loaded
  const sizes = new Map();
  const cardEls = new Map();
  let graph = { kids: new Map(), pars: new Map() };
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };

  const els = {
    viewport: $('#viewport'), world: $('#world'), cards: $('#cards'), linkLayer: $('#linkLayer'), tempLink: $('#tempLink'),
    marquee: $('#marquee'), empty: $('#empty'), trail: $('#trail'), boardName: $('#boardName'), boardBtn: $('#boardBtn'),
    progressFill: $('#progressFill'), progressText: $('#progressText'), focusChip: $('#focusChip'), focusTitle: $('#focusTitle'),
    zoomLabel: $('#zoomLabel'), conn: $('#conn'), toasts: $('#toasts'), menu: $('#menu'),
  };

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const boardId = () => state.settings.activeBoardId;
  const board = () => state.boards[boardId()];
  const cardsOn = (bid = boardId()) => Object.values(state.cards).filter((c) => c.boardId === bid);
  const siblingsOf = (c) => S.conceptCards(state, c.conceptId).filter((o) => o.id !== c.id);
  const linksOn = (bid = boardId()) => Object.values(state.links).filter((l) => state.cards[l.from] && state.cards[l.from].boardId === bid);
  const sizeOf = (id) => sizes.get(id) || { w: CARD_W, h: 46 };
  const kidsOf = (id) => (graph.kids.get(id) || []).map((cid) => state.cards[cid]).filter(Boolean).sort((a, b) => a.x - b.x);
  const parsOf = (id) => (graph.pars.get(id) || []).map((cid) => state.cards[cid]).filter(Boolean).sort((a, b) => a.x - b.x);
  const primary = () => (selected.size ? [...selected][selected.size - 1] : null);
  // Shortcuts follow the physical key when the layout isn't Latin (with Russian active, the D key types "в").
  // Typed text is untouched; this only decides which shortcut a key means.
  function keyOf(e) {
    const k = e.key;
    if (k.length === 1 && /^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(k)) { const l = e.code.slice(3); return e.shiftKey ? l : l.toLowerCase(); }
    if (e.code === 'Slash' && (k === '.' || k === ',')) return e.shiftKey ? '?' : '/'; // Russian: "/" is "." and "?" is ","
    return k;
  }
  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const urlOf = (c) => S.primaryUrl(c);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
  const keysHtml = (keys) => (keys || []).map((k) => `<kbd>${esc(k)}</kbd>`).join('');
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  // Tags get a soft color from their name, so the same tag looks the same everywhere.
  const tagColor = (t) => { let h = 0; for (const ch of t.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0; return ACCENTS[h % ACCENTS.length][1]; };
  const tagHtml = (t, removable) => `<span class="tag" data-tag="${esc(t)}" style="--tag:${tagColor(t)}">${esc(t)}` +
    (removable ? `<button class="tag-x" data-untag="${esc(t)}" title="Remove tag">${icon('x')}</button>` : '') + '</span>';

  function rebuildGraph() {
    const kids = new Map(), pars = new Map();
    for (const l of Object.values(state.links)) {
      if (!state.cards[l.from] || !state.cards[l.to]) continue;
      if (!kids.has(l.from)) kids.set(l.from, []);
      if (!pars.has(l.to)) pars.set(l.to, []);
      kids.get(l.from).push(l.to);
      pars.get(l.to).push(l.from);
    }
    graph = { kids, pars };
  }

  function isReady(c) {
    if (c.status === 'done') return false;
    const k = kidsOf(c.id);
    return k.length > 0 && k.every((x) => x.status === 'done');
  }

  function reachable(fromId, targetId) {
    const seen = new Set([fromId]); const stack = [fromId];
    while (stack.length) {
      const id = stack.pop();
      if (id === targetId) return true;
      for (const k of graph.kids.get(id) || []) if (!seen.has(k)) { seen.add(k); stack.push(k); }
    }
    return false;
  }

  // Path from a card back up to where you started (first parent each step).
  function trailOf(id) {
    const path = []; const seen = new Set(); let cur = state.cards[id];
    while (cur && !seen.has(cur.id)) {
      path.unshift(cur); seen.add(cur.id);
      const ps = parsOf(cur.id);
      const onTrailParent = ps.find((p) => p.id === lastUpFrom.get(cur.id));
      cur = onTrailParent || ps[0];
    }
    return path;
  }
  const lastUpFrom = new Map(); // child -> parent you came down from

  // ---------- sync with the service ----------
  // Edits go out in order. Undoable ones go to /api/do so the service records them in the shared
  // history (the browser extension undoes from the same list); the rest go to /api/ops.
  let outbox = [], flushing = false, online = false;
  let openTabs = new Set(); // card ids showing in a browser tab
  let browserLinked = false; // the extension is connected, so links can reuse open tabs

  function send(ops) {
    if (!ops.length) return;
    const last = outbox[outbox.length - 1];
    if (last && last.path === '/api/ops') last.body.ops.push(...ops);
    else outbox.push({ path: '/api/ops', body: { clientId, ops: [...ops] } });
    queueMicrotask(flush);
  }
  function sendRecorded(body) { outbox.push({ path: '/api/do', body: { clientId, ...body } }); queueMicrotask(flush); }

  async function flush() {
    if (flushing || !outbox.length) return;
    flushing = true;
    const item = outbox[0];
    try {
      const r = await fetch(item.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item.body) });
      if (!r.ok) throw new Error(r.status);
      outbox.shift();
    } catch (e) {
      setOnline(false);
      flushing = false;
      setTimeout(flush, 2000);
      return;
    }
    flushing = false;
    if (outbox.length) flush();
  }
  async function drain() {
    for (let i = 0; i < 50 && (outbox.length || flushing); i++) { flush(); await new Promise((r) => setTimeout(r, 40)); }
    return !outbox.length;
  }

  function setOnline(v) {
    online = v;
    els.conn.hidden = v || !loaded;
  }

  async function loadState() {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const d = await r.json();
    state = S.normalize(d.state);
    rev = d.rev;
    const first = !loaded;
    loaded = true;
    for (const id of [...selected]) if (!state.cards[id]) selected.delete(id);
    applyAccent();
    renderAll();
    if (first) { restoreView(true); suggestRepeats(); }
    if (pendingReveal) { const id = pendingReveal; pendingReveal = null; revealCard(id); }
  }

  function setTabs(list, browser) {
    browserLinked = !!browser;
    openTabs = new Set((list || []).map((t) => t.cardId));
    if (loaded) syncCards();
  }

  function connect() {
    const es = new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}&app=${desktop ? 'desktop' : 'web'}`);
    es.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.hello) {
        if (outbox.length) await flush();
        setOnline(true);
        setTabs(m.tabs, m.browser);
        if (m.rev !== rev) await loadState().catch(() => {});
        return;
      }
      if (m.tabs) return setTabs(m.tabs, m.browser);
      if (m.reveal) return revealCard(m.reveal.cardId);
      if (m.history) {
        const h = m.history;
        if (h.clientId !== clientId && h.entry.source === 'browser' && document.visibilityState === 'visible') toast(`${h.kind === 'undo' ? 'Undid' : 'Redid'} in the browser: ${h.entry.label}`);
        return;
      }
      if (!m.ops) return;
      rev = m.rev;
      if (m.clientId === clientId) return;
      onRemote(m.ops);
    };
    es.onerror = () => setOnline(false);
  }

  function onRemote(ops) {
    const prevBoard = boardId();
    for (const op of ops) S.applyOp(state, op);
    for (const id of [...selected]) if (!state.cards[id]) selected.delete(id);
    if (edit && !state.cards[edit.id]) edit = null;
    if (detailsId && !state.cards[detailsId]) closeDetails();
    if (pg.id && !state.cards[pg.id]) closePage();
    if (ops.some((o) => o.t === 'settings.put')) applyAccent();
    if (boardId() !== prevBoard) { switchedBoard(); return; }
    renderAll();
    const captured = ops.find((o) => o.t === 'card.put' && o.card.source === 'capture' && o.card.createdAt > Date.now() - 5000);
    if (captured && document.visibilityState === 'visible') {
      const el = cardEls.get(captured.card.id);
      if (el) el.classList.add('enter');
      toast(`Added “${captured.card.title}” from the browser`, { action: { label: 'Show', run: () => { selectOnly(captured.card.id); centerOn(captured.card.id); } } });
    }
  }

  // ---------- commit (local edits + undo) ----------
  const titleOf = (id) => { const c = state.cards[id]; return c ? `“${c.title || 'Untitled'}”` : 'a card'; };
  // A short name for an edit, shown when it is undone from the browser.
  function describe(ops) {
    const puts = ops.filter((o) => o.t === 'card.put'), dels = ops.filter((o) => o.t === 'card.del');
    if (dels.length) return dels.length === 1 ? `Deleted ${titleOf(dels[0].id)}` : `Deleted ${dels.length} cards`;
    const created = puts.filter((o) => !state.cards[o.card.id] || o.card.createdAt);
    if (created.length) return created.length === 1 ? `Added “${created[0].card.title || 'a card'}”` : `Added ${created.length} cards`;
    if (puts.length && puts.every((o) => 'status' in o.card)) return `Marked ${puts.length === 1 ? titleOf(puts[0].card.id) : puts.length + ' cards'} ${STATUS_LABEL[puts[0].card.status].toLowerCase()}`;
    if (puts.length && puts.every((o) => 'x' in o.card)) return puts.length === 1 ? `Moved ${titleOf(puts[0].card.id)}` : `Moved ${puts.length} cards`;
    if (puts.length === 1 && 'title' in puts[0].card) return `Renamed to “${puts[0].card.title}”`;
    if (ops.some((o) => o.t === 'link.put')) return 'Linked cards';
    if (ops.some((o) => o.t === 'link.del')) return 'Removed a link';
    if (ops.some((o) => o.t === 'board.del')) return 'Deleted a board';
    if (ops.some((o) => o.t === 'board.put')) return 'Changed a board';
    return 'Edit';
  }

  // opts: undo (default true), inverse (precomputed), coalesce (key to merge rapid edits),
  // sticky (merge into the entry with the same coalesce key however long ago), label, render (default true)
  function commit(ops, opts = {}) {
    ops = ops.filter(Boolean);
    if (!ops.length) return;
    const label = opts.label || describe(ops);
    for (const op of ops) S.applyOp(state, op);
    if (opts.undo === false) send(ops);
    else sendRecorded({ ops, label, coalesce: opts.coalesce || null, sticky: !!opts.sticky, inverse: opts.inverse || null });
    if (opts.render !== false) renderAll();
  }

  function runEntry(ops) {
    const prevBoard = boardId();
    for (const op of ops) S.applyOp(state, op);
    for (const id of [...selected]) if (!state.cards[id]) selected.delete(id);
    if (detailsId && !state.cards[detailsId]) closeDetails();
    if (boardId() !== prevBoard) switchedBoard(); else renderAll();
  }

  async function historyStep(kind) {
    commitEdit();
    if (!(await drain())) return toast('Burrow’s service isn’t reachable');
    let d;
    try { d = await (await fetch('/api/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) })).json(); } catch (e) { return toast('Burrow’s service isn’t reachable'); }
    if (d.empty) return toast(kind === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
    if (d.rev) rev = d.rev;
    runEntry(d.ops);
    if (d.entry.source === 'browser') toast(`${kind === 'undo' ? 'Undid' : 'Redid'}: ${d.entry.label}`);
    return d;
  }
  async function undo() {
    const d = await historyStep('undo');
    // Undoing a new card puts you back on the card it was added under.
    if (d && d.orig && !selected.size) {
      const l = d.orig.find((o) => o.t === 'link.put' && !state.cards[o.link.to] && state.cards[o.link.from]);
      if (l && state.cards[l.link.from].boardId === boardId()) selectOnly(l.link.from);
    }
  }
  function redo() { return historyStep('redo'); }

  // ---------- view ----------
  function applyView() {
    const { x, y, z } = view;
    els.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    // Promote the canvas to its own layer only while it's moving. Leaving it promoted makes
    // Chromium keep the bitmap it painted at the old zoom, so text stays blurry after zooming in.
    els.world.style.willChange = 'transform';
    clearTimeout(layerT);
    layerT = setTimeout(() => { els.world.style.willChange = 'auto'; }, 160);
    const g = 24 * z * (z < 0.5 ? 4 : z < 0.8 ? 2 : 1);
    els.viewport.style.backgroundSize = `${g}px ${g}px`;
    els.viewport.style.backgroundPosition = `${x}px ${y}px`;
    els.zoomLabel.textContent = Math.round(z * 100) + '%';
    const far = z < 0.55;
    const farScale = far ? Math.min(1.8, Math.round((0.75 / z) * 4) / 4) : 1;
    const wasFar = els.world.classList.contains('far');
    const prevScale = els.world.style.getPropertyValue('--far-scale');
    els.world.classList.toggle('far', far);
    els.world.style.setProperty('--far-scale', farScale);
    if (wasFar !== far || (far && String(farScale) !== prevScale)) { measure(); renderLinks(); }
    saveViewSoon();
  }

  let layerT = null;
  let viewSaveT = null;
  function saveViewSoon() {
    clearTimeout(viewSaveT);
    viewSaveT = setTimeout(() => { if (boardId()) lsSet('burrow.view.' + boardId(), { ...view }); }, 300);
  }

  function restoreView(instant) {
    const v = boardId() && lsGet('burrow.view.' + boardId());
    if (v && typeof v.z === 'number') { Object.assign(view, v); applyView(); } else fitBoard(instant);
  }

  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.z, y: (sy - view.y) / view.z });

  function zoomAt(sx, sy, factor) {
    const z = clamp(view.z * factor, MIN_Z, MAX_Z);
    const w = toWorld(sx, sy);
    view.z = z; view.x = sx - w.x * z; view.y = sy - w.y * z;
    applyView();
  }

  let viewAnim = null;
  function animateView(target, ms = 320) {
    cancelAnimationFrame(viewAnim);
    const from = { ...view }; const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms); const e = 1 - Math.pow(1 - p, 3);
      view.x = from.x + (target.x - from.x) * e; view.y = from.y + (target.y - from.y) * e; view.z = from.z + (target.z - from.z) * e;
      applyView();
      if (p < 1) viewAnim = requestAnimationFrame(step);
    };
    viewAnim = requestAnimationFrame(step);
  }

  function boundsOf(cards) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const c of cards) { const s = sizeOf(c.id); x1 = Math.min(x1, c.x); y1 = Math.min(y1, c.y); x2 = Math.max(x2, c.x + s.w); y2 = Math.max(y2, c.y + s.h); }
    return { x1, y1, x2, y2 };
  }

  function fitBoard(instant) {
    const cs = cardsOn();
    if (!cs.length) { const t = { x: innerWidth / 2 - CARD_W / 2, y: innerHeight / 2 - 120, z: 1 }; instant ? (Object.assign(view, t), applyView()) : animateView(t); return; }
    const b = boundsOf(cs); const pad = 90; const top = 60;
    const z = clamp(Math.min((innerWidth - pad * 2) / (b.x2 - b.x1), (innerHeight - pad * 2 - top) / (b.y2 - b.y1)), MIN_Z, 1.1);
    const t = { z, x: innerWidth / 2 - ((b.x1 + b.x2) / 2) * z, y: (innerHeight + top) / 2 - ((b.y1 + b.y2) / 2) * z };
    instant ? (Object.assign(view, t), applyView()) : animateView(t);
  }

  function centerOn(id, zoom) {
    const c = state.cards[id]; if (!c) return;
    const s = sizeOf(id); const z = zoom || Math.max(view.z, 0.8);
    animateView({ z, x: innerWidth / 2 - (c.x + s.w / 2) * z, y: (innerHeight + 48) / 2 - (c.y + s.h / 2) * z });
  }

  function ensureVisible(id) {
    const c = state.cards[id]; if (!c) return;
    const s = sizeOf(id);
    const sx = c.x * view.z + view.x, sy = c.y * view.z + view.y;
    const m = 70;
    if (sx < m || sy < 60 + m || sx + s.w * view.z > innerWidth - m || sy + s.h * view.z > innerHeight - m - 40) centerOn(id, view.z);
  }

  // ---------- rendering ----------
  function renderAll() {
    rebuildGraph();
    syncCards();
    measure();
    renderLinks();
    renderChrome();
    if (detailsId) fillDetails();
    if (pg.id) fillPage();
  }

  function cardHtml(c) {
    const kids = kidsOf(c.id);
    const doneKids = kids.filter((k) => k.status === 'done').length;
    const ready = isReady(c);
    const dot = c.status === 'done' ? icon('check', 'done-check') : `<span class="sdot s-${c.status}"></span>`;
    let meta = '';
    const url = urlOf(c);
    if (url) meta += `<a class="src" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${icon('ext')}${esc(hostOf(url))}</a>`;
    if (c.urls.length > 1) meta += `<span class="meta-more" title="${c.urls.length} pages read for this card">+${c.urls.length - 1}</span>`;
    if (c.note) meta += `<span class="meta-note" title="Has notes">${icon('note')}</span>`;
    const sibs = siblingsOf(c);
    if (sibs.length) meta += `<span class="meta-shared" title="Also on ${esc(sibs.map((o) => state.boards[o.boardId].name).join(', '))}">${icon('link')}${sibs.length}</span>`;
    if (kids.length) meta += `<span class="meta-kids ${ready ? 'ready-tag' : ''}" title="Prerequisites understood">${ready ? 'Ready · ' : ''}${doneKids}/${kids.length}</span>`;
    const tab = openTabs.has(c.id) ? '<span class="tab-dot" title="Open in a browser tab"></span>' : '';
    const tags = c.tags || [];
    return `<span class="focus-pin">${icon('target')}Capturing</span>${tab}` +
      `<div class="card-head">${dot}<div class="card-title">${esc(c.title) || '<span style="color:var(--text-3);font-weight:400">Untitled</span>'}</div></div>` +
      (tags.length ? `<div class="card-tags">${tags.slice(0, 3).map((t) => tagHtml(t)).join('')}${tags.length > 3 ? `<span class="tag" style="--tag:#8a8a96">+${tags.length - 3}</span>` : ''}</div>` : '') +
      `<div class="card-meta">${meta}</div>` +
      `<div class="handle" title="Drag to a card, or into empty space, to add a prerequisite"></div>`;
  }

  function syncCards() {
    const bid = boardId();
    const focusId = board() && board().focusId;
    const seen = new Set();
    for (const c of cardsOn(bid)) {
      seen.add(c.id);
      let el = cardEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.id = c.id;
        el.addEventListener('animationend', () => el.classList.remove('enter'));
        cardEls.set(c.id, el);
        els.cards.appendChild(el);
      }
      const cls = `card s-${c.status}${selected.has(c.id) ? ' selected' : ''}${isReady(c) ? ' ready' : ''}${focusId === c.id ? ' focus' : ''}` +
        `${el.classList.contains('enter') ? ' enter' : ''}${el.classList.contains('dragging') ? ' dragging' : ''}`;
      if (el.className !== cls) el.className = cls;
      if (!(edit && edit.id === c.id)) {
        const html = cardHtml(c);
        if (el._html !== html) { el.innerHTML = html; el._html = html; }
      }
      el.style.transform = `translate(${c.x}px, ${c.y}px)`;
    }
    for (const [id, el] of cardEls) if (!seen.has(id)) { el.remove(); cardEls.delete(id); sizes.delete(id); }
    els.empty.hidden = seen.size > 0 || !loaded;
  }

  function measure() {
    for (const [id, el] of cardEls) sizes.set(id, { w: el.offsetWidth || CARD_W, h: el.offsetHeight || 46 });
  }

  function linkPath(a, b) {
    const sa = sizeOf(a.id), sb = sizeOf(b.id);
    let x1 = a.x + sa.w / 2, y1 = a.y + sa.h, x2 = b.x + sb.w / 2, y2 = b.y;
    let dir = 1;
    if (b.y + sb.h < a.y) { y1 = a.y; y2 = b.y + sb.h; dir = -1; }
    const dy = Math.max(28, Math.abs(y2 - y1) * 0.5);
    return { d: `M${x1},${y1} C${x1},${y1 + dy * dir} ${x2},${y2 - dy * dir} ${x2},${y2}`, x2, y2 };
  }

  function trailAnchor() {
    const p = primary();
    if (p && state.cards[p]) return p;
    const f = board() && board().focusId;
    return f && state.cards[f] ? f : null;
  }

  function trailLinkSet() {
    const set = new Set(); const a = trailAnchor();
    if (!a) return set;
    const path = trailOf(a);
    for (let i = 0; i < path.length - 1; i++) set.add(path[i].id + '>' + path[i + 1].id);
    return set;
  }

  function renderLinks() {
    const trail = trailLinkSet();
    let glow = '', html = '';
    for (const l of linksOn()) {
      const a = state.cards[l.from], b = state.cards[l.to];
      const { d, x2, y2 } = linkPath(a, b);
      const onTrail = trail.has(a.id + '>' + b.id);
      const cls = onTrail ? 'trail' : b.status === 'done' ? 'done' : '';
      if (onTrail) glow += `<path class="link-glow" d="${d}"/>`;
      html += `<path class="link-hit" data-link="${l.id}" d="${d}"/><path class="link ${cls}${selectedLink === l.id ? ' selected' : ''}" d="${d}"/>` +
        `<circle class="link-end ${cls}" cx="${x2}" cy="${y2}" r="3"/>`;
    }
    els.linkLayer.innerHTML = glow + html;
  }

  function renderChrome() {
    const b = board();
    els.boardName.textContent = b ? b.name : 'No board';
    const cs = cardsOn();
    const done = cs.filter((c) => c.status === 'done').length;
    const shared = cs.filter((c) => c.status === 'done' && c.conceptId && siblingsOf(c).length).length;
    els.progressText.textContent = cs.length ? `${done} of ${cs.length} understood${shared ? ` · ${shared} shared` : ''}` : 'No cards yet';
    els.progressText.title = shared ? `${shared} understood concepts also live on other boards` : '';
    els.progressFill.style.width = cs.length ? (done / cs.length) * 100 + '%' : '0';
    const f = b && b.focusId && state.cards[b.focusId];
    els.focusChip.classList.toggle('none', !f);
    els.focusTitle.textContent = f ? f.title || 'Untitled' : 'Select a card to capture under it';
    $('.focus-label', els.focusChip).hidden = !f;
    renderTrail();
  }

  function renderTrail() {
    const a = trailAnchor();
    if (!a) { els.trail.innerHTML = ''; return; }
    const path = trailOf(a);
    els.trail.innerHTML = path.map((c, i) => {
      const dot = c.status === 'done' ? `<span class="sdot s-done"></span>` : `<span class="sdot s-${c.status}"></span>`;
      return (i ? '<span class="sep">/</span>' : '') +
        `<button data-id="${c.id}" class="${i === path.length - 1 ? 'current' : ''}" title="${esc(c.title)}">${dot}<span class="t">${esc(c.title || 'Untitled')}</span></button>`;
    }).join('');
  }

  // ---------- selection ----------
  function setSelection(ids) {
    selected = new Set(ids);
    selectedLink = null;
    if (selected.size === 1) {
      const id = [...selected][0];
      const b = board();
      if (b && b.focusId !== id && state.cards[id]) commit([{ t: 'board.put', board: { id: b.id, focusId: id } }], { undo: false });
      if (detailsId && detailsId !== id) openDetails(id);
    }
    renderSelection();
  }
  const selectOnly = (id) => setSelection(id ? [id] : []);
  function renderSelection() {
    for (const [id, el] of cardEls) el.classList.toggle('selected', selected.has(id));
    renderLinks();
    renderTrail();
  }

  // ---------- card operations ----------
  function overlaps(x, y, h, ignore) {
    for (const c of cardsOn()) {
      if (ignore && ignore.has(c.id)) continue;
      const s = sizeOf(c.id);
      if (x < c.x + s.w + 16 && x + CARD_W + 16 > c.x && y < c.y + s.h + 16 && y + h + 16 > c.y) return true;
    }
    return false;
  }
  function freeSpot(x, y) {
    let i = 0;
    while (overlaps(x, y, 50) && i++ < 60) x += CARD_W + GAP_X;
    return { x, y };
  }

  function spotForChild(parent) {
    const kids = kidsOf(parent.id);
    if (kids.length) {
      const last = kids[kids.length - 1];
      return freeSpot(last.x + CARD_W + GAP_X, last.y);
    }
    return freeSpot(parent.x, parent.y + sizeOf(parent.id).h + GAP_Y);
  }

  // A new card that repeats a concept from another board shares it and starts with what you already know.
  function adoptOps(card) {
    const known = card.title ? S.findConcept(state, card, card.boardId) : null;
    if (!known) return [];
    const where = state.boards[known.boardId].name;
    setTimeout(() => toast(known.status === 'done' ? `“${known.title}” is already understood (from ${where})` : `Linked “${known.title}” with ${where}${known.status === 'doing' ? ', already learning' : ''}`), 0);
    return S.joinOps(known, card);
  }

  function createCard({ x, y, title = '', url = '', parentId = null, editNow = true }) {
    if (!board()) return;
    const card = { id: S.uid('c_'), boardId: boardId(), title: S.titleCase(title), url, note: '', status: 'todo', x: Math.round(x), y: Math.round(y), createdAt: Date.now() };
    const ops = [{ t: 'card.put', card }, ...adoptOps(card)];
    if (parentId) { ops.push({ t: 'link.put', link: { id: S.uid('l_'), boardId: boardId(), from: parentId, to: card.id } }); lastUpFrom.set(card.id, parentId); }
    commit(ops, { coalesce: 'new:' + card.id });
    const el = cardEls.get(card.id);
    if (el) el.classList.add('enter');
    selectOnly(card.id);
    ensureVisible(card.id);
    if (editNow) startEdit(card.id, true);
    return card;
  }

  function newCardAt(sx, sy) {
    const w = toWorld(sx, sy);
    return createCard({ x: w.x - CARD_W / 2, y: w.y - 22 });
  }

  function newCardHere() {
    const inside = mouse.x > 0 && mouse.y > 50 && mouse.x < innerWidth && mouse.y < innerHeight;
    const p = inside ? mouse : { x: innerWidth / 2, y: innerHeight / 2 };
    const w = toWorld(p.x, p.y);
    const spot = freeSpot(w.x - CARD_W / 2, w.y - 22);
    createCard(spot);
  }

  function addPrerequisite(parentId) {
    const p = state.cards[parentId];
    if (!p) return newCardHere();
    const spot = spotForChild(p);
    createCard({ ...spot, parentId: p.id });
  }

  function addSibling(id) {
    const c = state.cards[id];
    if (!c) return newCardHere();
    const parent = parsOf(id).find((p) => p.id === lastUpFrom.get(id)) || parsOf(id)[0];
    if (parent) return addPrerequisite(parent.id);
    createCard(freeSpot(c.x + CARD_W + GAP_X, c.y));
  }

  function setStatus(ids, status, quiet) {
    ids = ids.filter((id) => state.cards[id]);
    if (!ids.length) return;
    const readyBefore = new Set(cardsOn().filter(isReady).map((c) => c.id));
    commit(ids.map((id) => ({ t: 'card.put', card: { id, boardId: state.cards[id].boardId, status, doneAt: status === 'done' ? Date.now() : null } })));
    if (status === 'done' && !quiet) {
      const newlyReady = cardsOn().filter((c) => isReady(c) && !readyBefore.has(c.id));
      if (newlyReady.length) {
        const p = newlyReady[0];
        toast(`Everything “${p.title}” needs is understood`, { action: { label: 'Go back up', keys: ['⇧', 'D'], run: () => { selectOnly(p.id); centerOn(p.id); } } });
      }
    }
  }

  function cycleStatus(ids) {
    const order = ['todo', 'doing', 'done'];
    const cur = state.cards[ids[0]] && state.cards[ids[0]].status;
    setStatus(ids, order[(order.indexOf(cur) + 1) % 3]);
  }

  function toggleDone(ids) {
    const allDone = ids.every((id) => state.cards[id] && state.cards[id].status === 'done');
    setStatus(ids, allDone ? 'todo' : 'done');
  }

  function doneAndUp() {
    const id = primary(); if (!id) return;
    const path = trailOf(id);
    setStatus([...selected], 'done', true);
    const up = path.length > 1 ? path[path.length - 2] : null;
    if (up) { selectOnly(up.id); centerOn(up.id); toast(`Back to “${up.title}”`); }
  }

  function deleteSelection() {
    if (selectedLink && state.links[selectedLink]) { commit([{ t: 'link.del', id: selectedLink }]); selectedLink = null; renderLinks(); return; }
    const ids = [...selected].filter((id) => state.cards[id]);
    if (!ids.length) return;
    const names = ids.length === 1 ? `“${state.cards[ids[0]].title || 'Untitled'}”` : `${ids.length} cards`;
    if (ids.includes(detailsId)) closeDetails();
    commit(ids.map((id) => ({ t: 'card.del', id })));
    setSelection([]);
    toast(`Deleted ${names}`, { action: { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo } });
  }

  function linkCards(from, to) {
    if (from === to) return false;
    if (Object.values(state.links).some((l) => l.from === from && l.to === to)) { toast('Those cards are already linked'); return false; }
    if (reachable(to, from)) { toast('That link would make a loop'); return false; }
    commit([{ t: 'link.put', link: { id: S.uid('l_'), boardId: boardId(), from, to } }]);
    lastUpFrom.set(to, from);
    return true;
  }

  // ---------- attach / detach ----------
  const linksOf = (id) => Object.values(state.links).filter((l) => l.from === id || l.to === id);
  const linkBetween = (from, to) => Object.values(state.links).find((l) => l.from === from && l.to === to);
  const named = (id) => `“${(state.cards[id] && state.cards[id].title) || 'Untitled'}”`;
  function unlink(linkIds, text) {
    linkIds = linkIds.filter((id) => state.links[id]);
    if (!linkIds.length) return;
    commit(linkIds.map((id) => ({ t: 'link.del', id })), { label: text });
    toast(text, { action: { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo } });
  }
  const detachLink = (lid) => { const l = state.links[lid]; if (l) unlink([lid], `${named(l.to)} is no longer under ${named(l.from)}`); };
  // X: cut a card loose. One link goes straight away; with more, the palette asks which. Several selected
  // cards keep the links between them and lose the ones to the rest of the map.
  function detach(ids) {
    ids = ids.filter((id) => state.cards[id]);
    if (!ids.length) return;
    if (ids.length > 1) {
      const set = new Set(ids);
      const ls = Object.values(state.links).filter((l) => set.has(l.from) !== set.has(l.to) && (set.has(l.from) || set.has(l.to)));
      if (!ls.length) return toast('These cards aren’t linked to the rest of the map');
      return unlink(ls.map((l) => l.id), `Detached ${ids.length} cards from the rest of the map`);
    }
    const ls = linksOf(ids[0]);
    if (!ls.length) return toast(`${named(ids[0])} isn’t linked to anything`);
    if (ls.length === 1) return detachLink(ls[0].id);
    openPalette('detach', ids[0]);
  }
  // A: put another card under this one (or above it). `move` first cuts the other card from its parents.
  function attach(id, otherId, where = 'below', move = false) {
    const [from, to] = where === 'below' ? [id, otherId] : [otherId, id];
    const cut = move ? linksOf(to).filter((l) => l.to === to).map((l) => ({ t: 'link.del', id: l.id })) : [];
    if (from === to || linkBetween(from, to)) return toast('Those cards are already linked');
    if (reachable(to, from)) return toast('That link would make a loop');
    const text = `${named(to)} is now under ${named(from)}`;
    commit([...cut, { t: 'link.put', link: { id: S.uid('l_'), boardId: boardId(), from, to } }], { label: text });
    lastUpFrom.set(to, from);
    toast(text, { action: { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo } });
  }
  function openAttach(id, where = 'below') { if (!state.cards[id]) return; pal.where = where; openPalette('attach', id); }

  function openUrl(id) {
    const c = state.cards[id];
    if (!c || !urlOf(c)) return toast('This card has no link');
    openLink(urlOf(c), id);
  }

  // With the extension connected, the browser switches to a tab already showing the page instead of
  // opening another. Without it, open a new tab as usual (synchronously, so it isn't popup-blocked).
  function openLink(url, cardId) {
    if (!browserLinked) return window.open(url, '_blank', 'noopener');
    fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, cardId }) })
      .then((r) => r.json()).then((d) => {
        if (!d.routed) return window.open(url, '_blank', 'noopener');
        if (desktop && desktop.raiseBrowser) desktop.raiseBrowser();
      })
      .catch(() => window.open(url, '_blank', 'noopener'));
  }
  // Card and details links go through openLink too (plain clicks only; modifier clicks keep their default).
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.src, #dSources a, a.d-context[href], .psrc a, a.pctx[href]');
    if (!a || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const card = a.closest('.card');
    openLink(a.href, card ? card.dataset.id : a.closest('.page') ? pg.id : detailsId);
  });

  function whatsNext() {
    const anchor = trailAnchor();
    const order = { doing: 0, todo: 1 };
    const pick = (list) => list.sort((a, b) => order[a.status] - order[b.status] || a.y - b.y || a.x - b.x)[0];
    const candidates = (rootIds) => {
      const out = []; const seen = new Set(); const stack = [...rootIds];
      while (stack.length) {
        const id = stack.pop(); if (seen.has(id)) continue; seen.add(id);
        const c = state.cards[id]; if (!c) continue;
        const ks = kidsOf(id);
        if (c.status !== 'done' && c.status !== 'parked' && ks.every((k) => k.status === 'done')) out.push(c);
        for (const k of ks) stack.push(k.id);
      }
      return out;
    };
    let target = null;
    if (anchor) {
      const path = trailOf(anchor);
      for (let i = path.length - 1; i >= 0 && !target; i--) {
        const cs = candidates([path[i].id]).filter((c) => c.id !== anchor || path[i].id === anchor);
        target = pick(cs);
      }
    }
    if (!target) target = pick(candidates(cardsOn().filter((c) => !graph.pars.has(c.id)).map((c) => c.id)));
    if (!target) return toast(cardsOn().length ? 'Everything on this board is understood' : 'Add a card first');
    selectOnly(target.id); centerOn(target.id);
    toast(`Next up: “${target.title}”`);
  }

  // ---------- inline title editing ----------
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  function startEdit(id, isNew = false) {
    commitEdit();
    const el = cardEls.get(id); const c = state.cards[id];
    if (!el || !c) return;
    const titleEl = $('.card-title', el);
    const ta = document.createElement('textarea');
    ta.className = 'card-edit'; ta.rows = 1; ta.value = c.title || ''; ta.placeholder = isNew ? 'What do you need to learn?' : 'Topic';
    ta.spellcheck = false;
    titleEl.replaceWith(ta);
    edit = { id, isNew, ta };
    autosize(ta);
    ta.focus(); ta.select();
    ta.addEventListener('input', () => { autosize(ta); sizes.set(id, { w: el.offsetWidth, h: el.offsetHeight }); renderLinks(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
      else if (e.key === 'Tab') { e.preventDefault(); const cid = edit && edit.id; const ok = commitEdit(); if (ok && cid && state.cards[cid]) addPrerequisite(cid); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (edit && edit.ta === ta) commitEdit(); }, 0));
  }

  // Returns true if the card still exists afterwards.
  function commitEdit() {
    if (!edit) return true;
    const { id, isNew, ta } = edit;
    edit = null;
    const c = state.cards[id];
    if (!c) return false;
    let title = ta.value.replace(/\s+/g, ' ').trim();
    if (!title && isNew) { removeNewCard(id); return false; }
    if (isNew) title = S.titleCase(title);
    const el = cardEls.get(id); if (el) el._html = null;
    if (title && title !== c.title) {
      const ops = [{ t: 'card.put', card: { id, boardId: c.boardId, title } }];
      if (isNew && !c.conceptId) ops.push(...adoptOps({ ...c, title }));
      // Creation + its first title are one undo step.
      commit(ops, isNew ? { coalesce: 'new:' + id, sticky: true, label: `Added “${title}”` } : {});
    }
    else renderAll();
    els.viewport.focus({ preventScroll: true });
    return true;
  }

  // An empty new card that was abandoned leaves no trace (and no undo entry).
  function removeNewCard(id) {
    S.applyOp(state, { t: 'card.del', id });
    sendRecorded({ ops: [{ t: 'card.del', id }], absorb: true });
    selected.delete(id);
    renderAll();
    els.viewport.focus({ preventScroll: true });
  }

  function cancelEdit() {
    if (!edit) return;
    const { id, isNew } = edit;
    const c = state.cards[id];
    edit = null;
    if (isNew && c && !c.title) return removeNewCard(id);
    const el = cardEls.get(id); if (el) el._html = null;
    renderAll();
    els.viewport.focus({ preventScroll: true });
  }

  // ---------- pointer interactions ----------
  let gesture = null;

  els.viewport.addEventListener('pointerdown', (e) => {
    closeMenus();
    const t = e.target;
    if (edit && !t.closest('.card-edit')) commitEdit();
    if (t.closest('a.src')) return;
    const cardEl = t.closest('.card');
    const id = cardEl && cardEl.dataset.id;
    if (e.button === 1) { e.preventDefault(); return startPan(e, false); }
    if (e.button !== 0) return;
    if (t.closest('.card-edit')) return;
    if (linkMode) {
      if (id && id !== linkMode.from) { if (linkCards(linkMode.from, id)) toast('Linked'); }
      endLinkMode();
      return;
    }
    if (t.closest('.handle') && id) return startLinkDrag(e, id);
    if (id) return startCardDrag(e, id);
    const hit = t.closest('.link-hit');
    if (hit) { selected = new Set(); selectedLink = hit.dataset.link; renderSelection(); return; }
    if (e.shiftKey) return startMarquee(e);
    startPan(e, true);
  });

  function track(onMove, onUp) {
    const move = (e) => onMove(e);
    const up = (e) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); onUp(e); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function startPan(e, clickClears) {
    const sx = e.clientX, sy = e.clientY, vx = view.x, vy = view.y;
    let moved = false;
    cancelAnimationFrame(viewAnim);
    track((ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      if (!moved) { moved = true; els.viewport.classList.add('panning'); }
      view.x = vx + dx; view.y = vy + dy; applyView();
    }, () => {
      els.viewport.classList.remove('panning');
      if (!moved && clickClears) { setSelection([]); if (detailsId) closeDetails(); }
    });
  }

  function startMarquee(e) {
    const sx = e.clientX, sy = e.clientY;
    const base = new Set(selected);
    const m = els.marquee;
    track((ev) => {
      const x1 = Math.min(sx, ev.clientX), y1 = Math.min(sy, ev.clientY), x2 = Math.max(sx, ev.clientX), y2 = Math.max(sy, ev.clientY);
      Object.assign(m.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
      m.hidden = false;
      const a = toWorld(x1, y1), b = toWorld(x2, y2);
      const ids = new Set(base);
      for (const c of cardsOn()) {
        const s = sizeOf(c.id);
        if (c.x < b.x && c.x + s.w > a.x && c.y < b.y && c.y + s.h > a.y) ids.add(c.id);
      }
      selected = ids; selectedLink = null;
      for (const [id, el] of cardEls) el.classList.toggle('selected', ids.has(id));
    }, () => { m.hidden = true; setSelection([...selected]); });
  }

  // Dragging moves the selection; its directly linked cards follow on a soft spring.
  function startCardDrag(e, id) {
    if (e.shiftKey) {
      const next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelection([...next]);
      if (!next.has(id)) return;
    } else if (!selected.has(id)) selectOnly(id);
    else if (selected.size > 1) { /* keep group */ }

    const moving = [...selected].filter((x) => state.cards[x]);
    const solo = e.ctrlKey || e.metaKey;
    const followers = new Set();
    if (!solo) for (const m of moving) for (const n of [...(graph.kids.get(m) || []), ...(graph.pars.get(m) || [])]) if (!selected.has(n)) followers.add(n);
    const orig = new Map();
    for (const x of [...moving, ...followers]) orig.set(x, { x: state.cards[x].x, y: state.cards[x].y });
    const sx = e.clientX, sy = e.clientY;
    let moved = false, dx = 0, dy = 0, released = false, raf = null;

    const frame = () => {
      let settling = false;
      for (const f of followers) {
        const c = state.cards[f]; if (!c) continue;
        const o = orig.get(f); const tx = o.x + dx, ty = o.y + dy;
        c.x += (tx - c.x) * 0.2; c.y += (ty - c.y) * 0.2;
        if (Math.abs(tx - c.x) > 0.5 || Math.abs(ty - c.y) > 0.5) settling = true; else { c.x = tx; c.y = ty; }
        const el = cardEls.get(f); if (el) el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      }
      renderLinks();
      if (!released || settling) raf = requestAnimationFrame(frame);
      else finish();
    };

    const finish = () => {
      for (const m of moving) { const el = cardEls.get(m); if (el) el.classList.remove('dragging'); }
      const ops = [], inverse = [];
      for (const [cid, o] of orig) {
        const c = state.cards[cid]; if (!c) continue;
        c.x = Math.round(c.x); c.y = Math.round(c.y);
        if (c.x === o.x && c.y === o.y) continue;
        ops.push({ t: 'card.put', card: { id: cid, boardId: c.boardId, x: c.x, y: c.y } });
        inverse.push({ t: 'card.put', card: { id: cid, boardId: c.boardId, x: o.x, y: o.y } });
      }
      if (ops.length) commit(ops, { inverse, render: false });
      renderLinks();
    };

    track((ev) => {
      const ddx = ev.clientX - sx, ddy = ev.clientY - sy;
      if (!moved && Math.hypot(ddx, ddy) < 3) return;
      if (!moved) {
        moved = true;
        for (const m of moving) { const el = cardEls.get(m); if (el) el.classList.add('dragging'); }
        raf = requestAnimationFrame(frame);
      }
      dx = ddx / view.z; dy = ddy / view.z;
      for (const m of moving) {
        const c = state.cards[m]; const o = orig.get(m);
        c.x = o.x + dx; c.y = o.y + dy;
        const el = cardEls.get(m); if (el) el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      }
    }, () => { released = true; if (!moved) cancelAnimationFrame(raf); });
  }

  function startLinkDrag(e, fromId) {
    e.stopPropagation();
    selectOnly(fromId);
    const a = state.cards[fromId]; const sa = sizeOf(fromId);
    const x1 = a.x + sa.w / 2, y1 = a.y + sa.h;
    let target = null, moved = false;
    const sx = e.clientX, sy = e.clientY;
    els.viewport.classList.add('linking');
    track((ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const w = toWorld(ev.clientX, ev.clientY);
      const dy = Math.max(28, Math.abs(w.y - y1) * 0.5);
      els.tempLink.setAttribute('d', `M${x1},${y1} C${x1},${y1 + dy} ${w.x},${w.y - dy} ${w.x},${w.y}`);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const tEl = under && under.closest('.card');
      const tid = tEl && tEl.dataset.id !== fromId ? tEl.dataset.id : null;
      if (tid !== target) {
        if (target && cardEls.get(target)) cardEls.get(target).classList.remove('link-target');
        target = tid;
        if (target) cardEls.get(target).classList.add('link-target');
      }
    }, (ev) => {
      els.viewport.classList.remove('linking');
      els.tempLink.setAttribute('d', '');
      if (target && cardEls.get(target)) cardEls.get(target).classList.remove('link-target');
      if (!moved) return addPrerequisite(fromId);
      if (target) { linkCards(fromId, target); return; }
      const w = toWorld(ev.clientX, ev.clientY);
      createCard({ x: w.x - CARD_W / 2, y: w.y, parentId: fromId });
    });
  }

  els.viewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card-edit') || e.target.closest('a.src')) return;
    const cardEl = e.target.closest('.card');
    if (cardEl) { if (!e.target.closest('.handle')) openPage(cardEl.dataset.id); return; }
    if (e.target.closest('.link-hit')) return;
    newCardAt(e.clientX, e.clientY);
  });

  els.viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeMenus();
    const trackpadPan = !e.ctrlKey && e.deltaMode === 0 && (e.deltaX !== 0 || Math.abs(e.deltaY) < 30);
    if (e.shiftKey && !e.ctrlKey) { view.x -= e.deltaY || e.deltaX; applyView(); return; }
    if (trackpadPan) { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); return; }
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 50 ? 0.012 : 0.0012;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * k));
  }, { passive: false });

  window.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });

  els.viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cardEl = e.target.closest('.card');
    const id = cardEl && cardEl.dataset.id;
    if (id && e.shiftKey) {
      const ids = selected.has(id) ? [...selected] : [id];
      toggleDone(ids);
      return;
    }
    if (id) {
      if (!selected.has(id)) selectOnly(id);
      return openCardMenu(e.clientX, e.clientY, id);
    }
    const hit = e.target.closest('.link-hit');
    if (hit) {
      selectedLink = hit.dataset.link; selected = new Set(); renderSelection();
      return openMenu(e.clientX, e.clientY, [{ label: 'Remove link', danger: true, keys: ['Del'], run: () => deleteSelection() }]);
    }
    openMenu(e.clientX, e.clientY, [
      { label: 'New card here', keys: ['N'], run: () => newCardAt(e.clientX, e.clientY) },
      { sep: true },
      { label: 'Tidy layout', keys: ['T'], run: () => tidy() },
      { label: 'Fit board', keys: ['F'], run: () => fitBoard() },
      { label: 'What should I learn next?', keys: ['W'], run: whatsNext },
    ]);
  });

  // ---------- menus ----------
  let menuItems = [], menuActive = -1;
  function openMenu(x, y, items) {
    menuItems = items.filter((i) => !i.hidden);
    menuActive = -1;
    const m = els.menu;
    m.innerHTML = menuItems.map((it, i) => it.sep ? '<hr>' :
      `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon || ''}<span>${esc(it.label)}</span><span class="m-keys">${keysHtml(it.keys)}</span></button>`).join('');
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  }
  els.menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = menuItems[+b.dataset.i]; closeMenus(); it.run();
  });
  function closeMenus() { els.menu.hidden = true; $('#accentPop').hidden = true; }

  function openCardMenu(x, y, id) {
    const c = state.cards[id];
    const ids = [...selected];
    const many = ids.length > 1;
    openMenu(x, y, [
      { label: 'Add prerequisite', keys: ['Tab'], run: () => addPrerequisite(id), hidden: many },
      { label: 'Open page', keys: ['⇧', 'E'], run: () => openPage(id), hidden: many },
      { label: 'Details sidebar', keys: ['E'], run: () => openDetails(id), hidden: many },
      { label: 'Rename', keys: ['F2'], run: () => startEdit(id), hidden: many },
      { label: 'Open link', keys: ['O'], run: () => openUrl(id), hidden: many || !urlOf(c) },
      { sep: true },
      { label: 'To learn', icon: '<span class="sdot s-todo"></span>', keys: ['1'], run: () => setStatus(ids, 'todo') },
      { label: 'Learning', icon: '<span class="sdot s-doing"></span>', keys: ['2'], run: () => setStatus(ids, 'doing') },
      { label: 'Understood', icon: '<span class="sdot s-done"></span>', keys: ['3'], run: () => setStatus(ids, 'done') },
      { label: 'Understood, go back up', icon: icon('up'), keys: ['⇧', 'D'], run: doneAndUp, hidden: many },
      { sep: true },
      { label: 'Attach a card…', icon: icon('link'), keys: ['A'], run: () => openAttach(id), hidden: many },
      { label: many ? 'Detach from the rest' : 'Detach…', icon: icon('x'), keys: ['X'], run: () => detach(ids), hidden: !ids.some((x) => linksOf(x).length) },
      { label: 'Link to a prerequisite…', keys: ['L'], run: () => beginLinkMode(id), hidden: many },
      { label: 'Tidy this branch', keys: ['T'], run: () => tidy(id), hidden: many },
      { label: many ? `Delete ${ids.length} cards` : 'Delete', danger: true, keys: ['Del'], run: deleteSelection },
    ]);
  }

  function beginLinkMode(from) {
    if (!state.cards[from]) return;
    linkMode = { from };
    els.viewport.classList.add('linking');
    toast(`Click the card “${state.cards[from].title}” needs first`, { ms: 3500 });
  }
  function endLinkMode() { linkMode = null; els.viewport.classList.remove('linking'); }

  // ---------- tidy layout ----------
  function tidy(rootId) {
    const roots = rootId ? [state.cards[rootId]] : cardsOn().filter((c) => !(graph.pars.get(c.id) || []).length).sort((a, b) => a.x - b.x);
    if (!roots.length || !roots[0]) return;
    const owner = new Map(); const tree = new Map(); const depth = new Map();
    const queue = roots.map((r) => { owner.set(r.id, null); depth.set(r.id, 0); return r.id; });
    while (queue.length) {
      const id = queue.shift(); tree.set(id, []);
      for (const k of kidsOf(id)) if (!owner.has(k.id)) { owner.set(k.id, id); depth.set(k.id, depth.get(id) + 1); tree.get(id).push(k.id); queue.push(k.id); }
    }
    const levelH = [];
    for (const [id, d] of depth) levelH[d] = Math.max(levelH[d] || 0, sizeOf(id).h);
    const levelY = [0];
    for (let i = 1; i < levelH.length; i++) levelY[i] = levelY[i - 1] + levelH[i - 1] + GAP_Y;
    const widthMemo = new Map();
    const width = (id) => {
      if (widthMemo.has(id)) return widthMemo.get(id);
      const ks = tree.get(id) || [];
      const w = Math.max(CARD_W, ks.reduce((s, k) => s + width(k), 0) + GAP_X * Math.max(0, ks.length - 1));
      widthMemo.set(id, w); return w;
    };
    const target = new Map();
    const place = (id, left) => {
      const w = width(id); const ks = tree.get(id) || [];
      target.set(id, { x: left + (w - CARD_W) / 2, y: levelY[depth.get(id)] });
      const total = ks.reduce((s, k) => s + width(k), 0) + GAP_X * Math.max(0, ks.length - 1);
      let x = left + (w - total) / 2;
      for (const k of ks) { place(k, x); x += width(k) + GAP_X; }
    };
    let left = 0;
    for (const r of roots) { place(r.id, left); left += width(r.id) + 72; }
    // keep the first root where it was so the board doesn't jump
    const anchor = roots[0]; const t0 = target.get(anchor.id);
    const ox = anchor.x - t0.x, oy = anchor.y - t0.y;
    for (const [, p] of target) { p.x = Math.round(p.x + ox); p.y = Math.round(p.y + oy); }
    tweenTo(target);
  }

  function tweenTo(target, ms = 420) {
    const from = new Map();
    for (const [id] of target) if (state.cards[id]) from.set(id, { x: state.cards[id].x, y: state.cards[id].y });
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms); const e = 1 - Math.pow(1 - p, 3);
      for (const [id, f] of from) {
        const c = state.cards[id]; if (!c) continue; const g = target.get(id);
        c.x = f.x + (g.x - f.x) * e; c.y = f.y + (g.y - f.y) * e;
        const el = cardEls.get(id); if (el) el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      }
      renderLinks();
      if (p < 1) return requestAnimationFrame(step);
      const ops = [], inverse = [];
      for (const [id, f] of from) {
        const c = state.cards[id]; if (!c) continue; const g = target.get(id);
        c.x = g.x; c.y = g.y;
        if (f.x === g.x && f.y === g.y) continue;
        ops.push({ t: 'card.put', card: { id, boardId: c.boardId, x: g.x, y: g.y } });
        inverse.push({ t: 'card.put', card: { id, boardId: c.boardId, x: f.x, y: f.y } });
      }
      if (ops.length) commit(ops, { inverse });
    };
    requestAnimationFrame(step);
  }

  // ---------- keyboard navigation ----------
  function navigate(dir) {
    const id = primary();
    if (!id) {
      const f = trailAnchor() || (cardsOn()[0] && cardsOn()[0].id);
      if (f) { selectOnly(f); ensureVisible(f); }
      return;
    }
    const c = state.cards[id]; let next = null;
    const path = trailOf(id);
    if (dir === 'up') next = path.length > 1 ? path[path.length - 2] : null;
    if (dir === 'down') {
      const ks = kidsOf(id);
      next = ks.find((k) => k.id === lastDown.get(id)) || ks[0];
      if (next) lastUpFrom.set(next.id, id);
    }
    if (dir === 'left' || dir === 'right') {
      const parent = path.length > 1 ? path[path.length - 2] : null;
      const sibs = parent ? kidsOf(parent.id) : cardsOn().filter((x) => !(graph.pars.get(x.id) || []).length).sort((a, b) => a.x - b.x);
      const i = sibs.findIndex((s) => s.id === id);
      next = sibs[i + (dir === 'left' ? -1 : 1)] || null;
      if (next && parent) lastUpFrom.set(next.id, parent.id);
    }
    if (!next) next = spatialNeighbor(c, dir);
    if (dir === 'up' && next) lastDown.set(next.id, id);
    if (next) { selectOnly(next.id); ensureVisible(next.id); }
  }
  const lastDown = new Map();

  function spatialNeighbor(c, dir) {
    const s = sizeOf(c.id); const cx = c.x + s.w / 2, cy = c.y + s.h / 2;
    let best = null, bestScore = Infinity;
    for (const o of cardsOn()) {
      if (o.id === c.id) continue;
      const so = sizeOf(o.id); const dx = o.x + so.w / 2 - cx, dy = o.y + so.h / 2 - cy;
      const main = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (main <= 10) continue;
      const score = main + cross * 2;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  // ---------- keyboard ----------
  const SHORTCUTS = [
    ['Build the map', [
      ['New card on its own', ['N'], 'or double-click the canvas'],
      ['Add prerequisite to selected card', ['Tab']],
      ['Add another prerequisite next to it', ['Enter']],
      ['Rename card', ['F2']],
      ['Open the card page and notes', ['⇧', 'E'], 'or double-click the card'],
      ['Details sidebar on or off', ['E']],
      ['Attach a card under it', ['A'], '⇧Enter in the list puts it above'],
      ['Detach from the cards above or below', ['X']],
      ['Link to a prerequisite with the mouse', ['L']],
      ['Paste links or lines as cards', ['Ctrl', 'V']],
      ['Delete', ['Del']],
    ]],
    ['Track progress', [
      ['Toggle understood', ['D']],
      ['Toggle understood with the mouse', ['⇧', 'Right-click']],
      ['Understood, go back up', ['⇧', 'D']],
      ['Cycle status', ['Space']],
      ['To learn, learning, understood', ['1', '2', '3']],
      ['What should I learn next?', ['W']],
    ]],
    ['Move around', [
      ['Go up, down and across the map', ['↑', '↓', '←', '→']],
      ['Search and commands', ['Ctrl', 'K']],
      ['Switch board', ['Ctrl', 'B']],
      ['Rename board', ['⇧', 'F2'], 'or double-click its name'],
      ['Fit board', ['F']],
      ['Center selected card', ['C']],
      ['Open card link', ['O']],
      ['Zoom', ['Ctrl', 'Scroll']],
    ]],
    ['Card page', [
      ['Page or Markdown view', ['Ctrl', '/']],
      ['Blocks: heading, list, to-do, code…', ['/'], 'or type # - 1. [] > ```'],
      ['Link to another card', ['[', '['], 'Ctrl+click it to open'],
      ['Bold, italic, code, link', ['Ctrl', 'B'], 'I, E, K'],
      ['Indent a list item', ['Tab'], '⇧Tab to outdent'],
      ['Move a block', ['Alt', '↑', '↓']],
      ['Tick a to-do', ['Ctrl', 'Enter']],
      ['Back to the map', ['Esc']],
    ]],
    ['Arrange', [
      ['Tidy layout (or selected branch)', ['T']],
      ['Move a card without its neighbours', ['Ctrl', 'Drag']],
      ['Select several cards', ['⇧', 'Drag']],
      ['Undo / redo', ['Ctrl', 'Z']],
    ]],
  ];

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const k = keyOf(e); const mod = e.ctrlKey || e.metaKey;
    if (!$('#paletteOverlay').hidden || !$('#helpOverlay').hidden) return;
    if (pg.id) return pageKey(e);
    if (mod && (k === 'k' || k === 'K' || k === 'p')) { e.preventDefault(); return openPalette(); }
    if (mod && (k === 'b' || k === 'B')) { e.preventDefault(); return openPalette('boards'); }
    if (isTyping(e.target)) {
      if (k === 'Escape' && e.target.closest('.details')) { e.target.blur(); closeDetails(); }
      return;
    }
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); return redo(); }
    if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); return setSelection(cardsOn().map((c) => c.id)); }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, 1.2); }
    if (mod && k === '-') { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); }
    if (mod && k === '0') { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, 1 / view.z); }
    if (mod || e.altKey) return;

    const p = primary(); const ids = [...selected];
    const handled = () => e.preventDefault();
    switch (k) {
      case 'Escape':
        if (!els.menu.hidden || !$('#accentPop').hidden) return closeMenus();
        if (linkMode) return endLinkMode();
        if (detailsId) return closeDetails();
        return setSelection([]);
      case 'Tab': handled(); return addPrerequisite(p || trailAnchor());
      case 'Enter': handled(); return p ? addSibling(p) : newCardHere();
      case 'n': case 'N': handled(); return newCardHere();
      case 'F2': handled(); return e.shiftKey ? openPalette('renameboard') : p && startEdit(p);
      case 'e': handled(); return detailsId && (!p || detailsId === p) ? closeDetails() : p && openDetails(p);
      case 'E': handled(); return p && openPage(p);
      case ' ': handled(); return ids.length && cycleStatus(ids);
      case '1': return ids.length && setStatus(ids, 'todo');
      case '2': return ids.length && setStatus(ids, 'doing');
      case '3': return ids.length && setStatus(ids, 'done');
      case 'd': return ids.length && toggleDone(ids);
      case 'D': return doneAndUp();
      case 'w': case 'W': return whatsNext();
      case 'l': case 'L': return p && beginLinkMode(p);
      case 'a': case 'A': handled(); return p && openAttach(p);
      case 'x': case 'X': handled(); return detach(ids);
      case 'o': case 'O': return p && openUrl(p);
      case 'f': case 'F': return fitBoard();
      case 'c': case 'C': return p && centerOn(p);
      case 't': case 'T': return tidy(selected.size === 1 ? p : undefined);
      case '?': handled(); e.stopImmediatePropagation(); return openHelp();
      case '/': handled(); return openPalette();
      case 'Delete': case 'Backspace': handled(); return deleteSelection();
      case 'ArrowUp': handled(); return navigate('up');
      case 'ArrowDown': handled(); return navigate('down');
      case 'ArrowLeft': handled(); return navigate('left');
      case 'ArrowRight': handled(); return navigate('right');
    }
  });

  // Paste a URL or a list of lines to create cards.
  window.addEventListener('paste', async (e) => {
    if (isTyping(e.target) || !$('#paletteOverlay').hidden || pg.id) return;
    const text = (e.clipboardData && e.clipboardData.getData('text/plain') || '').trim();
    if (!text) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 40);
    const parentId = primary();
    const created = [];
    const ops = [];
    let anchor = parentId ? spotForChild(state.cards[parentId]) : (() => { const w = toWorld(mouse.x, mouse.y); return freeSpot(w.x - CARD_W / 2, w.y); })();
    for (const line of lines) {
      const isUrl = /^https?:\/\/\S+$/i.test(line);
      const card = { id: S.uid('c_'), boardId: boardId(), title: isUrl ? hostOf(line) : S.titleCase(line), urls: isUrl ? [{ url: line, title: '', visitedAt: Date.now() }] : [], note: '', status: 'todo', x: Math.round(anchor.x), y: Math.round(anchor.y), createdAt: Date.now() };
      ops.push({ t: 'card.put', card }, ...adoptOps(card));
      if (parentId) ops.push({ t: 'link.put', link: { id: S.uid('l_'), boardId: boardId(), from: parentId, to: card.id } });
      created.push(card);
      anchor = { x: anchor.x + CARD_W + GAP_X, y: anchor.y };
    }
    commit(ops);
    for (const c of created) { const el = cardEls.get(c.id); if (el) el.classList.add('enter'); }
    if (created.length === 1) { selectOnly(created[0].id); ensureVisible(created[0].id); }
    else toast(`Added ${created.length} cards`, { action: { label: 'Undo', run: undo } });
    for (const c of created) {
      if (!urlOf(c)) continue;
      try {
        const r = await fetch('/api/title?url=' + encodeURIComponent(urlOf(c))); const d = await r.json();
        if (d.title && state.cards[c.id] && state.cards[c.id].title === c.title) commit([{ t: 'card.put', card: { id: c.id, boardId: c.boardId, title: S.titleCase(d.title) } }], { undo: false });
      } catch (err) { /* keep hostname */ }
    }
  });

  // ---------- details panel ----------
  const dEls = { panel: $('#details'), title: $('#dTitle'), url: $('#dUrl'), sources: $('#dSources'), context: $('#dContext'), note: $('#dNote'), rel: $('#dRel'), seg: $('#statusSeg') };
  function openDetails(id) {
    if (!state.cards[id]) return;
    detailsId = id;
    dEls.panel.hidden = false;
    fillDetails(true);
  }
  function closeDetails() { detailsId = null; dEls.panel.hidden = true; els.viewport.focus({ preventScroll: true }); }
  function fillDetails(force) {
    const c = state.cards[detailsId];
    if (!c) return closeDetails();
    const act = document.activeElement;
    if (force || act !== dEls.title) { dEls.title.value = c.title || ''; autosize(dEls.title); }
    $('#dTags').innerHTML = (c.tags || []).map((t) => tagHtml(t)).join('');
    if (force || act !== dEls.url) dEls.url.value = urlOf(c);
    const more = c.urls.slice(1);
    dEls.sources.innerHTML = more.map((u, i) => `<li><a href="${esc(u.url)}" target="_blank" rel="noopener" title="${esc(u.url)}">${esc(u.title || hostOf(u.url))}</a>` +
      `<span class="src-host">${esc(hostOf(u.url))}</span><button class="icon-btn" data-drop="${i + 1}" title="Remove this page">${icon('x')}</button></li>`).join('');
    dEls.sources.hidden = !more.length;
    // Where this card was dived from: the sentence, linking back to it on the page.
    const ctx = c.context && c.context.text ? c.context : null;
    dEls.context.hidden = !ctx;
    if (ctx) {
      const from = ctx.fromCardId && state.cards[ctx.fromCardId];
      dEls.context.innerHTML = `From <b>${esc(from ? from.title : 'a page')}</b>: <q>${esc(ctx.text)}</q>`;
      if (ctx.fromUrl) dEls.context.href = ctx.fromUrl; else dEls.context.removeAttribute('href');
    }
    if (force || act !== dEls.note) dEls.note.value = c.note || '';
    for (const b of dEls.seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.status === c.status);
    const row = (x, lid) => `<li><button data-id="${x.id}"><span class="sdot s-${x.status}"></span>${esc(x.title || 'Untitled')}</button>` +
      `<button class="icon-btn d-unlink" data-unlink="${lid}" title="Detach">${icon('x')}</button></li>`;
    const ks = kidsOf(c.id), ps = parsOf(c.id);
    const sibs = siblingsOf(c).sort((a, z) => state.boards[a.boardId].createdAt - state.boards[z.boardId].createdAt);
    const also = sibs.map((o) => `<li><button data-jump="${o.id}"><span class="sdot s-${o.status}"></span>${esc(state.boards[o.boardId].name)}</button></li>`).join('');
    dEls.rel.innerHTML = (sibs.length ? `<h3>Also on</h3><ul>${also}</ul>` : '') + (ks.length ? `<h3>Needs first</h3><ul>${ks.map((k) => row(k, linkBetween(c.id, k.id).id)).join('')}</ul>` : '') +
      (ps.length ? `<h3>Needed for</h3><ul>${ps.map((x) => row(x, linkBetween(x.id, c.id).id)).join('')}</ul>` : '') +
      `<button class="d-attach" data-attach="below">${icon('plus')}Attach a card<span class="m-keys">${keysHtml(['A'])}</span></button>`;
  }
  const patchDetails = (field, value, key) => {
    const c = state.cards[detailsId]; if (!c || c[field] === value) return;
    commit([{ t: 'card.put', card: { id: c.id, boardId: c.boardId, [field]: value } }], { coalesce: key });
  };
  dEls.title.addEventListener('input', () => { autosize(dEls.title); patchDetails('title', dEls.title.value.replace(/\s+/g, ' '), 'title:' + detailsId); });
  dEls.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dEls.note.focus(); } });
  // The field edits the primary source; the other pages read for the card are listed under it.
  dEls.url.addEventListener('change', () => {
    const c = state.cards[detailsId]; if (!c) return;
    const v = dEls.url.value.trim(); const rest = c.urls.slice(1).filter((u) => u.url !== v);
    patchDetails('urls', v ? [{ ...(c.urls[0] || {}), url: v, visitedAt: (c.urls[0] && c.urls[0].visitedAt) || Date.now() }, ...rest] : rest, 'url:' + detailsId);
  });
  dEls.sources.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-drop]'); const c = state.cards[detailsId]; if (!b || !c) return;
    patchDetails('urls', c.urls.filter((u, i) => i !== +b.dataset.drop), null);
  });
  dEls.note.addEventListener('input', () => patchDetails('note', dEls.note.value, 'note:' + detailsId));
  dEls.seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && detailsId) setStatus([detailsId], b.dataset.status); });
  dEls.rel.addEventListener('click', (e) => {
    const u = e.target.closest('[data-unlink]'); if (u) return detachLink(u.dataset.unlink);
    if (e.target.closest('[data-attach]')) return openAttach(detailsId);
    const j = e.target.closest('button[data-jump]'); if (j) return jumpToCard(j.dataset.jump); const b = e.target.closest('button[data-id]'); if (b) { selectOnly(b.dataset.id); openDetails(b.dataset.id); centerOn(b.dataset.id); } });
  $('#detailsClose').addEventListener('click', closeDetails);
  $('#dOpen').addEventListener('click', () => detailsId && openUrl(detailsId));
  $('#detailsPage').addEventListener('click', () => detailsId && openPage(detailsId));
  $('#dTags').addEventListener('click', () => detailsId && openPage(detailsId));

  // ---------- card page ----------
  // Double-click a card (or ⇧E) for its page: title, properties, tags and notes. Notes are Markdown
  // (markdown.js), kept as blocks. In the page view every block is shown rendered and the one you're in
  // shows its inline Markdown; "# ", "- ", "1. ", "[] ", "> ", "```", "---" or "/" make blocks, like Notion.
  // The Markdown view (Ctrl+/) edits the whole note as text.
  const M = window.BurrowMarkdown;
  const pg = {
    el: $('#page'), crumbs: $('#pageCrumbs'), scroll: $('#pageScroll'), title: $('#pageTitle'), props: $('#pageProps'),
    body: $('#pageBody'), src: $('#pageSrc'), modeSeg: $('#pageMode'),
    id: null, blocks: [], active: -1, ta: null, note: null, mode: lsGet('burrow.pageMode') === 'md' ? 'md' : 'page',
  };
  const TEXTY = new Set(['p', 'h', 'ul', 'ol', 'todo', 'quote']);
  const tagInput = Object.assign(document.createElement('input'), { className: 'tag-input', spellcheck: false });
  const srcInput = Object.assign(document.createElement('input'), { className: 'src-input', spellcheck: false, placeholder: 'Paste a link' });

  // Growing a textarea inside the scrolling page must not move the page.
  function fit(ta) { const top = pg.scroll.scrollTop; autosize(ta); pg.scroll.scrollTop = top; }
  let renderT = null;
  const renderSoon = () => { clearTimeout(renderT); renderT = setTimeout(() => { renderT = null; renderAll(); }, 400); };

  function openPage(id) {
    const c = state.cards[id]; if (!c) return;
    commitEdit(); closeMenus(); closeSuggest();
    if (!pg.id && desktop) $('#pageWin').appendChild($('#winControls'));
    stopEditing();
    pg.id = id; pg.note = null;
    pg.el.hidden = false;
    fillPage(true);
    pg.scroll.scrollTop = 0;
    if (!c.title) { pg.title.focus(); }
    else if (!c.note) pg.mode === 'md' ? pg.src.focus() : editBlock(0, 'start');
    else pg.scroll.focus({ preventScroll: true }); // arrows and Page Down scroll the page
  }

  function closePage() {
    if (!pg.id) return;
    const id = pg.id;
    stopEditing(); closeSuggest();
    pg.id = null; pg.el.hidden = true;
    if (desktop) $('#tbRight').appendChild($('#winControls'));
    clearTimeout(renderT); renderAll();
    if (state.cards[id] && state.cards[id].boardId === boardId()) { selectOnly(id); ensureVisible(id); }
    els.viewport.focus({ preventScroll: true });
  }

  // The browser asked to show this card (a breadcrumb or the notes shortcut in Zen).
  function revealCard(id) {
    if (!id) { if (desktop && desktop.raise) desktop.raise(); return; }
    if (!loaded) { pendingReveal = id; return; }
    const c = state.cards[id]; if (!c) return;
    if (!$('#paletteOverlay').hidden) closePalette();
    if (!$('#helpOverlay').hidden) closeHelp();
    if (c.boardId !== boardId()) switchBoard(c.boardId);
    selectOnly(id); centerOn(id);
    openPage(id);
    if (desktop && desktop.raise) desktop.raise();
  }

  function fillPage(force) {
    const c = state.cards[pg.id];
    if (!c) return closePage();
    if (force || document.activeElement !== pg.title) { pg.title.value = c.title || ''; fit(pg.title); }
    renderPageCrumbs(c);
    renderProps(c);
    const note = c.note || '';
    if (force || note !== pg.note) {
      pg.note = note;
      if (pg.mode === 'md') { if (force || document.activeElement !== pg.src) { pg.src.value = note; fit(pg.src); } }
      else { stopEditing(); pg.blocks = M.parse(note); renderBlocks(); }
    }
    pg.body.hidden = pg.mode === 'md'; pg.src.hidden = pg.mode !== 'md';
    for (const b of pg.modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === pg.mode);
  }

  function renderPageCrumbs(c) {
    const b = state.boards[c.boardId];
    pg.crumbs.innerHTML = `<button class="back" data-close title="Back to the map (Esc)">${icon('back')}</button>` +
      `<button data-close title="Back to the map">${esc(b ? b.name : 'Board')}</button>` +
      trailOf(c.id).map((x) => `<span class="sep">/</span><button data-page="${x.id}" class="${x.id === c.id ? 'current' : ''}" title="${esc(x.title)}">` +
        `<span class="sdot s-${x.status}"></span><span class="t">${esc(x.title || 'Untitled')}</span></button>`).join('');
  }

  // ---------- page: properties ----------
  const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  function renderProps(c) {
    const focused = document.activeElement === tagInput ? tagInput : document.activeElement === srcInput ? srcInput : null;
    const sel = focused && [focused.selectionStart, focused.selectionEnd];
    const row = (ic, label, v) => `<div class="prop"><div class="prop-k">${icon(ic)}<span>${label}</span></div><div class="prop-v">${v}</div></div>`;
    const chip = (x, lid) => `<button class="pchip" data-page="${x.id}" title="Open its page"><span class="sdot s-${x.status}"></span><span class="t">${esc(x.title || 'Untitled')}</span>` +
      `<span class="pchip-x" data-unlink="${lid}" title="Detach">${icon('x')}</span></button>`;
    const add = (where) => `<button class="pchip padd" data-attach="${where}" title="Attach a card ${where === 'below' ? 'under' : 'above'} this one">${icon('plus')}<span class="t">Add</span></button>`;
    const tags = c.tags || [];
    let html = row('target', 'Status', `<div class="seg pseg">${S.STATUSES.map((st) => `<button data-status="${st}" class="${c.status === st ? 'on' : ''}"><span class="sdot s-${st}"></span>${STATUS_LABEL[st]}</button>`).join('')}</div>`);
    html += row('tag', 'Tags', `<div class="tags-edit">${tags.map((t) => tagHtml(t, true)).join('')}<span data-slot="tag"></span></div>`);
    html += row('ext', c.urls.length > 1 ? 'Sources' : 'Source', `<div class="psources">${c.urls.map((u, i) => `<div class="psrc"><a href="${esc(u.url)}" target="_blank" rel="noopener" title="${esc(u.url)}">${esc(u.title || hostOf(u.url))}</a>` +
      `<span class="src-host">${esc(hostOf(u.url))}</span><button class="icon-btn" data-drop="${i}" title="Remove this page">${icon('x')}</button></div>`).join('')}<span data-slot="src"></span></div>`);
    const ctx = c.context && c.context.text ? c.context : null;
    if (ctx) {
      const from = ctx.fromCardId && state.cards[ctx.fromCardId];
      html += row('quote', 'From', `<a class="pctx"${ctx.fromUrl ? ` href="${esc(ctx.fromUrl)}" target="_blank" rel="noopener" title="Back to the sentence on the page"` : ''}>${from ? `<b>${esc(from.title)}</b> · ` : ''}<q>${esc(ctx.text)}</q></a>`);
    }
    const ks = kidsOf(c.id), ps = parsOf(c.id), sibs = siblingsOf(c);
    html += row('down', 'Needs first', ks.map((k) => chip(k, linkBetween(c.id, k.id).id)).join('') + add('below'));
    html += row('up', 'Needed for', ps.map((x) => chip(x, linkBetween(x.id, c.id).id)).join('') + add('above'));
    if (sibs.length) html += row('link', 'Also on', sibs.map((o) => `<button class="pchip" data-page="${o.id}">${icon('board')}<span class="t">${esc(state.boards[o.boardId].name)}</span></button>`).join(''));
    const dates = [c.createdAt ? `Added ${day(c.createdAt)}` : '', c.status === 'done' && c.doneAt ? `understood ${day(c.doneAt)}` : ''].filter(Boolean).join(', ');
    if (dates) html += row('calendar', 'Dates', `<span class="pdates">${dates}</span>`);
    pg.props.innerHTML = html;
    tagInput.placeholder = tags.length ? 'Add' : 'Add a tag';
    $('[data-slot="tag"]', pg.props).replaceWith(tagInput);
    $('[data-slot="src"]', pg.props).replaceWith(srcInput);
    if (focused) { focused.focus({ preventScroll: true }); focused.setSelectionRange(...sel); }
  }

  function patchPage(fields, opts = {}) {
    const c = state.cards[pg.id]; if (!c) return;
    commit([{ t: 'card.put', card: { id: c.id, boardId: c.boardId, ...fields } }], opts);
  }
  const cleanTag = (t) => String(t || '').replace(/^#+/, '').replace(/[\s,]+/g, ' ').trim().slice(0, 40);
  function addTag(t) {
    const c = state.cards[pg.id]; t = cleanTag(t);
    if (!c || !t) return;
    const tags = c.tags || [];
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    // Reuse the spelling of a tag that already exists elsewhere.
    const known = allTags().find((x) => x.toLowerCase() === t.toLowerCase());
    patchPage({ tags: [...tags, known || t] }, { label: `Tagged “${c.title}” ${known || t}` });
  }
  function removeTag(t) {
    const c = state.cards[pg.id]; if (!c) return;
    patchPage({ tags: (c.tags || []).filter((x) => x !== t) }, { label: `Removed tag ${t} from “${c.title}”` });
  }
  function allTags() {
    const count = new Map();
    for (const c of Object.values(state.cards)) for (const t of c.tags || []) count.set(t, (count.get(t) || 0) + 1);
    return [...count.keys()].sort((a, z) => count.get(z) - count.get(a) || a.localeCompare(z));
  }
  // Tags used on other cards, plus "Add tag …" for a new one while typing.
  function suggestTags() {
    const c = state.cards[pg.id]; if (!c) return;
    const typed = cleanTag(tagInput.value), q = typed.toLowerCase();
    const mine = new Set((c.tags || []).map((t) => t.toLowerCase()));
    const known = allTags().filter((t) => !mine.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q))).slice(0, 8);
    const items = (typed && !mine.has(q) && !known.some((t) => t.toLowerCase() === q) ? [{ create: typed }] : []).concat(known);
    if (!items.length) return closeSuggest();
    openSuggest(tagInput, items, (t) => { addTag(t.create || t); tagInput.value = ''; suggestTags(); },
      (t) => (t.create ? `<span class="sg-l">Add tag</span>${tagHtml(t.create)}` : tagHtml(t)), !!typed);
  }
  tagInput.addEventListener('focus', suggestTags);
  tagInput.addEventListener('input', suggestTags);
  tagInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== tagInput && sg.anchor === tagInput) closeSuggest(); }, 0));
  tagInput.addEventListener('keydown', (e) => {
    if (sg.anchor === tagInput && suggestKey(e)) return;
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && tagInput.value.trim())) {
      e.preventDefault();
      if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; suggestTags(); }
      return;
    }
    if (e.key === 'Backspace' && !tagInput.value) { const c = state.cards[pg.id]; const tags = (c && c.tags) || []; if (tags.length) { e.preventDefault(); removeTag(tags[tags.length - 1]); } return; }
    if (e.key === 'Escape') { e.preventDefault(); tagInput.blur(); }
  });

  srcInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); srcInput.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    let url = srcInput.value.trim(); const c = state.cards[pg.id];
    if (!url || !c) return;
    if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
    if (!/^https?:\/\/\S+\.\S+/.test(url) && !/^https?:\/\/localhost/.test(url)) return toast('That doesn’t look like a link');
    srcInput.value = '';
    if (c.urls.some((u) => u.url === url)) return;
    patchPage({ urls: [...c.urls, { url, title: '', visitedAt: Date.now() }] }, { label: `Added a source to “${c.title}”` });
  });

  pg.props.addEventListener('click', (e) => {
    const st = e.target.closest('[data-status]'); if (st) return setStatus([pg.id], st.dataset.status);
    const x = e.target.closest('[data-untag]'); if (x) return removeTag(x.dataset.untag);
    const tg = e.target.closest('.tag[data-tag]'); if (tg) return openPalette('all', undefined, '#' + tg.dataset.tag);
    const d = e.target.closest('[data-drop]');
    if (d) { const c = state.cards[pg.id]; return patchPage({ urls: c.urls.filter((u, i) => i !== +d.dataset.drop) }, { label: `Removed a source from “${c.title}”` }); }
    const u = e.target.closest('[data-unlink]'); if (u) return detachLink(u.dataset.unlink);
    const at = e.target.closest('[data-attach]'); if (at) return openAttach(pg.id, at.dataset.attach);
    const to = e.target.closest('[data-page]'); if (to) return openPage(to.dataset.page);
    if (e.target.closest('.tags-edit')) tagInput.focus();
  });

  // ---------- page: title, header ----------
  pg.title.addEventListener('input', () => {
    fit(pg.title);
    const c = state.cards[pg.id]; const t = pg.title.value.replace(/\s+/g, ' ');
    if (c && t !== c.title) { patchPage({ title: t }, { coalesce: 'title:' + c.id, render: false }); renderSoon(); }
  });
  pg.title.addEventListener('keydown', (e) => {
    const atEnd = pg.title.selectionStart === pg.title.value.length;
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && atEnd)) { e.preventDefault(); pg.mode === 'md' ? pg.src.focus() : editBlock(0, 'start'); }
    else if (e.key === 'Escape') { e.preventDefault(); pg.title.blur(); }
  });
  pg.crumbs.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closePage();
    const b = e.target.closest('[data-page]'); if (b) openPage(b.dataset.page);
  });
  $('#pageClose').addEventListener('click', closePage);
  pg.modeSeg.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setPageMode(b.dataset.mode); });
  // Buttons on the page never take focus, so clicking one doesn't end what you're typing.
  pg.el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  pg.scroll.addEventListener('scroll', () => pg.el.classList.toggle('scrolled', pg.scroll.scrollTop > 4), { passive: true });
  $('#pageBar').addEventListener('dblclick', (e) => { if (desktop && !e.target.closest('button')) desktop.maximize(); });

  function setPageMode(mode) {
    if (!pg.id || mode === pg.mode) return;
    const c = state.cards[pg.id];
    if (mode === 'md') {
      const at = pg.ta ? M.offsetOf(pg.blocks, pg.active, pg.ta.selectionStart) : null;
      stopEditing();
      pg.mode = 'md';
      pg.src.value = c.note || ''; pg.note = pg.src.value;
      pg.body.hidden = true; pg.src.hidden = false; fit(pg.src);
      if (at != null) { pg.src.focus({ preventScroll: true }); pg.src.setSelectionRange(at, at); }
    } else {
      const off = document.activeElement === pg.src ? pg.src.selectionStart : null;
      pg.mode = 'page';
      pg.note = c.note || ''; pg.blocks = M.parse(pg.note);
      pg.src.hidden = true; pg.body.hidden = false; renderBlocks();
      if (off != null) { const p = M.blockAt(pg.blocks, off); editBlock(p.i, p.at); }
    }
    lsSet('burrow.pageMode', pg.mode);
    for (const b of pg.modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === pg.mode);
  }

  function saveNote(note) {
    const c = state.cards[pg.id]; if (!c) return;
    pg.note = note;
    if ((c.note || '') === note) return;
    patchPage({ note }, { coalesce: 'note:' + c.id, render: false, label: `Edited the notes on “${c.title || 'Untitled'}”` });
    renderSoon();
  }
  const saveBlocks = () => saveNote(M.serialize(pg.blocks).replace(/\n+$/, ''));

  // ---------- page: blocks ----------
  const blockEl = (i) => pg.body.querySelector(`.blk[data-i="${i}"]`);
  function blockHtml(b, i, num) {
    const kind = b.type === 'h' ? 'h' + Math.min(3, b.level || 1) : b.type;
    const cls = `blk b-${kind}${b.type === 'todo' && b.checked ? ' checked' : ''}`;
    const ind = b.indent && M.LISTS.has(b.type) ? ` style="--indent:${b.indent}"` : '';
    let mark = '', body;
    if (b.type === 'ul') mark = `<span class="b-mark b-bullet" data-depth="${(b.indent || 0) % 3}"></span>`;
    if (b.type === 'ol') mark = `<span class="b-mark b-num">${num}.</span>`;
    if (b.type === 'todo') mark = `<span class="b-mark b-check" data-check title="Tick (Ctrl+Enter)">${icon('check')}</span>`;
    if (b.type === 'code' && b.lang) mark = `<span class="b-lang">${esc(b.lang)}</span>`;
    if (b.type === 'hr') body = '<hr>';
    else if (b.type === 'code') body = `<pre class="b-body">${esc(b.text) || ' '}</pre>`;
    else if (b.type === 'table') body = `<div class="b-body b-grid">${M.tableHtml(b.text)}</div>`;
    else body = `<div class="b-body b-text">${M.inline(b.text)}</div>`;
    return `<div class="${cls}" data-i="${i}"${ind}>${mark}${body}</div>`;
  }
  function renderBlocks() {
    if (!pg.blocks.length) pg.blocks = [{ type: 'p', text: '' }];
    const nums = M.numbering(pg.blocks);
    pg.ta = null; pg.active = -1;
    pg.body.innerHTML = pg.blocks.map((b, i) => blockHtml(b, i, nums[i])).join('');
    pg.body.classList.toggle('blank', pg.blocks.length === 1 && pg.blocks[0].type === 'p' && !pg.blocks[0].text);
  }
  // Re-render after a change to the blocks, then edit block `i` at `at` (or keep editing where you were).
  function rerender(i, at) {
    const cur = pg.ta ? { i: pg.active, at: pg.ta.selectionStart } : null;
    renderBlocks();
    const t = i != null ? { i, at } : cur;
    if (t) editBlock(t.i, t.at);
    saveBlocks();
  }

  function editBlock(i, caret = 'end') {
    if (pg.mode !== 'page' || !pg.id) return;
    if (!pg.blocks.length) renderBlocks();
    i = clamp(i, 0, pg.blocks.length - 1);
    if (pg.active !== i || !pg.ta) {
      stopEditing();
      const b = pg.blocks[i], el = blockEl(i);
      if (!el || b.type === 'hr') return;
      const ta = document.createElement('textarea');
      ta.className = 'b-edit'; ta.rows = 1; ta.value = b.text;
      ta.spellcheck = b.type !== 'code' && b.type !== 'table';
      ta.placeholder = { p: 'Type / for blocks, [[ to link a card', h: 'Heading', quote: 'Quote', code: 'Code', table: '' }[b.type] ?? 'List item';
      $('.b-body', el).replaceWith(ta);
      el.classList.add('editing');
      pg.active = i; pg.ta = ta;
      ta.addEventListener('input', onBlockInput);
      ta.addEventListener('keydown', onBlockKey);
      ta.addEventListener('blur', () => setTimeout(() => { if (pg.ta === ta && document.activeElement !== ta) stopEditing(); }, 0));
      fit(ta);
    }
    const ta = pg.ta, n = ta.value.length;
    const pos = caret === 'end' ? n : caret === 'start' ? 0 : clamp(caret, 0, n);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(pos, pos);
    const r = ta.getBoundingClientRect(), box = pg.scroll.getBoundingClientRect();
    if (r.bottom > box.bottom - 40) pg.scroll.scrollTop += r.bottom - box.bottom + 80;
    else if (r.top < box.top + 60) pg.scroll.scrollTop -= box.top + 60 - r.top;
  }
  function stopEditing() {
    const ta = pg.ta; if (!ta) return;
    const i = pg.active; pg.ta = null; pg.active = -1;
    if (sg.anchor === ta) closeSuggest();
    const el = ta.closest('.blk');
    if (el && pg.blocks[i]) el.outerHTML = blockHtml(pg.blocks[i], i, M.numbering(pg.blocks)[i]);
    pg.body.classList.toggle('blank', pg.blocks.length === 1 && pg.blocks[0].type === 'p' && !pg.blocks[0].text);
  }

  // Where in the source a click on rendered text lands.
  function caretFromPoint(e, el, b) {
    const body = $('.b-body', el); if (!body) return 'end';
    let node = null, off = 0;
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(e.clientX, e.clientY); if (r) { node = r.startContainer; off = r.startOffset; } }
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (p) { node = p.offsetNode; off = p.offset; } }
    if (!node || !body.contains(node)) return 'end';
    const r = document.createRange(); r.setStart(body, 0); r.setEnd(node, off);
    const n = r.toString().length;
    if (b.type === 'code') return n;
    if (b.type === 'table') return 'end';
    return M.sourceOffset(b.text, body.textContent, n);
  }

  pg.body.addEventListener('mousedown', (e) => {
    const chk = e.target.closest('[data-check]');
    if (chk) { e.preventDefault(); toggleCheck(+chk.closest('.blk').dataset.i); }
  });
  pg.body.addEventListener('click', (e) => {
    if (e.target.closest('textarea, [data-check]')) return;
    const a = e.target.closest('a');
    if (a) { e.preventDefault(); return a.dataset.card != null ? openWiki(a.dataset.card) : openLink(a.href, null); }
    const sel = getSelection();
    if (sel && !sel.isCollapsed && pg.body.contains(sel.anchorNode)) return; // selecting text to copy
    const el = e.target.closest('.blk'); if (!el) return;
    const i = +el.dataset.i, b = pg.blocks[i];
    if (b && b.type !== 'hr') editBlock(i, caretFromPoint(e, el, b));
  });
  // Clicking under the notes continues them, like the end of a Notion page.
  pg.scroll.addEventListener('click', (e) => {
    if (pg.mode !== 'page' || e.target.closest('.blk, .props, .page-title, textarea, input, button, a')) return;
    if (e.clientY < pg.body.getBoundingClientRect().bottom) return;
    const last = pg.blocks[pg.blocks.length - 1];
    if (!last || last.type !== 'p' || last.text) { pg.blocks.push({ type: 'p', text: '' }); renderBlocks(); }
    editBlock(pg.blocks.length - 1, 'end');
  });

  // Markdown shortcuts typed at the start of a block.
  const BLOCK_SHORTCUTS = [
    [/^(#{1,3}) $/, (m) => ({ type: 'h', level: m[1].length })],
    [/^[-*+] \[([ xX])\] $/, (m) => ({ type: 'todo', checked: m[1] !== ' ', indent: 0, marker: '-' })],
    [/^\[([ xX]?)\] $/, (m) => ({ type: 'todo', checked: /x/i.test(m[1]), indent: 0, marker: '-' })],
    [/^([-*+]) $/, (m) => ({ type: 'ul', marker: m[1], indent: 0 })],
    [/^(\d{1,3})[.)] $/, (m) => ({ type: 'ol', num: +m[1], indent: 0 })],
    [/^> $/, () => ({ type: 'quote' })],
  ];
  function onBlockInput() {
    const ta = pg.ta, i = pg.active, b = pg.blocks[i]; if (!ta || !b) return;
    const v = ta.value, caret = ta.selectionStart;
    // A pasted (or Shift+Enter) line break: the text becomes as many blocks as it has lines.
    if (TEXTY.has(b.type) && v.includes('\n')) {
      const tail = v.length - ta.selectionEnd;
      const raw = b.type === 'p' || M.parseLine(v.split('\n')[0]).type !== 'p' ? v : M.prefix(b) + v;
      const nb = M.parse(raw);
      pg.blocks.splice(i, 1, ...nb);
      const last = i + nb.length - 1;
      return rerender(last, Math.max(0, pg.blocks[last].text.length - tail));
    }
    if (b.type === 'p' && v === '---') { Object.assign(b, { type: 'hr', text: '' }); pg.blocks.splice(i + 1, 0, { type: 'p', text: '' }); return rerender(i + 1, 0); }
    const head = v.slice(0, caret);
    for (const [re, mk] of b.type === 'p' ? BLOCK_SHORTCUTS : b.type === 'ul' ? BLOCK_SHORTCUTS.slice(2, 3) : []) {
      const m = head.match(re);
      if (!m) continue;
      const keep = b.type === 'ul' ? { indent: b.indent } : {};
      Object.assign(b, mk(m), keep, { text: v.slice(m[0].length) });
      return rerender(i, 0);
    }
    b.text = v; fit(ta); saveBlocks();
    inlineSuggest();
  }

  function onBlockKey(e) {
    const ta = pg.ta, i = pg.active, b = pg.blocks[i]; if (!ta || !b) return;
    if (suggestKey(e)) return;
    const k = keyOf(e), mod = e.ctrlKey || e.metaKey;
    const s = ta.selectionStart, end = ta.selectionEnd, v = ta.value;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey) {
      if (formatKey(e, ta)) return;
      if (k === 'Enter') {
        stop();
        if (b.type === 'todo') return toggleCheck(i);
        if (!TEXTY.has(b.type)) { pg.blocks.splice(i + 1, 0, { type: 'p', text: '' }); return rerender(i + 1, 0); }
      }
      return;
    }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { stop(); return moveBlock(i, k === 'ArrowUp' ? -1 : 1); }
    if (k === 'Escape') { stop(); stopEditing(); return pg.scroll.focus({ preventScroll: true }); }
    if (k === 'Enter' && !e.shiftKey && TEXTY.has(b.type)) { stop(); return enterAt(i, s, end); }
    if (k === 'Tab') {
      stop();
      if (b.type === 'code') return document.execCommand('insertText', false, '  ');
      if (M.LISTS.has(b.type)) return indentBlock(i, e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'Backspace' && s === 0 && end === 0 && (TEXTY.has(b.type) || !v)) { stop(); return backspaceAtStart(i); }
    if (k === 'Delete' && s === v.length && end === s && TEXTY.has(b.type)) { stop(); return deleteAtEnd(i); }
    if (s !== end || e.shiftKey) return;
    const up = k === 'ArrowUp' ? onEdgeLine(ta, -1) : k === 'ArrowLeft' && s === 0;
    const down = k === 'ArrowDown' ? onEdgeLine(ta, 1) : k === 'ArrowRight' && s === v.length;
    if (up) {
      stop();
      const p = nextEditable(i, -1);
      return p >= 0 ? editBlock(p, 'end') : (pg.title.focus(), pg.title.setSelectionRange(pg.title.value.length, pg.title.value.length));
    }
    if (down) { const n = nextEditable(i, 1); if (n >= 0) { stop(); editBlock(n, 'start'); } }
  }
  const nextEditable = (i, d) => { for (let j = i + d; j >= 0 && j < pg.blocks.length; j += d) if (pg.blocks[j].type !== 'hr') return j; return -1; };

  // Is the caret on the first (dir -1) or last (dir 1) line the textarea shows? Measured with a mirror,
  // since long paragraphs wrap.
  const mirror = document.createElement('div');
  function onEdgeLine(ta, dir) {
    const v = ta.value, s = ta.selectionStart, cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 24;
    if (ta.scrollHeight <= lh * 1.5) return true;
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: ta.clientWidth + 'px',
      font: cs.font, letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight, padding: cs.padding, top: '0', left: '-9999px' });
    mirror.textContent = v.slice(0, s);
    const mark = document.createElement('span'); mark.textContent = '\u200b'; mirror.appendChild(mark);
    document.body.appendChild(mirror);
    const y = mark.offsetTop;
    mirror.textContent = v + '\u200b';
    const total = mirror.scrollHeight;
    mirror.remove();
    return dir < 0 ? y < lh * 0.5 : y + lh * 1.5 > total;
  }

  function enterAt(i, s, end) {
    const b = pg.blocks[i], v = b.text;
    const fence = b.type === 'p' && v.match(/^(```|~~~)([^`\s]*)$/);
    if (fence) { Object.assign(b, { type: 'code', lang: fence[2], text: '' }); return rerender(i, 0); }
    // Enter on an empty list item or quote ends it (outdenting first).
    if (b.type !== 'p' && b.type !== 'h' && !v) { if (b.indent) b.indent--; else b.type = 'p'; return rerender(i, 0); }
    const list = M.LISTS.has(b.type);
    const fresh = (text) => (list ? { type: b.type, indent: b.indent, marker: b.marker, num: (b.num || 1) + 1, checked: false, text } : { type: 'p', text });
    if (s === 0 && end === 0 && v) { pg.blocks.splice(i, 0, list ? fresh('') : { type: 'p', text: '' }); return rerender(i + 1, 0); }
    b.text = v.slice(0, s);
    pg.blocks.splice(i + 1, 0, fresh(v.slice(end)));
    rerender(i + 1, 0);
  }
  function backspaceAtStart(i) {
    const b = pg.blocks[i];
    if (b.type !== 'p') {
      if (M.LISTS.has(b.type) && b.indent) b.indent--;
      else Object.assign(b, { type: 'p', indent: 0 });
      return rerender(i, 0);
    }
    if (i === 0) return;
    const p = pg.blocks[i - 1];
    if (p.type === 'hr') { pg.blocks.splice(i - 1, 1); return rerender(i - 1, 0); }
    if (!TEXTY.has(p.type)) { if (!b.text) pg.blocks.splice(i, 1); return rerender(i - 1, 'end'); }
    const at = p.text.length;
    p.text += b.text; pg.blocks.splice(i, 1);
    rerender(i - 1, at);
  }
  function deleteAtEnd(i) {
    const b = pg.blocks[i], n = pg.blocks[i + 1];
    if (!n || !(n.type === 'hr' || TEXTY.has(n.type))) return;
    const at = b.text.length;
    if (n.type !== 'hr') b.text += n.text;
    pg.blocks.splice(i + 1, 1);
    rerender(i, at);
  }
  function indentBlock(i, d) {
    const b = pg.blocks[i], prev = pg.blocks[i - 1];
    const max = prev && M.LISTS.has(prev.type) ? (prev.indent || 0) + 1 : 0;
    const next = clamp((b.indent || 0) + d, 0, Math.max(max, d < 0 ? (b.indent || 0) - 1 : 0));
    if (next === (b.indent || 0)) return;
    b.indent = next;
    rerender();
  }
  function moveBlock(i, d) {
    const j = i + d; if (j < 0 || j >= pg.blocks.length) return;
    const at = pg.ta ? pg.ta.selectionStart : 0;
    [pg.blocks[i], pg.blocks[j]] = [pg.blocks[j], pg.blocks[i]];
    rerender(j, at);
  }
  function toggleCheck(i) {
    const b = pg.blocks[i]; if (!b || b.type !== 'todo') return;
    b.checked = !b.checked;
    if (pg.ta && pg.active === i) return rerender();
    const el = blockEl(i);
    if (el && !el.classList.contains('editing')) el.outerHTML = blockHtml(b, i, null);
    saveBlocks();
  }

  // Ctrl+B bold, Ctrl+I italic, Ctrl+E code, Ctrl+K link, Ctrl+Shift+X strike, Ctrl+Shift+H highlight.
  // Edits go through execCommand so the textarea's own undo keeps working.
  function formatKey(e, ta) {
    const k = keyOf(e).toLowerCase();
    const mark = !e.shiftKey ? { b: '**', i: '*', e: '`' }[k] : { x: '~~', h: '==' }[k];
    if (mark) { e.preventDefault(); e.stopPropagation(); wrapSel(ta, mark); return true; }
    if (k === 'k' && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      const s = ta.selectionStart, end = ta.selectionEnd, sel = ta.value.slice(s, end);
      if (/^https?:\/\/\S+$/.test(sel)) { document.execCommand('insertText', false, `[](${sel})`); ta.setSelectionRange(s + 1, s + 1); }
      else { document.execCommand('insertText', false, `[${sel}]()`); ta.setSelectionRange(s + sel.length + 3, s + sel.length + 3); }
      return true;
    }
    return false;
  }
  function wrapSel(ta, mark) {
    const s = ta.selectionStart, end = ta.selectionEnd, v = ta.value, sel = v.slice(s, end), n = mark.length;
    if (v.slice(s - n, s) === mark && v.slice(end, end + n) === mark) {
      ta.setSelectionRange(s - n, end + n);
      document.execCommand('insertText', false, sel);
      ta.setSelectionRange(s - n, end - n);
      return;
    }
    document.execCommand('insertText', false, mark + sel + mark);
    ta.setSelectionRange(s + n, end + n);
  }

  // ---------- page: "/" blocks and [[card]] links ----------
  const SLASH = [
    ['Text', '', { type: 'p' }], ['Heading 1', '#', { type: 'h', level: 1 }], ['Heading 2', '##', { type: 'h', level: 2 }],
    ['Heading 3', '###', { type: 'h', level: 3 }], ['Bulleted list', '-', { type: 'ul', marker: '-', indent: 0 }],
    ['Numbered list', '1.', { type: 'ol', num: 1, indent: 0 }], ['To-do list', '[]', { type: 'todo', checked: false, marker: '-', indent: 0 }],
    ['Quote', '>', { type: 'quote' }], ['Code', '```', { type: 'code', lang: '' }], ['Divider', '---', { type: 'hr' }],
    ['Table', '|', { type: 'table' }], ['Link to a card', '[[', null],
  ];
  function inlineSuggest() {
    const ta = pg.ta, i = pg.active, b = pg.blocks[i];
    if (!ta || !b || !TEXTY.has(b.type)) return closeSuggest();
    const head = ta.value.slice(0, ta.selectionStart);
    const sl = b.type === 'p' && head.match(/^\/([\w ]{0,20})$/);
    if (sl) {
      const q = sl[1].trim().toLowerCase();
      const items = SLASH.filter(([label]) => !q || label.toLowerCase().split(' ').some((w) => w.startsWith(q)) || label.toLowerCase().startsWith(q));
      return openSuggest(ta, items, (it) => applySlash(i, it, sl[0].length), ([label, hint]) => `<span class="sg-l">${esc(label)}</span><span class="sg-h">${esc(hint)}</span>`, true);
    }
    const wk = head.match(/\[\[([^\]\n]{0,60})$/);
    if (wk) {
      const q = wk[1].trim().toLowerCase(), here = state.cards[pg.id];
      const seen = new Set();
      const items = Object.values(state.cards)
        .filter((c) => c.id !== pg.id && c.title && (!q || score(c.title, q) > 0))
        .sort((a, z) => (z.boardId === here.boardId) - (a.boardId === here.boardId) || score(z.title, q) - score(a.title, q))
        .filter((c) => { const key = S.titleKey(c.title); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8);
      return openSuggest(ta, items, (c) => completeWiki(c.title, wk[0].length),
        (c) => `<span class="sdot s-${c.status}"></span><span class="sg-l">${esc(c.title)}</span><span class="sg-h">${esc(state.boards[c.boardId].name)}</span>`, true);
    }
    closeSuggest();
  }
  function applySlash(i, [, , kind], len) {
    const ta = pg.ta, b = pg.blocks[i]; if (!ta || !b) return;
    const rest = ta.value.slice(len);
    if (!kind) { ta.setSelectionRange(0, len); document.execCommand('insertText', false, '[[]]'); ta.setSelectionRange(2, 2); return inlineSuggest(); }
    if (kind.type === 'hr') { Object.assign(b, { type: 'hr', text: '' }); pg.blocks.splice(i + 1, 0, { type: 'p', text: rest }); return rerender(i + 1, 0); }
    if (kind.type === 'table') { Object.assign(b, { type: 'table', text: '| Column | Column |\n| --- | --- |\n|  |  |' }); return rerender(i, 2); }
    Object.assign(b, kind, { text: rest });
    rerender(i, 0);
  }
  function completeWiki(title, len) {
    const ta = pg.ta; if (!ta) return;
    const s = ta.selectionStart, close = ta.value.slice(s, s + 2) === ']]' ? 2 : 0;
    ta.setSelectionRange(s - len, s + close);
    document.execCommand('insertText', false, `[[${title}]]`);
  }
  // [[Title]] goes to that card's page (on this board first). A title with no card can be added as a prerequisite.
  function openWiki(title) {
    const k = S.titleKey(title), here = state.cards[pg.id];
    const hits = Object.values(state.cards).filter((c) => S.titleKey(c.title) === k);
    const hit = hits.find((c) => here && c.boardId === here.boardId) || hits[0];
    if (hit) return openPage(hit.id);
    if (!here || here.boardId !== boardId()) return toast(`No card called “${title}”`);
    toast(`No card called “${title}”`, { action: { label: 'Add it as a prerequisite', run: () => {
      const c = createCard({ ...spotForChild(here), title, parentId: here.id, editNow: false });
      if (c) openPage(c.id);
    } } });
  }

  // ---------- page: suggestion menu (blocks, card links, tags) ----------
  const sg = { el: $('#suggest'), items: [], active: 0, pick: null, anchor: null, chosen: false };
  function openSuggest(anchor, items, pick, render, preselect) {
    if (!items.length) return closeSuggest();
    Object.assign(sg, { items, pick, anchor, active: 0, chosen: !!preselect, render });
    paintSuggest();
    sg.el.hidden = false;
    const r = anchor.getBoundingClientRect(), h = sg.el.offsetHeight;
    sg.el.style.left = Math.max(8, Math.min(r.left, innerWidth - sg.el.offsetWidth - 12)) + 'px';
    sg.el.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  }
  function paintSuggest() {
    sg.el.innerHTML = sg.items.map((it, i) => `<button data-i="${i}" class="${i === sg.active && sg.chosen ? 'on' : ''}">${sg.render(it)}</button>`).join('');
    const on = sg.el.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function closeSuggest() { sg.el.hidden = true; sg.items = []; sg.pick = null; sg.anchor = null; }
  const suggesting = () => !sg.el.hidden && sg.items.length > 0;
  function suggestKey(e) {
    if (!suggesting()) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      sg.active = !sg.chosen ? (e.key === 'ArrowDown' ? 0 : sg.items.length - 1) : (sg.active + (e.key === 'ArrowDown' ? 1 : -1) + sg.items.length) % sg.items.length;
      sg.chosen = true; paintSuggest(); return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && sg.chosen) {
      e.preventDefault(); e.stopPropagation();
      const it = sg.items[sg.active], f = sg.pick; closeSuggest(); f(it); return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSuggest(); return true; }
    return false;
  }
  sg.el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = sg.items[+b.dataset.i], f = sg.pick; closeSuggest(); f(it);
  });
  pg.scroll.addEventListener('scroll', () => { if (suggesting()) closeSuggest(); }, { passive: true });

  // ---------- page: Markdown view ----------
  pg.src.addEventListener('input', () => { fit(pg.src); saveNote(pg.src.value); });
  pg.src.addEventListener('keydown', (e) => {
    const ta = pg.src, k = keyOf(e), mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) return formatKey(e, ta);
    if (k === 'Escape') { e.preventDefault(); return ta.blur(); }
    if (k === 'Tab') { e.preventDefault(); return indentLines(ta, e.shiftKey ? -1 : 1); }
    if (k !== 'Enter' || e.shiftKey || ta.selectionStart !== ta.selectionEnd) return;
    // Lists continue on Enter; Enter on an empty item ends the list.
    const s = ta.selectionStart, v = ta.value, ls = v.lastIndexOf('\n', s - 1) + 1, line = v.slice(ls, s);
    const m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/);
    if (!m) return;
    e.preventDefault();
    if (line.length === m[0].length) { ta.setSelectionRange(ls, s); document.execCommand('delete'); return; }
    const next = m[3] ? m[1] + (+m[3] + 1) + m[4] + ' ' : m[0].replace(/\[[xX]\]/, '[ ]');
    document.execCommand('insertText', false, '\n' + next);
  });
  function indentLines(ta, d) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const ls = v.lastIndexOf('\n', s - 1) + 1, le = v.indexOf('\n', e), end = le < 0 ? v.length : le;
    const lines = v.slice(ls, end).split('\n');
    const out = lines.map((l) => (d > 0 ? '  ' + l : l.replace(/^ {1,2}/, '')));
    ta.setSelectionRange(ls, end);
    document.execCommand('insertText', false, out.join('\n'));
    const first = out[0].length - lines[0].length, total = out.join('\n').length - lines.join('\n').length;
    ta.setSelectionRange(Math.max(ls, s + first), Math.max(ls, e + total));
  }

  // ---------- page: keys ----------
  function pageKey(e) {
    const k = keyOf(e), mod = e.ctrlKey || e.metaKey;
    if (mod && k === '/') { e.preventDefault(); return setPageMode(pg.mode === 'md' ? 'page' : 'md'); }
    if (isTyping(e.target)) return;
    if (k === 'Escape') { e.preventDefault(); return suggesting() ? closeSuggest() : closePage(); }
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); return redo(); }
    if (mod && (k === 'k' || k === 'K')) { e.preventDefault(); return openPalette(); }
    if (mod || e.altKey) return;
    if (k === 'Enter') { e.preventDefault(); return pg.mode === 'md' ? pg.src.focus() : editBlock(pg.blocks.length - 1, 'end'); }
  }

  // ---------- command palette ----------
  const pal = { overlay: $('#paletteOverlay'), input: $('#paletteInput'), list: $('#paletteList'), scope: $('#paletteScope'), items: [], active: 0, mode: 'all' };

  function commands() {
    const p = primary(); const c = p && state.cards[p];
    const list = [
      { label: 'New card on its own', sub: 'no parent', keys: ['N'], run: newCardHere },
      { label: 'Add prerequisite', sub: c ? `under “${c.title}”` : '', keys: ['Tab'], run: () => addPrerequisite(p), when: !!c },
      { label: 'Attach a card', sub: c ? `under or above “${c.title}”` : '', keys: ['A'], run: () => setTimeout(() => openAttach(p), 0), when: !!c },
      { label: 'Detach', sub: c ? `cut “${c.title}” from the cards it’s linked to` : '', keys: ['X'], run: () => detach([...selected]), when: !!(c && linksOf(p).length) },
      { label: 'Mark as understood', keys: ['D'], run: () => setStatus([...selected], 'done'), when: !!c },
      { label: 'Mark as learning', keys: ['2'], run: () => setStatus([...selected], 'doing'), when: !!c },
      { label: 'Mark as to learn', keys: ['1'], run: () => setStatus([...selected], 'todo'), when: !!c },
      { label: 'Understood, go back up', keys: ['⇧', 'D'], run: doneAndUp, when: !!c },
      { label: 'What should I learn next?', keys: ['W'], run: whatsNext },
      { label: 'Open page', sub: 'title, tags and notes', keys: ['⇧', 'E'], run: () => openPage(p), when: !!c },
      { label: 'Details sidebar', keys: ['E'], run: () => openDetails(p), when: !!c },
      { label: 'Open card link', keys: ['O'], run: () => openUrl(p), when: !!(c && urlOf(c)) },
      { label: selected.size === 1 ? 'Tidy this branch' : 'Tidy layout', keys: ['T'], run: () => tidy(selected.size === 1 ? p : undefined) },
      { label: 'Detach from other boards', sub: 'make this card its own concept', run: detachConcept, when: !!(c && siblingsOf(c).length) },
      { label: 'Link repeated concepts across boards', run: mergeRepeated },
      { label: 'Fit board', keys: ['F'], run: () => fitBoard() },
      { label: 'Switch board', keys: ['Ctrl', 'B'], run: () => setTimeout(() => openPalette('boards'), 0) },
      { label: 'New board', run: () => setTimeout(() => openPalette('newboard'), 0) },
      { label: 'Rename board', keys: ['⇧', 'F2'], run: () => setTimeout(() => openPalette('renameboard'), 0) },
      { label: 'Delete board', run: deleteBoard },
      { label: 'Copy board as Markdown outline', run: copyOutline },
      { label: 'Change accent color', run: () => setTimeout(openAccent, 0) },
      { label: 'Keyboard shortcuts', keys: ['?'], run: openHelp },
      { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo },
      { label: 'Redo', keys: ['Ctrl', '⇧', 'Z'], run: redo },
    ];
    return list.filter((x) => x.when !== false).map((x) => ({ ...x, kind: 'cmd' }));
  }

  function score(text, q) {
    if (!q) return 1;
    text = (text || '').toLowerCase();
    const i = text.indexOf(q);
    if (i === 0) return 100 - text.length * 0.01;
    if (i > 0) return (/\W/.test(text[i - 1]) ? 80 : 60) - text.length * 0.01;
    let j = 0;
    for (const ch of text) if (ch === q[j]) j++;
    return j === q.length ? 20 - text.length * 0.01 : 0;
  }

  function highlight(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function buildPalette() {
    const raw = pal.input.value.trim(); const q = raw.toLowerCase();
    const groups = [];
    const statusIcon = (s) => `<span class="sdot s-${s}"></span>`;
    if (pal.mode === 'newboard') {
      groups.push(['', [{ label: raw ? `Create board “${raw}”` : 'Type a name for the new board', icon: icon('plus'), run: () => raw && newBoard(raw) }]]);
    } else if (pal.mode === 'renameboard') {
      const id = pal.renameId; const b = state.boards[id];
      groups.push(['', [{ label: raw ? `Rename to “${raw}”` : 'Type a new name for the board', sub: b ? `now “${b.name}”` : '', keys: ['Enter'], icon: icon('board'), run: () => raw && renameBoard(id, raw) }]]);
    } else if (pal.mode === 'attach' && state.cards[pal.renameId]) {
      // Enter puts the card on the side the list was opened for, ⇧Enter on the other, Ctrl+Enter moves it there.
      const id = pal.renameId, c = state.cards[id], below = pal.where !== 'above';
      const linked = new Set(linksOf(id).flatMap((l) => [l.from, l.to]));
      const under = (x) => { const up = parsOf(x.id); return up.length ? `under “${up[0].title}”${up.length > 1 ? ` +${up.length - 1}` : ''}` : 'on its own'; };
      const cs = cardsOn().filter((x) => x.id !== id && !linked.has(x.id)).map((x) => ({ x, s: q ? score(x.title, q) : 1 })).filter((v) => v.s > 0)
        .sort((a, z) => z.s - a.s || z.x.createdAt - a.x.createdAt).slice(0, 40)
        .map(({ x }) => ({ label: x.title || 'Untitled', html: highlight(x.title || 'Untitled', q), icon: statusIcon(x.status), sub: under(x),
          run: () => attach(id, x.id, below ? 'below' : 'above'), shift: () => attach(id, x.id, below ? 'above' : 'below'), ctrl: () => attach(id, x.id, below ? 'below' : 'above', true) }));
      groups.push([`${below ? 'Under' : 'Above'} “${c.title}” · ⇧Enter ${below ? 'above' : 'under'} it · Ctrl+Enter moves it`, cs]);
      if (raw) groups.push(['', [{ label: `New card “${raw}” ${below ? 'under' : 'above'} “${c.title}”`, icon: icon('plus'), run: () => newAttached(id, raw, below) }]]);
    } else if (pal.mode === 'detach' && state.cards[pal.renameId]) {
      const id = pal.renameId, c = state.cards[id];
      const ls = linksOf(id).sort((a, z) => (z.to === id) - (a.to === id));
      const items = ls.map((l) => { const up = l.to === id, o = state.cards[up ? l.from : l.to];
        return { label: o.title || 'Untitled', html: highlight(o.title || 'Untitled', q), icon: icon(up ? 'up' : 'down'), sub: up ? 'above it' : 'below it', run: () => detachLink(l.id) }; })
        .filter((it) => !q || score(it.label, q) > 0);
      groups.push([`Cut “${c.title}” from`, items]);
      if (ls.length > 1 && !q) groups.push(['', [{ label: 'All of them', sub: `${ls.length} links`, icon: icon('x'), run: () => unlink(ls.map((l) => l.id), `“${c.title}” is on its own now`) }]]);
    } else if (pal.mode === 'boards') {
      const bs = Object.values(state.boards).map((b) => ({ b, s: score(b.name, q) })).filter((x) => x.s > 0).sort((a, z) => z.s - a.s || a.b.createdAt - z.b.createdAt);
      groups.push(['Boards', bs.map(({ b }) => boardItem(b, q))]);
      if (raw) groups.push(['', [{ label: `Create board “${raw}”`, icon: icon('plus'), run: () => newBoard(raw) }]]);
      else groups.push(['', [{ label: 'Rename board', keys: ['F2'], icon: icon('cmd'), run: () => setTimeout(() => openPalette('renameboard'), 0) }]]);
    } else {
      if (q) {
        const here = boardId();
        // "#tag" lists the cards with that tag.
        const tq = q.startsWith('#') ? q.slice(1) : null;
        const match = (c) => (tq != null ? ((c.tags || []).some((t) => t.toLowerCase().startsWith(tq)) ? 90 : 0) : score(c.title, q));
        const cs = Object.values(state.cards).map((c) => ({ c, s: match(c) + (c.boardId === here ? 5 : 0) })).filter((x) => x.s > 5)
          .sort((a, z) => z.s - a.s || z.c.createdAt - a.c.createdAt).slice(0, tq != null ? 30 : 8)
          .map(({ c }) => ({ kind: 'card', label: c.title || 'Untitled', html: tq != null ? esc(c.title || 'Untitled') : highlight(c.title || 'Untitled', q), icon: statusIcon(c.status),
            sub: [c.boardId !== here ? state.boards[c.boardId].name : '', STATUS_LABEL[c.status], ...(c.tags || []).map((t) => '#' + t)].filter(Boolean).join(' · '), run: () => jumpToCard(c.id) }));
        const p = primary();
        if (tq == null) cs.push({ kind: 'create', label: p ? `Add “${raw}” as a prerequisite` : `Create card “${raw}”`, icon: icon('plus'),
          sub: p ? `under “${state.cards[p].title}”` : '', run: () => createFromPalette(raw) });
        if (tq == null && p) cs.push({ kind: 'create', label: `Create card “${raw}” on its own`, icon: icon('plus'), sub: 'no parent', run: () => createFromPalette(raw, true) });
        groups.push(['Cards', cs]);
        const bs = Object.values(state.boards).filter((b) => score(b.name, q) > 0).slice(0, 4).map((b) => boardItem(b, q));
        if (bs.length) groups.push(['Boards', bs]);
        const cmds = commands().map((x) => ({ x, s: score(x.label, q) })).filter((x) => x.s > 0).sort((a, z) => z.s - a.s).slice(0, 6).map(({ x }) => ({ ...x, html: highlight(x.label, q), icon: icon('cmd') }));
        if (cmds.length) groups.push(['Commands', cmds]);
      } else {
        groups.push(['Commands', commands().map((x) => ({ ...x, icon: icon('cmd') }))]);
        groups.push(['Boards', Object.values(state.boards).sort((a, z) => a.createdAt - z.createdAt).map((b) => boardItem(b, ''))]);
      }
    }
    pal.items = [];
    let html = '';
    for (const [name, items] of groups) {
      if (!items.length) continue;
      if (name) html += `<div class="p-group">${esc(name)}</div>`;
      for (const it of items) {
        const i = pal.items.push(it) - 1;
        html += `<div class="p-item" data-i="${i}" role="option"><span class="p-icon">${it.icon || ''}</span><span class="p-label">${it.html || esc(it.label)}</span>` +
          `<span class="p-sub">${esc(it.sub || '')}</span><span class="p-keys">${keysHtml(it.keys)}</span></div>`;
      }
    }
    pal.list.innerHTML = html || '<div class="p-empty">No matches</div>';
    // Prefer a real match over "create" when typing
    pal.active = 0;
    paintActive();
  }

  function boardItem(b, q) {
    const cs = cardsOn(b.id); const done = cs.filter((c) => c.status === 'done').length;
    const shared = cs.filter((c) => c.status === 'done' && siblingsOf(c).length).length;
    return { kind: 'board', boardId: b.id, label: b.name, html: highlight(b.name, q), icon: icon('board'), sub: `${done} of ${cs.length} understood${shared ? ` (${shared} shared)` : ''}${b.id === boardId() ? ', current' : ''}`, run: () => switchBoard(b.id) };
  }

  function paintActive() {
    const nodes = pal.list.querySelectorAll('.p-item');
    nodes.forEach((n, i) => n.classList.toggle('active', i === pal.active));
    const a = nodes[pal.active]; if (a) a.scrollIntoView({ block: 'nearest' });
  }

  function openPalette(mode = 'all', renameId = boardId(), text = '') {
    commitEdit(); closeMenus();
    pal.mode = mode;
    pal.renameId = renameId;
    pal.overlay.hidden = false;
    const renaming = mode === 'renameboard' && state.boards[renameId];
    pal.input.value = renaming ? renaming.name : text;
    pal.input.placeholder = mode === 'attach' ? 'Find a card to attach, or type a new one' : mode === 'detach' ? 'Which link to cut?' : mode === 'boards' ? 'Find or create a board' : mode === 'newboard' ? 'Name the new board' : mode === 'renameboard' ? 'New board name' : 'Search cards, boards and commands';
    $('#paletteEnter').textContent = mode === 'attach' ? 'Attach' : mode === 'detach' ? 'Cut' : 'Open';
    pal.scope.hidden = mode === 'all';
    pal.scope.textContent = mode === 'attach' ? 'Attach' : mode === 'detach' ? 'Detach' : mode === 'boards' ? 'Boards' : mode === 'newboard' ? 'New board' : mode === 'renameboard' ? 'Rename board' : '';
    buildPalette();
    pal.input.focus();
    if (renaming) pal.input.select();
  }
  function closePalette() { pal.overlay.hidden = true; if (!pg.id) els.viewport.focus({ preventScroll: true }); }

  pal.input.addEventListener('input', buildPalette);
  pal.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (keyOf(e) === 'n' && e.ctrlKey)) { e.preventDefault(); pal.active = Math.min(pal.items.length - 1, pal.active + 1); paintActive(); }
    else if (e.key === 'ArrowUp' || (keyOf(e) === 'p' && e.ctrlKey)) { e.preventDefault(); pal.active = Math.max(0, pal.active - 1); paintActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = pal.items[pal.active]; closePalette(); if (it) runItem(it, e); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'F2' && pal.mode !== 'renameboard') { e.preventDefault(); const it = pal.items[pal.active]; openPalette('renameboard', it && it.kind === 'board' ? it.boardId : boardId()); }
    else if (e.key === 'Backspace' && !pal.input.value && pal.mode !== 'all') { pal.mode = 'all'; pal.scope.hidden = true; pal.input.placeholder = 'Search cards, boards and commands'; buildPalette(); }
    e.stopPropagation();
  });
  pal.list.addEventListener('mousemove', (e) => { const n = e.target.closest('.p-item'); if (n && +n.dataset.i !== pal.active) { pal.active = +n.dataset.i; paintActive(); } });
  pal.list.addEventListener('click', (e) => { const n = e.target.closest('.p-item'); if (!n) return; const it = pal.items[+n.dataset.i]; closePalette(); runItem(it, e); });
  const runItem = (it, e) => ((e.shiftKey && it.shift) || ((e.ctrlKey || e.metaKey) && it.ctrl) || it.run)();
  function newAttached(id, title, below) {
    const c = state.cards[id];
    if (below) return createCard({ ...spotForChild(c), title, parentId: id, editNow: false });
    const n = createCard({ ...freeSpot(c.x, c.y - 150), title, editNow: false });
    if (n) { commit([{ t: 'link.put', link: { id: S.uid('l_'), boardId: boardId(), from: n.id, to: id } }], { coalesce: 'new:' + n.id }); lastUpFrom.set(id, n.id); }
  }
  pal.overlay.addEventListener('pointerdown', (e) => { if (e.target === pal.overlay) closePalette(); });

  function jumpToCard(id) {
    const c = state.cards[id]; if (!c) return;
    if (pg.id) return openPage(id); // from the palette over a page: go to that card's page
    if (c.boardId !== boardId()) { switchBoard(c.boardId, () => { selectOnly(id); centerOn(id); }); return; }
    selectOnly(id); centerOn(id);
  }

  function detachConcept() {
    const ids = [...selected].filter((id) => state.cards[id] && state.cards[id].conceptId);
    if (!ids.length) return;
    commit(ids.map((id) => ({ t: 'card.put', card: { id, boardId: state.cards[id].boardId, conceptId: null } })));
    toast('Detached from other boards', { action: { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo } });
  }

  function mergeRepeated() {
    const m = S.mergeRepeatedOps(state);
    if (!m.ops.length) return toast('No repeated concepts to link');
    commit(m.ops);
    toast(`Linked ${m.cards} cards into ${m.concepts} shared concept${m.concepts === 1 ? '' : 's'}`, { action: { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo } });
  }

  // Cards made before concepts existed don't link by themselves; offer it once per set of repeats.
  function suggestRepeats() {
    const bid = boardId();
    const ids = S.mergeRepeatedOps(state).ops.filter((o) => 'conceptId' in o.card && o.card.boardId === bid).map((o) => o.card.id).sort();
    if (!ids.length) return;
    const key = 'burrow.repeats.' + bid;
    if (lsGet(key) === ids.join()) return;
    lsSet(key, ids.join());
    toast(`${ids.length === 1 ? '1 topic here is' : ids.length + ' topics here are'} also on other boards`, { action: { label: 'Link them', run: mergeRepeated }, ms: 9000 });
  }

  function createFromPalette(title, loose) {
    const p = loose ? null : primary();
    if (p && state.cards[p]) { const s = spotForChild(state.cards[p]); createCard({ ...s, title, parentId: p, editNow: false }); }
    else { const w = toWorld(innerWidth / 2, innerHeight / 2); createCard({ ...freeSpot(w.x - CARD_W / 2, w.y - 22), title, editNow: false }); }
  }

  // ---------- boards ----------
  function switchBoard(id, then) {
    if (!state.boards[id]) return;
    if (id !== boardId()) commit([{ t: 'settings.put', settings: { activeBoardId: id } }], { undo: false, render: false });
    switchedBoard();
    if (then) setTimeout(then, 30);
  }
  function switchedBoard() {
    selected = new Set(); selectedLink = null; closeDetails(); endLinkMode();
    renderAll();
    restoreView(true);
    suggestRepeats();
  }
  function newBoard(name) {
    const b = { id: S.uid('b_'), name: name.trim().slice(0, 80) || 'Untitled board', createdAt: Date.now(), focusId: null };
    commit([{ t: 'board.put', board: b }, { t: 'settings.put', settings: { activeBoardId: b.id } }], { render: false });
    switchedBoard();
    toast(`Created board “${b.name}”`);
  }
  function renameBoard(id, name) {
    const b = state.boards[id]; name = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!b || !name || name === b.name) return;
    commit([{ t: 'board.put', board: { id, name } }]);
    toast(`Renamed board to “${name}”`);
  }
  function deleteBoard() {
    const b = board(); if (!b) return;
    const ops = [{ t: 'board.del', id: b.id }];
    const others = Object.values(state.boards).filter((x) => x.id !== b.id);
    let fresh = null;
    if (!others.length) { fresh = { id: S.uid('b_'), name: 'Untitled board', createdAt: Date.now(), focusId: null }; ops.push({ t: 'board.put', board: fresh }); }
    ops.push({ t: 'settings.put', settings: { activeBoardId: fresh ? fresh.id : others.sort((a, z) => a.createdAt - z.createdAt)[0].id } });
    commit(ops, { render: false });
    switchedBoard();
    toast(`Deleted board “${b.name}”`, { action: { label: 'Undo', keys: ['Ctrl', 'Z'], run: undo }, ms: 7000 });
  }

  function copyOutline() {
    const roots = cardsOn().filter((c) => !(graph.pars.get(c.id) || []).length).sort((a, b) => a.y - b.y || a.x - b.x);
    const seen = new Set(); const lines = [`# ${board().name}`, ''];
    const walk = (c, d) => {
      const box = c.status === 'done' ? '[x]' : '[ ]';
      const t = urlOf(c) ? `[${c.title}](${urlOf(c)})` : c.title;
      lines.push(`${'  '.repeat(d)}- ${box} ${t}${c.status === 'doing' ? ' (learning)' : c.status === 'parked' ? ' (parked)' : ''}${seen.has(c.id) ? ' ↺' : ''}`);
      if (seen.has(c.id)) return; seen.add(c.id);
      for (const k of kidsOf(c.id)) walk(k, d + 1);
    };
    roots.forEach((r) => walk(r, 0));
    const text = lines.join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied the board as a Markdown outline'), () => toast('Could not reach the clipboard'));
  }

  // ---------- accent ----------
  function applyAccent() {
    const a = state.settings.accent || '#b8a4ff';
    document.documentElement.style.setProperty('--accent', a);
    renderSwatches();
  }
  function setAccent(color) { commit([{ t: 'settings.put', settings: { accent: color } }], { undo: false, render: false }); applyAccent(); }
  function renderSwatches() {
    const cur = (state.settings.accent || '').toLowerCase();
    $('#swatches').innerHTML = ACCENTS.map(([n, c]) => `<button class="swatch${c === cur ? ' on' : ''}" data-c="${c}" title="${n}" style="background:${c}"></button>`).join('');
    $('#accentCustom').value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#b8a4ff';
  }
  function openAccent() {
    const pop = $('#accentPop'); const r = $('#accentBtn').getBoundingClientRect();
    renderSwatches();
    pop.hidden = false;
    pop.style.top = r.bottom + 8 + 'px';
    pop.style.left = Math.min(r.left, innerWidth - 248) + 'px';
  }
  $('#accentBtn').addEventListener('click', (e) => { e.stopPropagation(); const pop = $('#accentPop'); pop.hidden ? openAccent() : closeMenus(); });
  $('#swatches').addEventListener('click', (e) => { const s = e.target.closest('.swatch'); if (s) setAccent(s.dataset.c); });
  $('#accentCustom').addEventListener('input', (e) => { document.documentElement.style.setProperty('--accent', e.target.value); });
  $('#accentCustom').addEventListener('change', (e) => setAccent(e.target.value));
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#accentPop') && !e.target.closest('#accentBtn')) $('#accentPop').hidden = true;
    if (!e.target.closest('#menu')) els.menu.hidden = true;
  }, true);

  // ---------- help ----------
  function openHelp() {
    $('#helpGrid').innerHTML = SHORTCUTS.map(([g, rows]) => `<h3>${esc(g)}</h3>` + rows.map(([l, k, note]) =>
      `<div class="help-row"><span>${esc(l)}${note ? `<span style="color:var(--text-3)"> ${esc(note)}</span>` : ''}</span><span class="k">${keysHtml(k)}</span></div>`).join('')).join('');
    $('#helpOverlay').hidden = false;
  }
  const closeHelp = () => { $('#helpOverlay').hidden = true; };
  $('#helpBtn').addEventListener('click', openHelp);
  $('#helpClose').addEventListener('click', closeHelp);
  $('#helpOverlay').addEventListener('pointerdown', (e) => { if (e.target.id === 'helpOverlay') closeHelp(); });
  window.addEventListener('keydown', (e) => { if (!$('#helpOverlay').hidden && (e.key === 'Escape' || keyOf(e) === '?')) { e.preventDefault(); closeHelp(); } });

  // ---------- toasts ----------
  function toast(msg, opts = {}) {
    const t = document.createElement('div');
    t.className = 'toast' + (opts.action ? '' : ' no-action');
    t.innerHTML = `<span class="t-msg">${esc(msg)}</span>` + (opts.action ? `<button>${esc(opts.action.label)}${opts.action.keys ? keysHtml(opts.action.keys) : ''}</button>` : '');
    if (opts.action) $('button', t).addEventListener('click', () => { opts.action.run(); remove(); });
    els.toasts.appendChild(t);
    while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
    const remove = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
    setTimeout(remove, opts.ms || (opts.action ? 6000 : 2600));
  }

  // ---------- chrome wiring ----------
  els.boardBtn.addEventListener('click', () => openPalette('boards'));
  // The first click opens the board list, whose backdrop covers the button, so the second click of a double-click lands there.
  pal.overlay.addEventListener('mousedown', (e) => {
    const r = els.boardBtn.getBoundingClientRect();
    if (e.detail === 2 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { e.preventDefault(); openPalette('renameboard'); }
  });
  $('#searchBtn').addEventListener('click', () => openPalette());
  els.focusChip.addEventListener('click', () => { const f = board() && board().focusId; if (f && state.cards[f]) { selectOnly(f); centerOn(f); } });
  els.trail.addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { selectOnly(b.dataset.id); centerOn(b.dataset.id); } });
  $('#zoomIn').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25));
  $('#zoomOut').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8));
  $('#zoomLabel').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / view.z));
  $('#fitBtn').addEventListener('click', () => fitBoard());

  if (desktop) {
    document.body.classList.add('desktop');
    $('#winControls').hidden = false;
    $('#winControls').addEventListener('click', (e) => { const b = e.target.closest('button[data-win]'); if (b) desktop[b.dataset.win](); });
    $('#topbar').addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; desktop.maximize(); });
    if (desktop.onQuickAdd) desktop.onQuickAdd(() => {
      if (!$('#paletteOverlay').hidden) closePalette();
      const f = trailAnchor();
      if (f) { selectOnly(f); addPrerequisite(f); } else newCardHere();
    });
  }

  window.addEventListener('resize', () => applyView());
  // Buttons shouldn't keep focus, so Space/Enter keep working as canvas shortcuts.
  document.addEventListener('click', (e) => { const b = e.target.closest('.topbar button, .hud button, .crumbs button, .toast button, .menu button, .swatch, .details button'); if (b) b.blur(); });

  // ---------- start ----------
  // http://127.0.0.1:7417/#card=<id> opens that card's page (the extension uses it when the app isn't open).
  const hashCard = location.hash.match(/^#card=(.+)$/);
  if (hashCard) { pendingReveal = decodeURIComponent(hashCard[1]); history.replaceState(null, '', location.pathname + location.search); }
  applyView();
  connect();
  loadState().catch(() => setOnline(false));

  // for debugging in devtools
  window.burrow = { get state() { return state; }, view, undo, redo, tidy, fitBoard, openPage, closePage, revealCard, get page() { return pg; } };
})();
