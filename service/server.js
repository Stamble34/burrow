#!/usr/bin/env node
// Burrow sync service: owns the data file, serves the UI, and keeps every
// open window (desktop app, browser tabs) in sync over Server-Sent Events.
// No dependencies; runs on Node 18+ or Electron's bundled Node.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const shared = require('../web/shared.js');

const PORT = Number(process.env.BURROW_PORT || 7417);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.BURROW_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'burrow');
const DATA_FILE = path.join(DATA_DIR, 'burrow.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const WEB_DIR = path.join(__dirname, '..', 'web');
const CARD_W = 240;

// ---------- persistence ----------
let state;
let rev = 0;
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if ((raw.version || 1) < shared.VERSION) {
        // Keep the file exactly as it was before changing its shape.
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const keep = path.join(BACKUP_DIR, `burrow-v${raw.version || 1}-before-migration-${Date.now()}.json`);
        fs.copyFileSync(DATA_FILE, keep);
        console.log(`[burrow] Migrating data to version ${shared.VERSION}. The old file is kept at ${keep}`);
        state = shared.normalize(raw);
        saveNow();
      } else {
        state = shared.normalize(raw);
      }
    } catch (e) {
      const broken = DATA_FILE + '.broken-' + Date.now();
      fs.copyFileSync(DATA_FILE, broken);
      console.error(`[burrow] Could not parse ${DATA_FILE}. Kept a copy at ${broken} and started empty.`);
      state = shared.emptyState();
    }
  } else {
    state = shared.emptyState();
  }
  if (!Object.keys(state.boards).length) {
    const id = shared.uid('b_');
    shared.applyOp(state, { t: 'board.put', board: { id, name: 'My first board', createdAt: Date.now(), focusId: null } });
    state.settings.activeBoardId = id;
    saveNow();
  }
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  dailyBackup();
}

function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}

function dailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `burrow-${day}.json`);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(DATA_FILE, target);
      const old = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('burrow-')).sort();
      while (old.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, old.shift()));
    }
  } catch (e) { /* backups are best effort */ }
}

// ---------- live sync ----------
const streams = new Set();

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of streams) res.write(data);
}

function applyOps(ops, clientId) {
  const applied = [];
  for (const op of ops || []) if (shared.applyOp(state, op)) applied.push(op);
  if (applied.length) {
    rev++;
    scheduleSave();
    broadcast({ rev, clientId: clientId || null, ops: applied });
  }
  return applied;
}

setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25000).unref();

// ---------- shared undo history ----------
// One history for the app and the browser extension. An entry is the ops, their inverse, and
// `effects`: what the browser did alongside (tab bound, tab closed, ...), which the extension reverses.
const history = { done: [], undone: [] };
const HISTORY_MAX = 300;
const COALESCE_MS = 2500;

function applyRecorded(ops, clientId) {
  const applied = []; const inverse = [];
  for (const op of ops || []) {
    const inv = shared.inverseOf(state, op);
    if (shared.applyOp(state, op)) { applied.push(op); inverse.unshift(...inv); }
  }
  if (applied.length) { rev++; scheduleSave(); broadcast({ rev, clientId: clientId || null, ops: applied }); }
  return { applied, inverse };
}

const entrySummary = (e) => ({ id: e.id, label: e.label, effects: e.effects, source: e.source });

// opts: label, effects, coalesce (key), sticky (coalesce regardless of time), inverse (precomputed by the client), source
function record(ops, opts = {}) {
  let applied, inverse;
  if (opts.inverse) { applied = applyOps(ops, opts.clientId); inverse = opts.inverse; } else ({ applied, inverse } = applyRecorded(ops, opts.clientId));
  if (!applied.length && !(opts.effects && opts.effects.length)) return null;
  const last = history.done[history.done.length - 1];
  const now = Date.now();
  if (opts.coalesce && last && last.key === opts.coalesce && (opts.sticky || now - last.at < COALESCE_MS)) {
    last.ops.push(...applied); last.inverse.unshift(...inverse); last.effects.push(...(opts.effects || [])); last.at = now;
    if (opts.sticky && opts.label) last.label = opts.label;
    return last;
  }
  const entry = { id: shared.uid('h_'), label: opts.label || 'Edit', ops: applied, inverse, effects: opts.effects || [],
    key: opts.coalesce || null, at: now, source: opts.source || 'app' };
  history.done.push(entry);
  if (history.done.length > HISTORY_MAX) history.done.shift();
  history.undone.length = 0;
  return entry;
}

