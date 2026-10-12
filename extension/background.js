// Burrow for Zen / Firefox: the browser side of the map.
// - Tabs are bound to cards. A tab opened from a bound tab asks (once, when you first look at it)
//   whether to add its page under that card. Navigating inside a bound tab adds sources to its card.
// - Every page shows the trail from the top-level card down to this tab's card (content.js).
// - A card's notes live in the Burrow app; the notes shortcut, Ctrl+click on a breadcrumb, or a click on a
//   card without a page shows them there.
// - Undo/redo share one history with the app, kept by the service.
// The service (service/server.js) does the map logic; this file is browser glue.
const API = 'http://127.0.0.1:7417';
const CLIENT = 'ext-' + Math.random().toString(36).slice(2, 10);
const DEFAULT_SETTINGS = { prompt: true, crumb: true, engine: 'google', focus: 'off' };
const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
};
const searchUrl = (q) => (ENGINES[S.settings.engine] || ENGINES.google) + encodeURIComponent(q);

// ---------- persisted state ----------
// Tab ids are only valid until the browser restarts, so this is rebuilt on startup (see rebind()).
// alias: a tab closed by undo and reopened by redo gets a new id; effects keep the old one.
let S = { bindings: {}, pending: {}, asked: {}, prefer: {}, alias: {}, hidden: {}, settings: { ...DEFAULT_SETTINGS } };
const ready = browser.storage.local.get('burrow').then((r) => {
  if (r.burrow) S = { ...S, ...r.burrow, settings: { ...DEFAULT_SETTINGS, ...(r.burrow.settings || {}) } };
});
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => browser.storage.local.set({ burrow: S }), 50);
}

// ---------- service ----------
async function api(path, body) {
  const r = await fetch(API + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: CLIENT, ...body }) });
  if (!r.ok) throw new Error('Burrow service: ' + r.status);
  return r.json();
}

let online = false;
function connect() {
  const es = new EventSource(API + '/api/events?clientId=' + CLIENT);
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.hello) { online = true; pushTabs(); refresh(); return; }
    if (m.history) return onHistory(m.history);
    if (m.open) return openFromApp(m.open);
    if (m.ops) refresh();
  };
  es.onerror = () => { online = false; };
}

// ---------- bindings ----------
// created: this tab made the card (so "Not related" may remove it, not just let go of it).
function bind(tabId, cardId, url, created = false) {
  S.bindings[tabId] = { cardId, url: url || '', created };
  delete S.pending[tabId];
  browser.sessions.setTabValue(tabId, 'burrow', { cardId }).catch(() => {});
  save(); pushTabs(); refresh();
}
function unbind(tabId) {
  if (!S.bindings[tabId]) return;
  delete S.bindings[tabId];
  browser.sessions.removeTabValue(tabId, 'burrow').catch(() => {});
  browser.browserAction.setBadgeText({ tabId, text: '' }).catch(() => {});
  save(); pushTabs(); refresh();
}
// Switch to a tab, first showing it if focus mode hid it.
async function activate(tabId) {
  if (S.hidden[tabId]) { await browser.tabs.show(tabId).catch(() => {}); delete S.hidden[tabId]; save(); }
  return browser.tabs.update(tabId, { active: true });
}
const tabOfCard = (cardId) => Object.keys(S.bindings).map(Number).find((t) => S.bindings[t].cardId === cardId);

let pushT = null;
function pushTabs() {
  clearTimeout(pushT);
  pushT = setTimeout(async () => {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tabs = Object.entries(S.bindings).map(([t, b]) => ({ tabId: +t, cardId: b.cardId, active: !!active && active.id === +t }));
    api('/api/tabs', { tabs }).catch(() => {});
  }, 200);
}

// After a browser restart tab ids are new: find each tab's card from the value stored on the tab
// (survives session restore), or else from its URL.
async function rebind() {
  S.bindings = {}; S.pending = {}; S.asked = {}; S.hidden = {};
  const tabs = await browser.tabs.query({});
  const unknown = [];
  for (const t of tabs) {
    const v = await browser.sessions.getTabValue(t.id, 'burrow').catch(() => null);
    if (v && v.cardId) S.bindings[t.id] = { cardId: v.cardId, url: t.url };
    else if (/^https?:/.test(t.url || '')) unknown.push(t);
  }
  try {
    const { cards } = await api('/api/match', { urls: unknown.map((t) => t.url) });
    for (const t of unknown) if (cards[t.url]) S.bindings[t.id] = { cardId: cards[t.url], url: t.url };
  } catch (e) { /* service not up yet; tabs stay unbound */ }
  save(); pushTabs(); refresh();
}

browser.runtime.onStartup.addListener(() => ready.then(rebind));
browser.runtime.onInstalled.addListener(() => ready.then(rebind));

