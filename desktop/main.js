// Burrow desktop window. The data lives in the Burrow service (service/server.js),
// which normally runs in the background as a systemd user service. If it isn't
// running, the app starts it so the window is never empty.

const { app, BrowserWindow, ipcMain, shell, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.BURROW_PORT || 7417);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const QUICK_ADD = process.env.BURROW_SHORTCUT || 'Control+Alt+B';
const SERVICE = path.join(__dirname, '..', 'service', 'server.js');

// A window on another port (a dev copy run from the repo) gets its own profile, so it
// doesn't share the installed app's single-instance lock, window size or storage.
if (PORT !== 7417) app.setPath('userData', `${app.getPath('userData')}-${PORT}`);

let win = null;

function health() {
  return new Promise((resolve) => {
    const req = http.get(URL_BASE + '/api/health', { timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'burrow'); } catch (e) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureService() {
  if (await health()) return true;
  const child = spawn(process.execPath, [SERVICE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await health()) return true;
  }
  return false;
}

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch (e) { return { width: 1400, height: 900 }; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch (e) { /* not critical */ }
}

const offlinePage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#060607;color:#ececf1;font:15px system-ui">
<div style="text-align:center;max-width:420px"><h2 style="font-weight:600">The Burrow service isn't running</h2>
<p style="color:#a0a0ac;line-height:1.6">Start it with <code>systemctl --user start burrow</code>, then reopen this window.</p></div></body></html>`)}`;

async function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 720, minHeight: 480,
    frame: false,
    backgroundColor: '#060607',
    title: 'Burrow',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);

  // Links on cards open in your normal browser (Zen), never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(URL_BASE)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL_BASE)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });

  const ok = await ensureService();
  win.loadURL(ok ? URL_BASE + '/' : offlinePage);
}

ipcMain.on('win', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (action === 'minimize') w.minimize();
  if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
  if (action === 'close') w.close();
});

// The extension switched to a link's tab in Zen; bring Zen forward too. Cinnamon won't let the
// browser raise itself while this window has focus, but honours a request through wmctrl.
ipcMain.on('raise-browser', () => {
  execFile('wmctrl', ['-x', '-a', 'Navigator.zen'], () => {});
});

// The browser asked to show a card's page. Cinnamon ignores focus requests from a window in the
// background, so ask the window manager to raise it as well (by X window id).
ipcMain.on('raise-self', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  try {
    const h = w.getNativeWindowHandle();
    const xid = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
    if (xid) execFile('wmctrl', ['-i', '-a', '0x' + xid.toString(16)], () => {});
  } catch (err) { /* not X11 */ }
});

function showAndQuickAdd() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('quick-add');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    try {
      if (!globalShortcut.register(QUICK_ADD, showAndQuickAdd)) console.warn(`[burrow] Could not register ${QUICK_ADD}`);
    } catch (e) { console.warn('[burrow] global shortcut unavailable:', e.message); }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