// An abandoned new card leaves no trace: drop the entry that created it instead of recording its removal.
function absorb(ops, clientId) {
  const last = history.done[history.done.length - 1];
  const dels = ops.filter((o) => o.t === 'card.del').map((o) => o.id);
  if (last && dels.length && last.ops.some((o) => o.t === 'card.put' && dels.includes(o.card.id))) history.done.pop();
  applyOps(ops, clientId);
}

function undo(clientId) {
  const e = history.done.pop();
  if (!e) return null;
  applyOps(e.inverse, clientId);
  history.undone.push(e);
  broadcast({ history: { kind: 'undo', entry: entrySummary(e), clientId: clientId || null } });
  return e;
}

function redo(clientId) {
  const e = history.undone.pop();
  if (!e) return null;
  applyOps(e.ops, clientId);
  history.done.push(e);
  broadcast({ history: { kind: 'redo', entry: entrySummary(e), clientId: clientId || null } });
  return e;
}

// ---------- open browser tabs ----------
// The extension reports which tabs show which card. Kept in memory only: tab ids die with the browser.
let openTabs = [];
let tabsOwner = null;
function setTabs(list, clientId) {
  openTabs = (Array.isArray(list) ? list : []).filter((t) => t && state.cards[t.cardId]).map((t) => ({ tabId: t.tabId, cardId: t.cardId, active: !!t.active }));
  tabsOwner = clientId || null;
  broadcast({ tabs: openTabs, browser: !!tabsOwner });
}

// ---------- page titles ----------
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return m;
  });
}

async function fetchTitle(url) {
  try {
    if (!/^https?:\/\//i.test(url) || typeof fetch !== 'function') return null;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Burrow/1.0', accept: 'text/html' },
      redirect: 'follow',
    });
    if (!/html/i.test(res.headers.get('content-type') || '')) return null;
    const html = (await res.text()).slice(0, 300000);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
               html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const raw = (og && og[1]) || (t && t[1]);
    return raw ? decodeEntities(raw).trim() : null;
  } catch (e) {
    return null;
  }
}

// ---------- adding pages from the browser ----------
function boardCards(boardId) {
  return Object.values(state.cards).filter(c => c.boardId === boardId);
}

function cardOnBoardWithUrl(boardId, url) {
  const k = shared.urlKey(url);
  return k ? boardCards(boardId).find(c => (c.urls || []).some(u => shared.urlKey(u.url) === k)) : null;
}

function spotUnder(parent, cards) {
  if (parent) {
    const kids = shared.kidsOf(state, parent.id);
    return { y: parent.y + 150, x: kids.length ? Math.max(...kids.map(k => k.x)) + CARD_W + 24 : parent.x };
  }
  if (cards.length) return { x: Math.max(...cards.map(c => c.x)) + CARD_W + 48, y: Math.min(...cards.map(c => c.y)) };
  return { x: 0, y: 0 };
}

// Where a page goes: under `parentId` (a card bound to the tab it was opened from), next to it with
// `sibling`, or by default under the capture target of the active board.
function placement({ parentId, sibling, boardId }) {
  let parent = parentId && state.cards[parentId] ? state.cards[parentId] : null;
  let bId = parent ? parent.boardId : (state.boards[boardId] ? boardId : state.settings.activeBoardId);
  if (!parent && !parentId) {
    const b = state.boards[bId];
    parent = b && b.focusId && state.cards[b.focusId] ? state.cards[b.focusId] : null;
  }
  const anchor = parent;
  if (sibling && parent) parent = shared.parentsOf(state, parent.id)[0] || null;
  return { parent, anchor, boardId: bId, board: state.boards[bId] };
}

function preview({ url, title, parentId, sibling }) {
  const { parent, board } = placement({ parentId, sibling });
  const existing = url ? cardOnBoardWithUrl(board.id, url) : null;
  const t = shared.cleanTitle(title || '', url);
  const known = existing ? null : shared.findConcept(state, { title: t, url }, board.id);
  return {
    title: existing ? existing.title : t,
    parent: parent ? { id: parent.id, title: parent.title } : null,
    board: { id: board.id, name: board.name },
    existing: existing ? {
      id: existing.id, title: existing.title, status: existing.status,
      linkedUnder: !!(parent && Object.values(state.links).some(l => l.from === parent.id && l.to === existing.id)),
    } : null,
    known: known ? { status: known.status, board: state.boards[known.boardId].name } : null,
  };
}