// ---------- tab events ----------
const isPage = (url) => /^(https?|file):/.test(url || '');
const sameUrl = (a, b) => String(a || '').replace(/#.*$/, '').replace(/\/$/, '') === String(b || '').replace(/#.*$/, '').replace(/\/$/, '');

function openedFrom(tabId, openerId) {
  const b = S.bindings[openerId];
  if (!b || S.bindings[tabId] || S.pending[tabId]) return;
  S.pending[tabId] = { parentId: b.cardId, opener: openerId };
  save();
}
browser.tabs.onCreated.addListener((tab) => { if (tab.openerTabId != null) ready.then(() => openedFrom(tab.id, tab.openerTabId)); });
browser.webNavigation.onCreatedNavigationTarget.addListener((d) => ready.then(() => openedFrom(d.tabId, d.sourceTabId)));

browser.tabs.onActivated.addListener(({ tabId }) => ready.then(() => { maybePrompt(tabId); pushTabs(); pushOutline(); }));

browser.tabs.onUpdated.addListener((tabId, ch, tab) => ready.then(() => {
  const b = S.bindings[tabId];
  // Same-tab navigation: the new page is another source of the same card. Never a new card.
  if (b && ch.url && isPage(ch.url) && !sameUrl(ch.url, b.url)) {
    b.url = ch.url; save();
    api('/api/source', { cardId: b.cardId, url: ch.url, title: tab.title }).catch(() => {});
  }
  if (ch.status === 'complete') {
    if (b && b.url && sameUrl(tab.url, b.url)) api('/api/source', { cardId: b.cardId, url: tab.url, title: tab.title }).catch(() => {});
    if (tab.active) maybePrompt(tabId);
    setTimeout(() => badge(tabId), 1500);
  }
}));

browser.tabs.onRemoved.addListener((tabId) => ready.then(() => {
  const had = S.bindings[tabId];
  delete S.bindings[tabId]; delete S.pending[tabId]; delete S.asked[tabId]; delete S.hidden[tabId];
  save();
  if (had) pushTabs();
}));

// ---------- confirm prompt ----------
// Shown the first time you look at a tab opened from a bound tab. Background tabs you never visit never ask.
const prompts = new Map(); // tabId -> { parentId, url, title, preview, popupWindowId }

async function maybePrompt(tabId) {
  const p = S.pending[tabId];
  if (!p || S.asked[tabId] || !S.settings.prompt || prompts.has(tabId) || diving.has(tabId) || S.bindings[tabId]) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || tab.status !== 'complete' || !isPage(tab.url)) return;
  S.asked[tabId] = true; save();
  let preview;
  try { preview = await api('/api/preview', { url: tab.url, title: tab.title, parentId: p.parentId }); } catch (e) { return; }
  // Already on the map under this card: just bind the tab, nothing to ask.
  if (preview.existing && preview.parent && preview.existing.linkedUnder) { bind(tabId, preview.existing.id, tab.url); return; }
  const info = { parentId: p.parentId, url: tab.url, title: tab.title, preview };
  prompts.set(tabId, info);
  const view = promptView(info);
  if (await sendWhenReady(tabId, { t: 'prompt', ...view })) return;
  // No content script on this page (PDF viewer, addons.mozilla.org, …): ask in a small window instead.
  const w = await browser.windows.create({ type: 'popup', url: browser.runtime.getURL('prompt.html?tab=' + tabId), width: 480, height: 150 });
  info.popupWindowId = w.id;
}

function promptView(info) {
  const pv = info.preview;
  const parent = pv.parent ? pv.parent.title : pv.board.name;
  let note = '';
  if (pv.existing) note = `Already on ${pv.board.name}; this links it under “${parent}”.`;
  else if (pv.known) note = pv.known.status === 'done' ? `Already understood on ${pv.known.board}.` : `Also on ${pv.known.board}.`;
  return { title: pv.title, parent, note };
}

async function answerPrompt(tabId, choice) {
  const info = prompts.get(tabId);
  if (!info) return;
  prompts.delete(tabId);
  if (info.popupWindowId != null) browser.windows.remove(info.popupWindowId).catch(() => {});
  // Ignored: never ask again (asked stays set), but keep the parent for a later capture shortcut.
  if (choice !== 'child' && choice !== 'sibling') return;
  await addPage(tabId, { url: info.url, title: info.title, parentId: info.parentId, how: choice });
}

// ---------- adding pages ----------
// tabId: the tab showing this page, which becomes bound to the card (null for a link that isn't open).
// how: 'child' (under parentId), 'sibling' (next to parentId, under its parent on the breadcrumb) or
// 'loose' (on the board with no parent). moveFrom: the card this tab was bound to, which gives the page up.
async function addPage(tabId, { url, title, parentId, how = 'child', exactTitle, moveFrom }, toastTab = tabId) {
  let r;
  const effects = tabId == null ? [] : moveFrom ? [{ kind: 'unbind', tabId, cardId: moveFrom }, { kind: 'bind', tabId }] : [{ kind: 'bind', tabId }];
  try {
    r = await api('/api/capture', { url, title, parentId, sibling: how === 'sibling', loose: how === 'loose', prefer: S.prefer, moveFrom, exactTitle, effects });
  } catch (e) { return offline(toastTab); }
  if (tabId != null) {
    if (r.parent) S.prefer[r.card.id] = r.parent.id;
    bind(tabId, r.card.id, url, !r.existing);
  } else refresh();
  toast(toastTab, addedText(r), !!r.entry);
  return r;
}

function addedText(r) {
  if (r.existing) return `“${r.card.title}” is already on the map${r.parent ? ` (now under “${r.parent.title}”)` : ''}`;
  return `Added “${r.card.title}”${r.parent ? ` under “${r.parent.title}”` : ` to ${r.board.name}${r.loose ? ' on its own' : ''}`}${r.known ? ` · known from ${r.known}` : ''}`;
}

// The card's own page, from the breadcrumb ('' when it has none yet).
const ownUrl = (cardId) => ((lastCrumbs.trails[cardId] || []).slice(-1)[0] || {}).url || '';

async function captureTab(tab, how = 'child') {
  if (!tab) return;
  if (!isPage(tab.url)) return toast(tab.id, 'Only web pages and files can be added');
  const b = S.bindings[tab.id];
  if (b) {
    // A bound tab that followed a link: the page you're on can become a card of its own.
    const own = ownUrl(b.cardId);
    if (!own || sameUrl(own, tab.url)) return toast(tab.id, how === 'sibling' ? `This tab is “${cardTitle(b.cardId)}”. Select words to add them next to it.` : `This tab is already “${cardTitle(b.cardId)}”`);
    return addPage(tab.id, { url: tab.url, title: tab.title, parentId: b.cardId, how, moveFrom: b.cardId });
  }
  // An ignored tab opened from a card still goes under (or next to) that card; otherwise the capture target.
  const p = S.pending[tab.id];
  prompts.delete(tab.id);
  await addPage(tab.id, { url: tab.url, title: tab.title, parentId: p ? p.parentId : undefined, how });
}

// Alt+Shift+A: next to this tab's card instead of under it. The selected words if there are any, else the page.
async function addNextTo(tab) {
  if (!tab) return;
  const g = await browser.tabs.sendMessage(tab.id, { t: 'grab', kind: 'selection' }).catch(() => null);
  if (g && g.text) return cardFromSelection(tab, null, 'sibling', g);
  return captureTab(tab, 'sibling');
}

