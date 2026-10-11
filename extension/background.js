// Burrow for Zen / Firefox: the browser side of the map.
// - Tabs are bound to cards. A tab opened from a bound tab asks (once, when you first look at it)
//   whether to add its page under that card. Navigating inside a bound tab adds sources to its card.
// - Every page shows the trail from the top-level card down to this tab's card (content.js).
// - Undo/redo share one history with the app, kept by the service.
// The service (service/server.js) does the map logic; this file is browser glue.
const API = 'http://127.0.0.1:7417';
const CLIENT = 'ext-' + Math.random().toString(36).slice(2, 10);
const DEFAULT_SETTINGS = { prompt: true, crumb: true };

// ---------- persisted state ----------
// Tab ids are only valid until the browser restarts, so this is rebuilt on startup (see rebind()).
let S = { bindings: {}, pending: {}, asked: {}, prefer: {}, settings: { ...DEFAULT_SETTINGS } };
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
    if (m.ops) refresh();
  };
  es.onerror = () => { online = false; };
}

// ---------- bindings ----------
function bind(tabId, cardId, url) {
  S.bindings[tabId] = { cardId, url: url || '' };
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
  S.bindings = {}; S.pending = {}; S.asked = {};
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

browser.tabs.onActivated.addListener(({ tabId }) => ready.then(() => { maybePrompt(tabId); pushTabs(); }));

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
  delete S.bindings[tabId]; delete S.pending[tabId]; delete S.asked[tabId];
  save();
  if (had) pushTabs();
}));

// ---------- confirm prompt ----------
// Shown the first time you look at a tab opened from a bound tab. Background tabs you never visit never ask.
const prompts = new Map(); // tabId -> { parentId, url, title, preview, popupWindowId }

async function maybePrompt(tabId) {
  const p = S.pending[tabId];
  if (!p || S.asked[tabId] || !S.settings.prompt || prompts.has(tabId)) return;
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
  await addPage(tabId, { url: info.url, title: info.title, parentId: info.parentId, sibling: choice === 'sibling' });
}

// ---------- adding pages ----------
// tabId: the tab showing this page, which becomes bound to the card (null for a link that isn't open).
async function addPage(tabId, { url, title, parentId, sibling }, toastTab = tabId) {
  let r;
  try {
    r = await api('/api/capture', { url, title, parentId, sibling, effects: tabId != null ? [{ kind: 'bind', tabId }] : [] });
  } catch (e) { return offline(toastTab); }
  if (tabId != null) {
    if (r.parent) S.prefer[r.card.id] = r.parent.id;
    bind(tabId, r.card.id, url);
  }
  const text = r.existing ? `“${r.card.title}” is already on the map${r.parent ? ` (now under “${r.parent.title}”)` : ''}`
    : `Added “${r.card.title}”${r.parent ? ` under “${r.parent.title}”` : ` to ${r.board.name}`}${r.known ? ` · known from ${r.known}` : ''}`;
  toast(toastTab, text, !!r.entry);
  return r;
}

async function captureTab(tab) {
  if (!tab) return;
  if (!isPage(tab.url)) return toast(tab.id, 'Only web pages and files can be added');
  const b = S.bindings[tab.id];
  if (b) return toast(tab.id, `This tab is already “${(lastCrumbs.trails[b.cardId] || []).slice(-1)[0]?.title || 'on the map'}”`);
  // An ignored tab opened from a card still goes under that card; otherwise under the capture target.
  const p = S.pending[tab.id];
  prompts.delete(tab.id);
  await addPage(tab.id, { url: tab.url, title: tab.title, parentId: p ? p.parentId : undefined });
}