// context: where a dive came from, { text: the sentence, quote: the selected words, fromCardId, fromUrl (with #:~:text=) }.
// exactTitle: use `title` as typed (a selection) instead of cleaning it like a page title.
async function capture({ url, title, note, boardId, parentId, sibling, effects, label, clientId, context, exactTitle }) {
  url = String(url || '').trim();
  let rawTitle = String(title || '').trim();
  if (!rawTitle && url) rawTitle = (await fetchTitle(url)) || '';
  const { parent, anchor, board } = placement({ parentId, sibling, boardId });
  const bId = board.id;
  const cards = boardCards(bId);
  const ops = [];

  const withCard = (id) => (effects || []).map(fx => (fx.kind === 'bind' && !fx.cardId ? { ...fx, cardId: id } : fx));

  // Same page already on this board: just make sure it hangs under the parent.
  const existing = url ? cardOnBoardWithUrl(bId, url) : null;
  if (existing) {
    effects = withCard(existing.id);
    if (parent && parent.id !== existing.id && !Object.values(state.links).some(l => l.from === parent.id && l.to === existing.id)) {
      ops.push({ t: 'link.put', link: { id: shared.uid('l_'), boardId: bId, from: parent.id, to: existing.id } });
    }
    const entry = record(ops, { label: label || `Linked “${existing.title}”`, effects, source: 'browser', clientId });
    return { card: existing, parent, existing: true, board, entry };
  }

  let spot = spotUnder(parent, cards);
  if (sibling && anchor && !parent) spot = { x: anchor.x + CARD_W + 24, y: anchor.y };
  const card = {
    id: shared.uid('c_'), boardId: bId, title: exactTitle && rawTitle ? rawTitle.replace(/\s+/g, ' ').slice(0, 200) : shared.cleanTitle(rawTitle, url),
    urls: url ? [{ url, title: rawTitle, visitedAt: Date.now() }] : [],
    note: note ? String(note).slice(0, 4000) : '', status: 'todo', x: spot.x, y: spot.y, createdAt: Date.now(), source: 'capture',
  };
  if (context && typeof context === 'object') {
    card.context = {
      text: String(context.text || '').slice(0, 600), quote: String(context.quote || '').slice(0, 300),
      fromCardId: state.cards[context.fromCardId] ? context.fromCardId : (parent ? parent.id : null), fromUrl: String(context.fromUrl || '').slice(0, 2000),
    };
  }
  ops.push({ t: 'card.put', card });
  effects = withCard(card.id);
  // The same concept on another board: share it, so what is understood there is understood here.
  const known = shared.findConcept(state, card, bId);
  if (known) ops.push(...shared.joinOps(known, card));
  if (parent) ops.push({ t: 'link.put', link: { id: shared.uid('l_'), boardId: bId, from: parent.id, to: card.id } });
  const entry = record(ops, {
    label: label || `Added “${card.title}”${parent ? ` under “${parent.title}”` : ''}`, effects, source: 'browser', clientId,
  });
  return { card: state.cards[card.id] || card, parent, existing: false, board, known: known ? state.boards[known.boardId].name : null, entry };
}

// Same-tab navigation: the page becomes another source of the card. Not an undo step.
// Search result pages are how you find sources, not sources themselves.
function isSearchUrl(url) {
  try {
    const u = new URL(url); const h = u.hostname.replace(/^www\./, '');
    return (/^google\.[a-z.]+$/.test(h) && u.pathname === '/search') || (h === 'duckduckgo.com' && u.searchParams.has('q')) ||
      (h === 'bing.com' && u.pathname === '/search') || (/wikipedia\.org$/.test(h) && /Special:Search/.test(u.pathname + u.search));
  } catch (e) { return false; }
}

function addSource({ cardId, url, title }) {
  const c = state.cards[cardId];
  if (!c || !/^https?:/i.test(url || '') || isSearchUrl(url)) return false;
  const k = shared.urlKey(url);
  if ((c.urls || []).some(u => shared.urlKey(u.url) === k)) return false;
  const urls = [...(c.urls || []), { url, title: String(title || '').slice(0, 300), visitedAt: Date.now() }].slice(-30);
  applyOps([{ t: 'card.put', card: { id: c.id, boardId: c.boardId, urls } }], 'browser');
  return true;
}