// ---------- undo / redo ----------
async function historyStep(kind, tabId) {
  let d;
  try { d = await api('/api/' + kind, {}); } catch (e) { return offline(tabId); }
  if (d.empty) return toast(tabId, kind === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  toast(tabId, `${kind === 'undo' ? 'Undid' : 'Redid'}: ${d.entry.label}`, false, kind === 'undo');
}

// Reverse (undo) or replay (redo) what the browser did alongside a change. Runs for undo from the app too.
// Effects: bind {tabId, cardId} · unbind {tabId, cardId} · opened {tabId, url}: a tab Burrow opened (undo
// closes it, redo reopens it) · closed {tabId, url, cardId, index, windowId}: a tab Burrow closed (undo
// restores it from the session, redo closes it again) · activated {fromTabId, toTabId}: Burrow switched tabs.
const tabNow = (id) => { let t = id; for (let i = 0; i < 20 && S.alias[t] != null; i++) t = S.alias[t]; return t; };
const tabExists = (id) => browser.tabs.get(id).then(() => true, () => false);

async function onHistory({ kind, entry }) {
  const undo = kind === 'undo';
  for (const fx of (entry.effects || []).slice()[undo ? 'reverse' : 'slice']()) {
    if (fx.kind === 'bind') {
      const t = tabNow(fx.tabId);
      if (!(await tabExists(t))) continue;
      if (undo) { unbind(t); S.asked[t] = true; save(); }
      else if (fx.cardId) bind(t, fx.cardId);
    } else if (fx.kind === 'opened') {
      const t = tabNow(fx.tabId);
      if (undo) { if (await tabExists(t)) await browser.tabs.remove(t); }
      else if (!(await tabExists(t))) {
        const tab = await browser.tabs.create({ url: fx.url, active: false });
        S.alias[t] = tab.id; save();
      }
    } else if (fx.kind === 'unbind') {
      const t = tabNow(fx.tabId);
      if (!(await tabExists(t))) continue;
      if (undo) bind(t, fx.cardId); else { unbind(t); S.asked[t] = true; save(); }
    } else if (fx.kind === 'closed') {
      const t = tabNow(fx.tabId);
      if (!undo) { if (await tabExists(t)) await browser.tabs.remove(t); continue; }
      if (await tabExists(t)) continue;
      // Bring the tab back with its history, or at least its page.
      const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
      const hit = recent.find((s) => s.tab && sameUrl(s.tab.url, fx.url));
      let tab = null;
      if (hit) tab = (await browser.sessions.restore(hit.tab.sessionId).catch(() => null) || {}).tab || null;
      if (!tab) tab = await browser.tabs.create({ url: fx.url, index: fx.index, windowId: fx.windowId }).catch(() => browser.tabs.create({ url: fx.url }));
      S.alias[t] = tab.id; save();
      if (fx.cardId) bind(tab.id, fx.cardId, fx.url);
    } else if (fx.kind === 'activated') {
      const t = tabNow(undo ? fx.fromTabId : fx.toTabId);
      if (await tabExists(t)) activate(t).catch(() => {});
    }
  }
}

// ---------- breadcrumb ----------
const ports = new Map(); // tabId -> port to content.js
let lastCrumbs = { trails: {}, focus: [], board: null, accent: null };
let keymap = [];
browser.commands.getAll().then((cs) => { keymap = cs.filter((c) => c.shortcut && !c.name.startsWith('_execute_')).map((c) => ({ name: c.name, shortcut: c.shortcut })); });
const shortcutOf = (name) => (keymap.find((k) => k.name === name) || {}).shortcut || '';

let refreshT = null;
function refresh() {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    const cardIds = [...new Set([...Object.values(S.bindings), ...Object.values(S.pending).map((p) => ({ cardId: p.parentId }))].map((b) => b.cardId))];
    try { lastCrumbs = await api('/api/crumbs', { cardIds, prefer: S.prefer }); } catch (e) { return; }
    // A bound card that no longer exists (deleted, or its creation undone) frees its tab.
    for (const [t, b] of Object.entries(S.bindings)) if (!lastCrumbs.trails[b.cardId]) unbind(+t);
    for (const [tabId, port] of ports) port.postMessage({ t: 'view', ...viewFor(tabId) });
    for (const t of Object.keys(S.bindings)) badge(+t);
    pushOutline();
  }, 120);
}

function viewFor(tabId) {
  const b = S.bindings[tabId], p = S.pending[tabId];
  // Unbound tabs show where a capture would go: under the card it was opened from, else the capture target.
  const trail = (b ? lastCrumbs.trails[b.cardId] : (p && lastCrumbs.trails[p.parentId]) || lastCrumbs.focus) || [];
  return {
    trail: trail.map((c) => ({ ...c, open: tabOfCard(c.id) != null })),
    bound: !!b, show: S.settings.crumb, accent: lastCrumbs.accent, board: lastCrumbs.board,
    undoKey: shortcutOf('undo'), keys: keymap,
  };
}

// Where no content script runs, the toolbar badge carries the depth instead.
function badge(tabId) {
  const b = S.bindings[tabId];
  const text = b && !ports.has(tabId) && S.settings.crumb ? String((lastCrumbs.trails[b.cardId] || []).length || '') : '';
  browser.browserAction.setBadgeText({ tabId, text }).catch(() => {});
  if (text) browser.browserAction.setBadgeBackgroundColor({ tabId, color: lastCrumbs.accent || '#b8a4ff' }).catch(() => {});
}

// ---------- talking to pages ----------
browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidebar') return connectSidebar(port);
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (tabId == null) return;
  ready.then(() => {
    ports.set(tabId, port);
    badge(tabId);
    if (restores.has(tabId)) { port.postMessage({ t: 'restore', anchor: restores.get(tabId) }); restores.delete(tabId); }
    const later = laterToasts.get(tabId);
    if (later && Date.now() - later.at < 8000) port.postMessage(later.msg);
    else laterToasts.delete(tabId);
    port.postMessage({ t: 'view', ...viewFor(tabId) });
    if (prompts.has(tabId) && prompts.get(tabId).popupWindowId == null) port.postMessage({ t: 'prompt', ...promptView(prompts.get(tabId)) });
  });
  port.onDisconnect.addListener(() => { if (ports.get(tabId) === port) ports.delete(tabId); });
  port.onMessage.addListener((m) => ready.then(() => onPageMessage(tabId, m)));
});