// ---------- undo / redo ----------
async function historyStep(kind, tabId) {
  let d;
  try { d = await api('/api/' + kind, {}); } catch (e) { return offline(tabId); }
  if (d.empty) return toast(tabId, kind === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  toast(tabId, `${kind === 'undo' ? 'Undid' : 'Redid'}: ${d.entry.label}`, false, kind === 'undo');
}

// Reverse (undo) or replay (redo) what the browser did alongside a change. Runs for undo from the app too.
async function onHistory({ kind, entry }) {
  for (const fx of (entry.effects || []).slice()[kind === 'undo' ? 'reverse' : 'slice']()) {
    if (fx.kind === 'bind') {
      const exists = await browser.tabs.get(fx.tabId).then(() => true, () => false);
      if (!exists) continue;
      if (kind === 'undo') { unbind(fx.tabId); S.asked[fx.tabId] = true; save(); }
      else if (fx.cardId) bind(fx.tabId, fx.cardId);
    }
  }
}

// ---------- breadcrumb ----------
const ports = new Map(); // tabId -> port to content.js
let lastCrumbs = { trails: {}, focus: [], board: null, accent: null };
let keymap = [];
browser.commands.getAll().then((cs) => { keymap = cs.filter((c) => c.shortcut).map((c) => ({ name: c.name, shortcut: c.shortcut })); });
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
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (tabId == null) return;
  ready.then(() => {
    ports.set(tabId, port);
    badge(tabId);
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
}

// Wait briefly for a page's content script to connect (it loads at document_idle).
async function sendWhenReady(tabId, msg) {
  for (let i = 0; i < 8 && !ports.has(tabId); i++) await new Promise((r) => setTimeout(r, 100));
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
async function goTo(cardId, fromTabId) {
  const t = tabOfCard(cardId);
  if (t != null) {
    const tab = await browser.tabs.update(t, { active: true });
    browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  const all = Object.values(lastCrumbs.trails).flat().concat(lastCrumbs.focus);
  const c = all.find((x) => x.id === cardId);
  if (!c || !c.url) return toast(fromTabId, `“${c ? c.title : 'That card'}” has no page yet`);
  const tab = await browser.tabs.create({ url: c.url, openerTabId: fromTabId });
  bind(tab.id, cardId, c.url);
}

// ---------- commands ----------
let lastCmd = { name: '', at: 0 };
async function runCommand(name, tab) {
  // A shortcut can arrive both from the page (content.js wins over site accesskeys) and from the browser.
  if (lastCmd.name === name && Date.now() - lastCmd.at < 300) return;
  lastCmd = { name, at: Date.now() };
  if (!tab) [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tab && tab.id;
  if (name === 'capture-page') return captureTab(tab);
  if (name === 'undo') return historyStep('undo', tabId);
  if (name === 'redo') return historyStep('redo', tabId);
  if (name === 'toggle-breadcrumb') {
    S.settings.crumb = !S.settings.crumb; save(); refresh();
    browser.storage.local.set({ burrowSettings: S.settings });
    return toast(tabId, S.settings.crumb ? 'Breadcrumb shown' : `Breadcrumb hidden · ${shortcutOf('toggle-breadcrumb')} brings it back`);
  }
}
browser.commands.onCommand.addListener((name) => ready.then(() => runCommand(name)));
browser.browserAction.onClicked.addListener((tab) => ready.then(() => runCommand('capture-page', tab)));

// ---------- popup prompt (pages without a content script) ----------
browser.runtime.onMessage.addListener((m) => ready.then(() => {
  if (m.t === 'promptData') { const info = prompts.get(m.tabId); return info ? promptView(info) : null; }
  if (m.t === 'promptAnswer') return answerPrompt(m.tabId, m.choice);
  return null;
}));
browser.windows.onRemoved.addListener((wid) => {
  for (const [tabId, info] of prompts) if (info.popupWindowId === wid) { info.popupWindowId = null; answerPrompt(tabId, 'ignore'); }
});

// ---------- settings ----------
browser.storage.onChanged.addListener((ch) => {
  if (ch.burrowSettings) { S.settings = { ...DEFAULT_SETTINGS, ...ch.burrowSettings.newValue }; save(); refresh(); }
});

// ---------- context menus ----------
browser.contextMenus.create({ id: 'burrow-link', title: 'Add link to Burrow', contexts: ['link'] });
browser.contextMenus.create({ id: 'burrow-page', title: 'Add page to Burrow', contexts: ['page'] });
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
  if (info.menuItemId === 'burrow-open') browser.tabs.create({ url: API + '/' });
}));

ready.then(() => { connect(); refresh(); });