// Where you were on a page when you left it, so coming back (or reopening it) lands there again. Not an undo step.
function setAnchor({ cardId, url, scroll, fragment }) {
  const c = state.cards[cardId];
  if (!c) return false;
  const k = shared.urlKey(url);
  const i = (c.urls || []).findIndex(u => shared.urlKey(u.url) === k);
  if (i < 0) return false;
  const prev = c.urls[i];
  const next = { ...prev, scroll: Math.max(0, Math.round(Number(scroll) || 0)), fragment: fragment ? String(fragment).slice(0, 300) : null, visitedAt: Date.now() };
  if (prev.scroll === next.scroll && prev.fragment === next.fragment) return false;
  const urls = c.urls.slice(); urls[i] = next;
  applyOps([{ t: 'card.put', card: { id: c.id, boardId: c.boardId, urls } }], 'browser');
  return true;
}

const crumbOf = (c) => {
  const u = (c.urls || [])[0];
  const from = c.context && c.context.fromCardId && state.cards[c.context.fromCardId];
  return {
    id: c.id, title: c.title, status: c.status, url: u ? u.url : '',
    anchor: u && (u.scroll || u.fragment) ? { scroll: u.scroll || 0, fragment: u.fragment || null } : null,
    context: c.context && c.context.text ? { text: c.context.text, quote: c.context.quote, fromUrl: c.context.fromUrl, fromCardId: from ? from.id : null, fromTitle: from ? from.title : null } : null,
  };
};

// Trails for the breadcrumb strip: one per bound card, plus the capture target for unbound tabs.
function crumbs(cardIds, prefer) {
  const out = {};
  for (const id of cardIds || []) if (state.cards[id]) out[id] = shared.trailOf(state, id, prefer).map(crumbOf);
  const b = state.boards[state.settings.activeBoardId];
  const f = b && b.focusId && state.cards[b.focusId];
  return { trails: out, focus: f ? shared.trailOf(state, f.id).map(crumbOf) : [], board: b ? b.name : null, accent: state.settings.accent };
}