async function onPageMessage(tabId, m) {
  if (m.t === 'answer') return answerPrompt(tabId, m.choice);
  if (m.t === 'cmd') return runCommand(m.name, await browser.tabs.get(tabId));
  if (m.t === 'undo') return historyStep('undo', tabId);
  if (m.t === 'redo') return historyStep('redo', tabId);
  if (m.t === 'go') return goTo(m.cardId, tabId);
  if (m.t === 'notes') return openNotes(m.cardId, tabId, false);
  if (m.t === 'askAnswer') { const had = asks.has(tabId), cardId = asks.get(tabId); asks.delete(tabId); if (had && m.yes) launchApp(cardId, tabId); return; }
  if (m.t === 'from') return backToSource(m.cardId, tabId);
  if (m.t === 'anchor') {
    const b = S.bindings[tabId];
    if (b && sameUrl(m.url, b.url)) api('/api/anchor', { cardId: b.cardId, url: m.url, scroll: m.scroll, fragment: m.fragment }).catch(() => {});
  }
}

// Wait briefly for a page's content script to connect (it loads at document_idle).
async function sendWhenReady(tabId, msg, waitMs = 800) {
  for (let i = 0; i < waitMs / 100 && !ports.has(tabId); i++) await new Promise((r) => setTimeout(r, 100));
  const port = ports.get(tabId);
  if (!port) return false;
  port.postMessage(msg);
  return true;
}

function toast(tabId, text, undoable = false, redoable = false) {
  const port = tabId != null && ports.get(tabId);
  if (port) return port.postMessage({ t: 'toast', text, undo: undoable ? shortcutOf('undo') : '', redo: redoable ? shortcutOf('redo') : '' });
  browser.notifications.create('burrow-' + Date.now(), { type: 'basic', iconUrl: browser.runtime.getURL('icons/icon-96.png'), title: 'Burrow', message: text });
}

function offline(tabId) {
  toast(tabId, 'Burrow isn’t running. Start it with: systemctl --user start burrow');
}

