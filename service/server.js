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
      state = shared.normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
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

// ---------- capture from the browser ----------
function boardCards(boardId) {
  return Object.values(state.cards).filter(c => c.boardId === boardId);
}

async function capture({ url, title, note, boardId }) {
  url = String(url || '').trim();
  let rawTitle = String(title || '').trim();
  if (!rawTitle && url) rawTitle = (await fetchTitle(url)) || '';
  const bId = state.boards[boardId] ? boardId : state.settings.activeBoardId;
  const board = state.boards[bId];
  const cards = boardCards(bId);
  const parent = board.focusId && state.cards[board.focusId] ? state.cards[board.focusId] : null;
  const ops = [];

  // Same page already on this board: just make sure it hangs under the focused card.
  const existing = url ? cards.find(c => c.url && c.url === url) : null;
  if (existing) {
    if (parent && parent.id !== existing.id) {
      ops.push({ t: 'link.put', link: { id: shared.uid('l_'), boardId: bId, from: parent.id, to: existing.id } });
    }
    applyOps(ops, 'capture');
    return { card: existing, parent, existing: true, board };
  }

  let x, y;
  if (parent) {
    const kids = Object.values(state.links).filter(l => l.from === parent.id).map(l => state.cards[l.to]).filter(Boolean);
    y = parent.y + 150;
    x = kids.length ? Math.max(...kids.map(k => k.x)) + CARD_W + 24 : parent.x;
  } else if (cards.length) {
    x = Math.max(...cards.map(c => c.x)) + CARD_W + 48;
    y = Math.min(...cards.map(c => c.y));
  } else { x = 0; y = 0; }

  const card = {
    id: shared.uid('c_'), boardId: bId, title: shared.cleanTitle(rawTitle, url), url: url || '',
    note: note ? String(note).slice(0, 4000) : '', status: 'todo', x, y, createdAt: Date.now(), source: 'capture',
  };
  ops.push({ t: 'card.put', card });
  if (parent) ops.push({ t: 'link.put', link: { id: shared.uid('l_'), boardId: bId, from: parent.id, to: card.id } });
  applyOps(ops, 'capture');
  return { card, parent, existing: false, board };
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

    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { rev, state });

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 1500\ndata: ${JSON.stringify({ hello: true, rev })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
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
        card: { id: r.card.id, title: r.card.title },
        parent: r.parent ? { id: r.parent.id, title: r.parent.title } : null,
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