// After a browser restart: which card does each open URL belong to?
function match(urls) {
  const out = {};
  for (const url of urls || []) {
    const k = shared.urlKey(url);
    if (!k) continue;
    let best = null;
    for (const c of Object.values(state.cards)) {
      if (!(c.urls || []).some(u => shared.urlKey(u.url) === k)) continue;
      if (!best || c.createdAt > best.createdAt) best = c;
    }
    if (best) out[url] = best.id;
  }
  return out;
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

// Only our own pages and browser extensions may call the API; random websites may not.
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  if (/^(moz|chrome)-extension:\/\//.test(o)) return true;
  return o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`;
}

function send(res, code, body, headers) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, Object.assign({ 'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 5e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const CAPTURE_PAGE = `<!doctype html><meta charset="utf-8"><title>Burrow</title>
<style>body{background:#08080a;color:#ececf1;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}</style>
<p id="m">Adding…</p><script>
const q=new URLSearchParams(location.search);
fetch('/api/capture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:q.get('url'),title:q.get('title')})})
.then(r=>r.json()).then(d=>{m.textContent=d.ok?('Added “'+d.card.title+'”'+(d.parent?' under “'+d.parent.title+'”':'')):'Could not add: '+d.error;setTimeout(()=>window.close(),900)})
.catch(e=>m.textContent='Could not add: '+e.message);
</script>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;
  const cors = /^(moz|chrome)-extension:\/\//.test(req.headers.origin || '')
    ? { 'access-control-allow-origin': req.headers.origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' }
    : {};

  try {
    if (req.method === 'OPTIONS') return send(res, originAllowed(req) ? 204 : 403, '', cors);
    if (p.startsWith('/api/') && !originAllowed(req)) return send(res, 403, { ok: false, error: 'origin not allowed' });

    if (p === '/api/health') return send(res, 200, { ok: true, app: 'burrow', rev, dataFile: DATA_FILE }, cors);

    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { rev, state }, cors);

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...cors });
      res.write(`retry: 1500\ndata: ${JSON.stringify({ hello: true, rev, tabs: openTabs, browser: !!tabsOwner })}\n\n`);
      streams.add(res);
      const who = u.searchParams.get('clientId');
      req.on('close', () => {
        streams.delete(res);
        // The browser went away: its tabs are no longer open.
        if (who && who === tabsOwner) setTabs([], null);
      });
      return;
    }

    if (p === '/api/do' && req.method === 'POST') {
      const body = await readBody(req);
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (body.absorb) { absorb(ops, body.clientId); return send(res, 200, { ok: true, rev }, cors); }
      const e = record(ops, { label: body.label, effects: body.effects, coalesce: body.coalesce, sticky: body.sticky, inverse: body.inverse, source: body.source, clientId: body.clientId });
      return send(res, 200, { ok: true, rev, entry: e ? entrySummary(e) : null }, cors);
    }

    if ((p === '/api/undo' || p === '/api/redo') && req.method === 'POST') {
      const body = await readBody(req);
      const e = p === '/api/undo' ? undo(body.clientId) : redo(body.clientId);
      if (!e) return send(res, 200, { ok: true, empty: true }, cors);
      return send(res, 200, { ok: true, rev, entry: entrySummary(e), ops: p === '/api/undo' ? e.inverse : e.ops, orig: e.ops }, cors);
    }

    if (p === '/api/history' && req.method === 'GET') {
      const top = (a) => (a.length ? entrySummary(a[a.length - 1]) : null);
      return send(res, 200, { ok: true, undo: top(history.done), redo: top(history.undone) }, cors);
    }

    // The app opens links through the extension when it's connected, so an already open page is reused.
    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = !!tabsOwner && /^(https?|file):/i.test(body.url || '');
      const c = state.cards[body.cardId];
      const u = c && (c.urls || []).find(x => shared.urlKey(x.url) === shared.urlKey(body.url));
      const anchor = u && (u.scroll || u.fragment) ? { scroll: u.scroll || 0, fragment: u.fragment || null } : null;
      if (ok) broadcast({ open: { url: body.url, cardId: body.cardId || null, anchor } });
      return send(res, 200, { ok: true, routed: ok }, cors);
    }

    if (p === '/api/tabs') {
      if (req.method === 'POST') { const body = await readBody(req); setTabs(body.tabs, body.clientId); }
      return send(res, 200, { ok: true, tabs: openTabs }, cors);
    }

    if (p === '/api/crumbs' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, rev, ...crumbs(body.cardIds, body.prefer) }, cors);
    }

    if (p === '/api/match' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, cards: match(body.urls) }, cors);
    }

    if (p === '/api/preview' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, ...preview(body) }, cors);
    }

    if (p === '/api/anchor' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, saved: setAnchor(body) }, cors);
    }

    if (p === '/api/source' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, added: addSource(body) }, cors);
    }

    if (p === '/api/ops' && req.method === 'POST') {
      const body = await readBody(req);
      const applied = applyOps(Array.isArray(body.ops) ? body.ops : [], body.clientId);
      return send(res, 200, { ok: true, rev, applied: applied.length });
    }

    if (p === '/api/capture' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url && !body.title) return send(res, 400, { ok: false, error: 'url or title required' }, cors);
      const r = await capture(body);
      return send(res, 200, {
        ok: true, existing: r.existing, board: { id: r.board.id, name: r.board.name },
        card: { id: r.card.id, title: r.card.title, status: r.card.status },
        parent: r.parent ? { id: r.parent.id, title: r.parent.title } : null,
        known: r.known || null, entry: r.entry ? entrySummary(r.entry) : null,
      }, cors);
    }

    if (p === '/api/focus' && req.method === 'GET') {
      const b = state.boards[state.settings.activeBoardId];
      const f = b && b.focusId ? state.cards[b.focusId] : null;
      return send(res, 200, { ok: true, board: b ? { id: b.id, name: b.name } : null, focus: f ? { id: f.id, title: f.title } : null }, cors);
    }

    if (p === '/api/title' && req.method === 'GET') {
      const url = u.searchParams.get('url') || '';
      const t = await fetchTitle(url);
      return send(res, 200, { ok: true, title: shared.cleanTitle(t || '', url) });
    }

    if (p === '/capture' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(CAPTURE_PAGE);
    }

    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[burrow]', e);
    return send(res, 500, { ok: false, error: String(e.message || e) }, cors);
  }
});

load();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[burrow] Port ${PORT} is already in use. Is Burrow already running?`);
    process.exit(2);
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`[burrow] serving http://${HOST}:${PORT}  data: ${DATA_FILE}`);
});

function shutdown() {
  if (saveTimer) saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