// Breadcrumb click: switch to the card's tab, or open its page in a new tab bound to it.
// info: the card's {title, url, anchor} when it isn't on a trail Burrow already knows (palette, sidebar, omnibox).
async function goTo(cardId, fromTabId, info) {
  const t = tabOfCard(cardId);
  if (t != null) {
    const tab = await activate(t);
    browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  const all = Object.values(lastCrumbs.trails).flat().concat(lastCrumbs.focus);
  const c = all.find((x) => x.id === cardId) || info;
  // No page: the card is its notes, so show them in Burrow.
  if (!c || !c.url) return openNotes(cardId, fromTabId, true);
  const tab = await browser.tabs.create({ url: c.url, openerTabId: fromTabId });
  bind(tab.id, cardId, c.url);
  if (c.anchor) restoreWhenLoaded(tab.id, c.anchor);
}

// ---------- notes in the app ----------
// A card's page with its notes is in the Burrow app. When a window of it is open, it shows the card
// (the desktop window raises itself; an app tab is switched to). Otherwise `ask` offers to start it with
// one key in the page; an explicit request (notes shortcut, Ctrl+click) starts it straight away.
// cardId null: just bring Burrow up.
const asks = new Map(); // tabId -> cardId waiting for "open Burrow?"
const cardTitle = (id) => ((Object.values(lastCrumbs.trails).flat().concat(lastCrumbs.focus).find((x) => x.id === id)) ||
  (lastOutline && findNode(lastOutline.roots, id)) || {}).title || 'this card';

async function openNotes(cardId, tabId, ask) {
  let r;
  try { r = await api('/api/reveal', { cardId }); } catch (e) { return offline(tabId); }
  if (r.shown) {
    if (!r.desktop) {
      const appTab = (await browser.tabs.query({})).find((t) => (t.url || '').startsWith(API + '/'));
      if (appTab) { await activate(appTab.id); browser.windows.update(appTab.windowId, { focused: true }).catch(() => {}); }
    }
    return;
  }
  if (ask && tabId != null && ports.has(tabId)) {
    asks.set(tabId, cardId);
    return ports.get(tabId).postMessage({ t: 'ask', text: cardId ? `Burrow isn’t open. Show “${cardTitle(cardId)}” there?` : 'Burrow isn’t open. Start it?', yes: 'Open Burrow', no: 'Not now' });
  }
  return launchApp(cardId, tabId);
}

async function launchApp(cardId, tabId) {
  let r;
  try { r = await api('/api/launch', { cardId }); } catch (e) { return offline(tabId); }
  if (r.launched) return toast(tabId, 'Opening Burrow…');
  // No desktop app next to the service: the app in a tab does the same.
  await browser.tabs.create({ url: API + '/' + (cardId ? '#card=' + encodeURIComponent(cardId) : ''), openerTabId: tabId != null ? tabId : undefined });
}

async function notesOf(tab) {
  if (!tab) return;
  const b = S.bindings[tab.id];
  if (!b) return toast(tab.id, `This tab isn’t on the map. ${shortcutOf('capture-page') || 'Alt+Shift+B'} adds it.`);
  return openNotes(b.cardId, tab.id, false);
}

// A quick note from the toolbar popup, added at the end of the card's notes.
async function quickNote(cardId, text, tabId) {
  let r;
  try { r = await api('/api/note', { cardId, text }); } catch (e) { return { ok: false }; }
  toast(tabId, `Added a note to “${cardTitle(cardId)}”`, !!r.entry);
  return { ok: true };
}

// ---------- return anchors ----------
// content.js reports where you were when a bound tab is hidden; a reopened page scrolls back there.
const restores = new Map(); // tabId -> anchor, sent when the page's content script connects
const laterToasts = new Map(); // tabId -> toast for a page that is still loading
function restoreWhenLoaded(tabId, anchor) {
  if (!anchor) return;
  const port = ports.get(tabId);
  if (port) port.postMessage({ t: 'restore', anchor });
  else restores.set(tabId, anchor);
}

// "From BFS: …" in the breadcrumb: back to the page this card was dived from, at the sentence.
async function backToSource(cardId, fromTabId) {
  const c = Object.values(lastCrumbs.trails).flat().find((x) => x.id === cardId);
  const ctx = c && c.context;
  if (!ctx) return;
  const anchor = { fragment: ctx.quote || ctx.text, center: true };
  const open = ctx.fromCardId != null ? tabOfCard(ctx.fromCardId) : null;
  if (open != null) {
    await activate(open);
    return restoreWhenLoaded(open, anchor);
  }
  if (!ctx.fromUrl) return toast(fromTabId, 'The page it came from isn’t known');
  const tab = await browser.tabs.create({ url: ctx.fromUrl, openerTabId: fromTabId });
  if (ctx.fromCardId) bind(tab.id, ctx.fromCardId, ctx.fromUrl);
  restoreWhenLoaded(tab.id, anchor);
}

// ---------- card from a selection, dive into a link ----------
// Explicit, so no prompt. Selected words become a child card of this tab's card and nothing opens.
// A link's page opens in a new tab bound to its new card; undo closes that tab and returns here.
const diving = new Set(); // tabs Burrow is opening right now; never prompt for them

function parentFor(tab) {
  const b = S.bindings[tab.id], p = S.pending[tab.id];
  return b ? b.cardId : p ? p.parentId : undefined;
}

async function dive(tab, { title, url, context }) {
  if (!title && !url) return;
  const target = url || searchUrl(title);
  const created = await browser.tabs.create({ url: target, openerTabId: tab.id, active: true });
  diving.add(created.id);
  let r;
  try {
    r = await api('/api/capture', {
      title, url: url || '', exactTitle: !url, parentId: parentFor(tab), context,
      label: `Dove into “${title || url}”`,
      effects: [{ kind: 'opened', tabId: created.id, url: target }, { kind: 'bind', tabId: created.id }, { kind: 'activated', fromTabId: tab.id, toTabId: created.id }],
    });
  } catch (e) { diving.delete(created.id); return offline(tab.id); }
  if (r.parent) S.prefer[r.card.id] = r.parent.id;
  bind(created.id, r.card.id, target, true);
  diving.delete(created.id);
  const text = `Dove into “${r.card.title}”${r.parent ? ` under “${r.parent.title}”` : ''}`;
  const msg = { t: 'toast', text, undo: shortcutOf('undo'), redo: '' };
  // The new page is usually still loading, and search pages often reload themselves once (Google adds
  // &sei=), so keep the toast for a few seconds and show it on whichever document connects.
  laterToasts.set(created.id, { msg, at: Date.now() });
  if (ports.has(created.id)) ports.get(created.id).postMessage(msg);
}

// The card keeps the sentence the words came from ("From …" on its page and in the breadcrumb).
// `fallback`: the selection the context menu saw, for pages without a content script.
async function cardFromSelection(tab, fallback, how = 'child', grabbed) {
  if (!tab) return;
  const g = grabbed || await browser.tabs.sendMessage(tab.id, { t: 'grab', kind: 'selection' }).catch(() => null);
  const text = (g && g.text) || String(fallback || '').replace(/\s+/g, ' ').trim();
  if (!text) return toast(tab.id, 'Select some words to make a card of them');
  let r;
  try {
    r = await api('/api/capture', { title: text.slice(0, 120), exactTitle: true, parentId: parentFor(tab), sibling: how === 'sibling', loose: how === 'loose', prefer: S.prefer,
      context: g && g.text ? { text: g.sentence, quote: g.text, fromUrl: g.fragmentUrl } : null });
  } catch (e) { return offline(tab.id); }
  if (r.parent) S.prefer[r.card.id] = r.parent.id;
  toast(tab.id, addedText(r), !!r.entry);
  refresh();
}

async function diveIntoLink(tab, info) {
  const g = await browser.tabs.sendMessage(tab.id, { t: 'grab', kind: 'link', url: info.linkUrl }).catch(() => null);
  const text = ((g && g.text) || info.linkText || '').replace(/\s+/g, ' ').trim();
  const vague = text.length < 4 || text === info.linkUrl || /^(here|link|this|source|more|read more|\[\d+\])$/i.test(text);
  return dive(tab, { title: vague ? '' : text, url: info.linkUrl, context: g ? { text: g.sentence, quote: text, fromUrl: g.fragmentUrl } : null });
}

// A link clicked in the app: switch to a tab already showing that page (the card's own tab first),
// otherwise open it in a new tab bound to the card.
async function openFromApp({ url, cardId, anchor }) {
  const tabs = await browser.tabs.query({});
  const same = tabs.filter((t) => sameUrl(t.url, url));
  const hit = same.find((t) => S.bindings[t.id] && S.bindings[t.id].cardId === cardId) || same[0];
  if (hit) {
    await activate(hit.id);
    await browser.windows.update(hit.windowId, { focused: true }).catch(() => {});
    return;
  }
  const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const tab = await browser.tabs.create({ url, windowId: win ? win.id : undefined });
  browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  if (cardId) bind(tab.id, cardId, url);
  restoreWhenLoaded(tab.id, anchor);
}

// ---------- resolve: done / not related ----------
// Done: mark understood, go to the next unfinished sibling (else the parent), close this tab.
// Not related: remove the card this tab made; the tab stays.
// One undo step: the service records the change, and what happened to tabs is added to the same entry.
async function resolveTab(tab, action) {
  if (!tab) return;
  const b = S.bindings[tab.id];
  if (!b) return toast(tab.id, 'This tab isn’t on the map');
  // A tab that only found an existing card (by URL, after a restart, …) just lets go of it.
  if (action === 'unrelated' && !b.created) {
    const title = ((lastCrumbs.trails[b.cardId] || []).slice(-1)[0] || {}).title || 'this card';
    try { await api('/api/do', { ops: [], effects: [{ kind: 'unbind', tabId: tab.id, cardId: b.cardId }], label: `Unlinked this tab from “${title}”`, source: 'browser' }); } catch (e) { return offline(tab.id); }
    unbind(tab.id); S.asked[tab.id] = true; save();
    return toast(tab.id, `This tab is no longer “${title}” (the card stays)`, true);
  }
  let r;
  try { r = await api('/api/resolve', { cardId: b.cardId, action, prefer: S.prefer }); } catch (e) { return offline(tab.id); }
  if (!r.entry) return;
  const addFx = (effects) => api('/api/effects', { entryId: r.entry.id, effects }).catch(() => {});

  if (action === 'unrelated') {
    unbind(tab.id); S.asked[tab.id] = true; save();
    addFx([{ kind: 'unbind', tabId: tab.id, cardId: b.cardId }]);
    return toast(tab.id, `Removed “${r.card.title}” from the map`, true);
  }

  const effects = [];
  let target = null;
  if (r.next) {
    const open = tabOfCard(r.next.id);
    if (open != null && open !== tab.id) {
      target = open;
      await activate(open);
    } else if (r.next.url || r.next.kind === 'sibling') {
      // The next card has no tab: reopen its page where you left off. A sibling with no page yet gets a
      // search, so you can look it up; a parent with no page is left alone (its notes are in Burrow).
      const url = r.next.url || searchUrl(r.next.title);
      const created = await browser.tabs.create({ url, active: true, index: tab.index + 1, windowId: tab.windowId });
      diving.add(created.id);
      bind(created.id, r.next.id, url);
      diving.delete(created.id);
      if (r.next.url) restoreWhenLoaded(created.id, r.next.anchor);
      effects.push({ kind: 'opened', tabId: created.id, url }, { kind: 'bind', tabId: created.id, cardId: r.next.id });
      target = created.id;
    }
    if (target != null) effects.push({ kind: 'activated', fromTabId: tab.id, toTabId: target });
  }
  // Close the finished tab; its page stays on the card, and undo brings the tab back.
  effects.push({ kind: 'closed', tabId: tab.id, url: tab.url, cardId: b.cardId, index: tab.index, windowId: tab.windowId });
  await browser.tabs.remove(tab.id).catch(() => {});
  addFx(effects);

  let text = `Understood “${r.card.title}”`;
  if (r.next) text += r.next.kind === 'sibling' ? ` · next: “${r.next.title}”` : ` · back to “${r.next.title}”`;
  if (action === 'done' && r.parentReady && r.parent) text += ` · everything “${r.parent.title}” needs is understood`;
  if (target == null) [target] = (await browser.tabs.query({ active: true, windowId: tab.windowId }).catch(() => [])).map((t) => t.id);
  if (target != null) {
    laterToasts.set(target, { msg: { t: 'toast', text, undo: shortcutOf('undo'), redo: '' }, at: Date.now() });
    if (ports.has(target)) ports.get(target).postMessage(laterToasts.get(target).msg);
  } else toast(null, text);
}

// Up to the card this one is a prerequisite of, without changing anything.
async function upToParent(tab) {
  if (!tab) return;
  const b = S.bindings[tab.id], p = S.pending[tab.id];
  const trail = b ? lastCrumbs.trails[b.cardId] || [] : [];
  const parent = b ? trail[trail.length - 2] : p ? (lastCrumbs.trails[p.parentId] || []).slice(-1)[0] : null;
  if (!parent) return toast(tab.id, b ? 'This is a top-level card' : 'This tab isn’t on the map');
  return goTo(parent.id, tab.id);
}

// ---------- palette (Alt+Shift+K) ----------
const COMMANDS = [
  ['notes', 'Open its notes in Burrow', (b) => b],
  ['done', 'Understood, go to the next one', (b) => b], ['up', 'Up to the card that needs this', (b, p) => b || p],
  ['unrelated', 'Not related: remove this page’s card', (b) => b],
  ['capture-page', 'Add this page', (b) => !b], ['add-next-to', 'Add next to the card, not under it'],
  ['capture-loose', 'Add this page on its own, with no parent'], ['undo', 'Undo'], ['redo', 'Redo'],
  ['toggle-breadcrumb', 'Show or hide the breadcrumb'], ['focus', 'Focus mode on or off'], ['open-app', 'Open Burrow'],
];

async function openPalette(tab) {
  if (!tab) return;
  if (ports.has(tab.id)) return ports.get(tab.id).postMessage({ t: 'palette' });
  // No content script here: the same palette in a small window.
  await browser.windows.create({ type: 'popup', url: browser.runtime.getURL('palette.html?tab=' + tab.id), width: 640, height: 420 });
}

async function paletteItems(q, tabId) {
  q = String(q || '').trim();
  const items = [];
  try {
    const { cards } = await api('/api/search', { q, limit: 8 });
    for (const c of cards) items.push({ kind: 'card', group: 'Cards', id: c.id, label: c.title, status: c.status, open: c.open, sub: c.board, url: c.url });
  } catch (e) { items.push({ kind: 'cmd', group: 'Burrow', name: 'open-app', label: 'Burrow isn’t running', sub: 'systemctl --user start burrow' }); return items; }
  const tab = tabId != null ? await browser.tabs.get(tabId).catch(() => null) : null;
  const parentId = tab ? parentFor(tab) : undefined;
  if (q) {
    const p = parentId && Object.values(lastCrumbs.trails).flat().find((c) => c.id === parentId);
    const target = p ? p.title : (lastCrumbs.focus.slice(-1)[0] || {}).title;
    items.push({ kind: 'create', group: 'Make a card', title: q, label: `“${q}”`, sub: target ? `under “${target}”` : '' });
    if (target) items.push({ kind: 'create', loose: true, group: 'Make a card', title: q, label: `“${q}”`, sub: 'on its own, with no parent' });
  }
  const b = tab && S.bindings[tab.id], pend = tab && S.pending[tab.id];
  const ql = q.toLowerCase();
  for (const [name, label, when] of COMMANDS) {
    if (when && !when(b, pend)) continue;
    if (ql && !label.toLowerCase().includes(ql)) continue;
    items.push({ kind: 'cmd', group: 'Commands', name, label, keys: shortcutOf(name) });
  }
  return items;
}

async function paletteRun(item, tabId) {
  const tab = tabId != null ? await browser.tabs.get(tabId).catch(() => null) : null;
  if (item.kind === 'card') return goTo(item.id, tabId, { id: item.id, title: item.label, url: item.url });
  if (item.kind === 'create') return addPage(null, { title: item.title, parentId: tab ? parentFor(tab) : undefined, how: item.loose ? 'loose' : 'child', exactTitle: true }, tabId);
  if (item.kind === 'cmd') { lastCmd = { name: '', at: 0 }; return runCommand(item.name, tab); }
}

// ---------- outline in the sidebar ----------
const sidebars = new Set();
let lastOutline = null;
function connectSidebar(port) {
  sidebars.add(port);
  port.onDisconnect.addListener(() => sidebars.delete(port));
  port.onMessage.addListener(async (m) => {
    if (m.t !== 'go') return;
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const n = lastOutline && findNode(lastOutline.roots, m.cardId);
    goTo(m.cardId, tab && tab.id, n ? { id: n.id, title: n.title, url: n.url } : null);
  });
  pushOutline();
}
const findNode = (nodes, id) => { for (const n of nodes) { if (n.id === id) return n; const k = findNode(n.kids, id); if (k) return k; } return null; };

let outlineT = null;
function pushOutline() {
  if (!sidebars.size && S.settings.focus === 'off') return;
  clearTimeout(outlineT);
  outlineT = setTimeout(async () => {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const b = tab && S.bindings[tab.id];
    try { lastOutline = await api('/api/outline', { cardId: b ? b.cardId : undefined }); } catch (e) { lastOutline = null; }
    const msg = { t: 'outline', ...(lastOutline || {}), activeCardId: b ? b.cardId : null, accent: lastCrumbs.accent, open: Object.values(S.bindings).map((x) => x.cardId) };
    for (const p of sidebars) p.postMessage(msg);
    applyFocus();
  }, 80);
}

// ---------- focus mode ----------
// Optional: bound tabs that aren't on the current trail, beside the current card or under it get hidden
// (tabs.hide) or unloaded (tabs.discard). Only tabs Burrow knows; turning it off shows them all again.
async function setFocus(mode, tab) {
  S.settings.focus = mode; save();
  browser.storage.local.set({ burrowSettings: S.settings });
  await applyFocus();
  toast(tab && tab.id, mode === 'off' ? 'Focus mode off: all tabs are back' : 'Focus mode on: tabs off this trail are hidden');
}

let focusBusy = false;
async function applyFocus() {
  if (focusBusy) return; focusBusy = true;
  try {
    const mode = S.settings.focus;
    const tabs = await browser.tabs.query({});
    if (mode === 'off') {
      const back = tabs.filter((t) => S.hidden[t.id]).map((t) => t.id);
      if (back.length) await browser.tabs.show(back).catch(() => {});
      S.hidden = {}; save();
      return;
    }
    const act = tabs.find((t) => t.active && t.windowId === (tabs.find((x) => x.active) || {}).windowId);
    const b = act && S.bindings[act.id];
    if (!b || !lastOutline) return; // only focus around a card
    const trail = lastCrumbs.trails[b.cardId] || [];
    const keep = new Set(trail.map((c) => c.id));
    const parent = trail[trail.length - 2];
    const pn = parent && findNode(lastOutline.roots, parent.id);
    for (const k of (pn ? pn.kids : [])) keep.add(k.id);
    const me = findNode(lastOutline.roots, b.cardId);
    for (const k of (me ? me.kids : [])) keep.add(k.id);
    const hide = [], show = [];
    for (const t of tabs) {
      const tb = S.bindings[t.id];
      const out = tb && !keep.has(tb.cardId) && !t.active && !t.pinned;
      if (mode === 'hide') {
        if (out && !t.hidden) hide.push(t.id);
        else if (!out && S.hidden[t.id]) show.push(t.id);
      } else if (mode === 'discard' && out && !t.discarded) browser.tabs.discard(t.id).catch(() => {});
    }
    if (show.length) { await browser.tabs.show(show).catch(() => {}); for (const id of show) delete S.hidden[id]; }
    if (hide.length) { const done = await browser.tabs.hide(hide).catch(() => []); for (const id of done || []) S.hidden[id] = true; }
    save();
  } finally { focusBusy = false; }
}

// ---------- omnibox: "bw queue" ----------
browser.omnibox.setDefaultSuggestion({ description: 'Burrow: jump to a card, or add one' });
let omniCards = [];
browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
  try { omniCards = (await api('/api/search', { q: text, limit: 6 })).cards; } catch (e) { omniCards = []; }
  const out = omniCards.map((c) => ({ content: 'card:' + c.id, description: `${c.title} · ${c.board}${c.open ? ' · open' : ''}` }));
  if (text.trim()) out.push({ content: 'new:' + text.trim(), description: `Add “${text.trim()}” to Burrow` });
  suggest(out);
});
browser.omnibox.onInputEntered.addListener(async (text) => {
  await ready;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (text.startsWith('new:')) return addPage(null, { title: text.slice(4), parentId: tab ? parentFor(tab) : undefined, exactTitle: true }, tab && tab.id);
  let id = text.startsWith('card:') ? text.slice(5) : null;
  if (!id) { try { id = ((await api('/api/search', { q: text, limit: 1 })).cards[0] || {}).id; } catch (e) { /* offline */ } }
  if (!id) return toast(tab && tab.id, `No card matches “${text}”`);
  const c = omniCards.find((x) => x.id === id);
  goTo(id, tab && tab.id, c ? { id, title: c.title, url: c.url } : null);
});

// ---------- commands ----------
let lastCmd = { name: '', at: 0 };
async function runCommand(name, tab) {
  // A shortcut can arrive both from the page (content.js wins over site accesskeys) and from the browser.
  if (lastCmd.name === name && Date.now() - lastCmd.at < 300) return;
  lastCmd = { name, at: Date.now() };
  if (!tab) [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tab && tab.id;
  if (name === 'capture-page') return captureTab(tab);
  if (name === 'add-next-to') return addNextTo(tab);
  if (name === 'capture-loose') return captureTab(tab, 'loose');
  if (name === 'select-card') return cardFromSelection(tab);
  if (name === 'notes') return notesOf(tab);
  if (name === 'done') return resolveTab(tab, 'done');
  if (name === 'unrelated') return resolveTab(tab, 'unrelated');
  if (name === 'up') return upToParent(tab);
  if (name === 'palette') return openPalette(tab);
  if (name === 'focus') return setFocus(S.settings.focus === 'off' ? 'hide' : 'off', tab);
  if (name === 'open-app') return openNotes(null, tabId, false);
  if (name === 'undo') return historyStep('undo', tabId);
  if (name === 'redo') return historyStep('redo', tabId);
  if (name === 'toggle-breadcrumb') {
    S.settings.crumb = !S.settings.crumb; save(); refresh();
    browser.storage.local.set({ burrowSettings: S.settings });
    return toast(tabId, S.settings.crumb ? 'Breadcrumb shown' : `Breadcrumb hidden · ${shortcutOf('toggle-breadcrumb')} brings it back`);
  }
}
browser.commands.onCommand.addListener((name) => ready.then(() => runCommand(name)));

// ---------- toolbar popup ----------
async function popupData() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const b = tab && S.bindings[tab.id], p = tab && S.pending[tab.id];
  let card = null;
  if (b && online) { try { card = (await api('/api/card', { cardId: b.cardId })).card; } catch (e) { /* offline */ } }
  const trail = tab ? viewFor(tab.id).trail : [];
  return {
    online, bound: !!b, card, trail, board: lastCrumbs.board, accent: lastCrumbs.accent, settings: S.settings,
    tab: tab ? { id: tab.id, page: isPage(tab.url), pending: !!p, navigated: !!(b && ownUrl(b.cardId) && !sameUrl(ownUrl(b.cardId), tab.url)) } : null,
    keys: Object.fromEntries(keymap.map((k) => [k.name, k.shortcut])),
  };
}

// ---------- popup prompt (pages without a content script) ----------
browser.runtime.onMessage.addListener((m, sender) => ready.then(() => {
  if (m.t === 'promptData') { const info = prompts.get(m.tabId); return info ? promptView(info) : null; }
  if (m.t === 'promptAnswer') return answerPrompt(m.tabId, m.choice);
  if (m.t === 'paletteQuery') return paletteItems(m.q, m.tabId != null ? m.tabId : sender.tab && sender.tab.id);
  if (m.t === 'paletteRun') return paletteRun(m.item, m.tabId != null ? m.tabId : sender.tab && sender.tab.id);
  if (m.t === 'popup') return popupData();
  if (m.t === 'popupRun') { lastCmd = { name: '', at: 0 }; return browser.tabs.get(m.tabId).catch(() => undefined).then((tab) => runCommand(m.name, tab)); }
  if (m.t === 'popupNote') return quickNote(m.cardId, m.text, m.tabId);
  return null;
}));
browser.windows.onRemoved.addListener((wid) => {
  for (const [tabId, info] of prompts) if (info.popupWindowId === wid) { info.popupWindowId = null; answerPrompt(tabId, 'ignore'); }
});

// ---------- settings ----------
browser.storage.onChanged.addListener((ch) => {
  if (ch.burrowSettings) { S.settings = { ...DEFAULT_SETTINGS, ...ch.burrowSettings.newValue }; save(); refresh(); applyFocus(); }
});

// ---------- context menus ----------
browser.contextMenus.create({ id: 'burrow-sel-card', title: 'Make a card from “%s”', contexts: ['selection'] });
browser.contextMenus.create({ id: 'burrow-dive-link', title: 'Dive into this link', contexts: ['link'] });
browser.contextMenus.create({ id: 'burrow-link', title: 'Add link to Burrow', contexts: ['link'] });
browser.contextMenus.create({ id: 'burrow-sel-next', title: 'Make a card from “%s” next to this one', contexts: ['selection'] });
browser.contextMenus.create({ id: 'burrow-page', title: 'Add page to Burrow', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-page-next', title: 'Add page next to this card', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-page-loose', title: 'Add page on its own (no parent)', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-notes', title: 'Open its notes in Burrow', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-done', title: 'Understood, go to the next one', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-up', title: 'Up to the card that needs this', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-unrelated', title: 'Not related (remove from the map)', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-open', title: 'Open Burrow', contexts: ['browser_action'] });

browser.contextMenus.onClicked.addListener((info, tab) => ready.then(() => {
  if (info.menuItemId === 'burrow-link') {
    // Link text is a good title; leave it empty for bare URLs so the service fetches the real title.
    const text = (info.linkText || '').replace(/\s+/g, ' ').trim();
    const vague = text.length < 4 || text === info.linkUrl || /^(here|link|this|source|more|read more|\[\d+\])$/i.test(text);
    const b = S.bindings[tab.id];
    // From a bound tab the link goes under that tab's card; otherwise under the capture target.
    addPage(null, { url: info.linkUrl, title: vague ? '' : text, parentId: b ? b.cardId : undefined }, tab.id);
  }
  if (info.menuItemId === 'burrow-page') runCommand('capture-page', tab);
  if (info.menuItemId === 'burrow-sel-card') cardFromSelection(tab, info.selectionText);
  if (info.menuItemId === 'burrow-sel-next') cardFromSelection(tab, info.selectionText, 'sibling');
  if (info.menuItemId === 'burrow-page-next') captureTab(tab, 'sibling');
  if (info.menuItemId === 'burrow-page-loose') captureTab(tab, 'loose');
  if (info.menuItemId === 'burrow-notes') runCommand('notes', tab);
  if (info.menuItemId === 'burrow-done') runCommand('done', tab);
  if (info.menuItemId === 'burrow-up') runCommand('up', tab);
  if (info.menuItemId === 'burrow-unrelated') runCommand('unrelated', tab);
  if (info.menuItemId === 'burrow-dive-link') diveIntoLink(tab, info);
  if (info.menuItemId === 'burrow-open') openNotes(null, tab && tab.id, false);
}));

ready.then(() => { connect(); refresh(); });
