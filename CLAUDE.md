# Burrow

Personal learning-map app: cards for topics, links mean "needs this first", statuses to learn / learning / understood / parked. Built for one user on Linux Mint (Cinnamon, X11) who browses with Zen. The design bar is Raycast/Linear: near-black canvas, one pastel accent the user can change, keyboard-first, minimal chrome.

The browser extension is the main interface: the user lives in Zen, and the app/canvas is a reference sheet. Rules for anything in the browser: nothing is added to the map without a one-key confirmation, everything is undoable with one key, and anything drawn on a page uses the near-black look inside a closed Shadow DOM.

## Layout

- `service/server.js`: Node HTTP server with no dependencies, on `127.0.0.1:7417`.
  - It owns the data file `~/.local/share/burrow/burrow.json`, saves it atomically and keeps daily backups in `backups/`. When `shared.VERSION` goes up it first keeps the old file as `backups/burrow-v<old>-before-migration-<time>.json`.
  - It owns the undo history (in memory, 300 entries), shared by the app and the extension. An entry is `{label, ops, inverse, effects}`; `effects` are browser side effects (e.g. `{kind: 'bind', tabId, cardId}`) that the extension reverses on undo and replays on redo, also when the undo came from the app.
  - It keeps the extension's tab→card map in memory (`/api/tabs`) for the app's "open in a tab" dot. It's cleared when the extension's SSE stream closes.
  - It serves `web/`.
  - API:
    - `GET /api/state`
    - `GET /api/events?clientId=` (Server-Sent Events: `{rev, clientId, ops}`, `{tabs, browser}`, `{history: {kind, entry, clientId}}`, `{open: {url, cardId}}`)
    - `POST /api/ops` (not undoable), `POST /api/do` (undoable: `{ops, label, coalesce, sticky, inverse?, effects?}`; `absorb` drops the entry that created an abandoned new card)
    - `POST /api/undo`, `POST /api/redo`, `GET /api/history`
    - `POST /api/capture` (add a page: under `parentId`, next to it with `sibling`, or under the capture target; records history with `effects`)
    - `POST /api/open` (the app opens a link through the extension, which reuses an open tab; `routed: false` when the extension isn't connected, and the app opens a tab itself)
    - `POST /api/anchor` (save a page's return anchor; not undoable)
    - `POST /api/resolve`, `POST /api/effects` (see the extension's resolve flow)
    - `POST /api/preview` (what the confirm prompt says), `POST /api/source` (add a source to a card), `POST /api/crumbs` (breadcrumb trails), `POST /api/match` (cards for URLs, after a browser restart), `GET|POST /api/tabs`
    - `GET /api/title?url=` (fetches a page title)
    - `GET /capture` (bookmarklet page)
  - API calls are only accepted from same-origin pages and `moz-extension://` / `chrome-extension://` origins.
- `web/shared.js`: the state shape and `applyOp()`, used by both the server and the browser. All changes are ops:
  - `card.put` / `card.del`
  - `link.put` / `link.del`
  - `board.put` / `board.del`
  - `settings.put`
  - Concepts: cards that share a `conceptId` are the same concept on different boards. `title`, `url`, `note`, `status` and `doneAt` are kept in sync by `applyOp` (position and links stay per board). A card that joins a concept takes on the siblings' fields. New cards and captures join automatically when another board has the same title or URL (`findConcept`); the palette has "Link repeated concepts across boards" for older data and "Detach from other boards" as the escape hatch for false matches.
  - A link `{from, to}` means `from` needs `to` first; `to` is drawn below.
  - Data version 2: a card has `urls: [{url, title, visitedAt, scroll, fragment}]` (primary first; `primaryUrl(card)`) instead of `url`, and status can be `parked`. `scroll`/`fragment` are the return anchor (where you'd read to). A dived card has `context: {text, quote, fromCardId, fromUrl}` (the sentence, the selected words, the card and the `#:~:text=` URL it came from); `context` is per board, not a concept field. `migrateCard` converts old cards, and `card.put` still accepts a legacy `url` from an old client.
  - `inverseOf(state, op)` and `trailOf(state, id, prefer)` live here so the service can compute undo and breadcrumbs.
- `web/app.js`: the whole UI as one vanilla-JS file with no build step. Sections are marked `// ---------- name ----------`.
  - Cards are DOM elements inside `#world`, which is moved and scaled with a CSS transform. Links are drawn in an SVG layer.
  - `commit(ops, opts)` applies an edit locally and queues it for the service: undoable edits go to `/api/do` with a label from `describe()`, the rest to `/api/ops`, in order. `Ctrl+Z` drains the queue, then calls `/api/undo`. A new card and its first title share the coalesce key `new:<id>` (with `sticky` on the title) so they undo as one step.
  - Edits from other windows arrive over SSE and go through `onRemote()`.
  - `board.focusId` is the capture target and follows the selected card.
- `web/app.css`: design tokens are on `:root`. Status colors are `--todo`, `--doing` and `--done`. `--accent` comes from `settings.accent`.
- `desktop/`: Electron shell with a frameless window. It loads the service URL and starts the service if it isn't running. The preload exposes `window.burrowDesktop` (window controls, the `Ctrl+Alt+B` quick add, and `raiseBrowser()`, which runs `wmctrl -x -a Navigator.zen` because Cinnamon won't let Zen raise itself while Burrow has focus).
- `extension/`: Firefox MV2 extension for Zen. It needs Mozilla signing (unlisted) to stay installed; see README. Bump `version` in its manifest whenever it changes.
  - `background.js`: tab→card bindings (`S.bindings`, `S.pending` for tabs opened from a bound tab, `S.asked`), persisted in `storage.local` and on each tab with `sessions.setTabValue`; rebuilt by `rebind()` on browser start (tab value first, then URL match). One SSE connection to the service; breadcrumb views go to pages over ports. Shortcuts arrive both from `commands` and from content.js (which beats site accesskeys); `runCommand` drops the duplicate.
  - Dive (`Alt+Shift+S`, context menus): `dive()` opens the search/link tab, then `/api/capture` with `exactTitle`, `context` and effects `opened` (undo closes the tab, redo reopens it; `S.alias` maps the old tab id to the new one), `bind` and `activated` (undo goes back to the origin tab). Search pages are never sources (`isSearchUrl` in the service). Engine is a setting (`ENGINES`), Google by default.
  - Resolve (`resolveTab`): `/api/resolve {cardId, action: done|park|unrelated}` records the change and returns `next` (an unfinished sibling, open ones first, else the parent) and `parentReady`; the extension activates or reopens `next`, closes the tab, then attaches `opened`/`bind`/`activated`/`closed` effects to the same entry with `/api/effects`. `closed` is undone with `sessions.restore` (found by URL in `getRecentlyClosed`) and rebinds the new tab id via `S.alias`. "Not related" deletes the card only when `binding.created` (this tab made it); otherwise it records an `unbind` effect only.
  - `content.js`: breadcrumb pill (with the "From …" context line on hover), confirm prompt and toasts in one closed Shadow DOM; `grab` (selection or link + its sentence + a text-fragment URL) for dives; reports the return anchor on `visibilitychange` → hidden and restores it (`restore`: find the saved words nearest the saved scroll, else the scroll). It never talks to 127.0.0.1 itself.
  - `prompt.html`: the confirm prompt as a popup window, for pages without content scripts. `options.html`: prompt on/off, breadcrumb on/off.
- `install.sh`: copies the app to `~/.local/share/burrow/app`, sets up the systemd user unit `burrow.service` and the `.desktop` entry.

## Working on it

- Run from the repo: `node service/server.js` (set `BURROW_DATA_DIR=/tmp/burrow-dev` to keep test data out of real boards), then open http://127.0.0.1:7417.
- The installed copy is separate. After editing, re-run `./install.sh` or copy `web/` to `~/.local/share/burrow/app/web/`. Restart with `systemctl --user restart burrow` when `service/` or `shared.js` changes; `web/` changes only need a page reload.
- Desktop window from the repo: `cd desktop && npm install && BURROW_PORT=7418 BURROW_DATA_DIR=/tmp/burrow-dev npx electron .` It starts its own service on that port. On any port other than 7417 it uses a separate Electron profile (`~/.config/Burrow-<port>`). Without that, it shares the installed app's single-instance lock and just focuses the installed window.
- No test framework.
  - App changes: load the page in a hidden Electron window (`desktop/node_modules/electron`) against a test service and drive it with `sendInputEvent` / `executeJavaScript`.
  - Extension changes: `npx web-ext run --source-dir <copy of extension/> --firefox=/home/stamble/Downloads/zen/zen --firefox-profile=<scratch dir> --keep-profile-changes`. Point the copy's `API` at a test service on another port. Real keys and clicks can be sent with XTest via `ctypes` (`libXtst.so.6`); check `_NET_ACTIVE_WINDOW` belongs to the test Zen first so nothing is typed into the user's windows. Don't use `pkill -f` from the Bash tool: the pattern also matches the tool's own shell.

## Known decisions

- `#world` only gets `will-change: transform` while panning or zooming, and it's removed 160 ms later. Keeping it on permanently made cards blurry after zooming in.
- Dragging a card moves its direct neighbours with a spring; `Ctrl`+drag moves it alone.
- Shift+right-click toggles understood. That was a user request, so keep it.
- Findings from testing in Zen 1.23 (Gecko 157), which the extension design relies on:
  - Site accesskeys use `Alt+Shift` on Linux and beat extension commands (Wikipedia: `Alt+Shift+P` opens print, `U` upload). A capture-phase keydown listener with `preventDefault` stops the accesskey, but then the command doesn't fire, so content.js forwards it.
  - From https pages, page-context requests to 127.0.0.1 (`content.fetch`, `EventSource`) hang (local network access). The extension-context `fetch` in a content script works, but all service traffic goes through the background page anyway.
  - No content scripts on `about:` pages, the PDF viewer, `view-source:`, `file:`, reader mode or addons.mozilla.org. `tabs.create` can't open `about:`/`file:` URLs.
  - Text fragments (`#:~:text=`) scroll only for user navigations, not for tabs the extension opens; scroll to anchors ourselves.
  - `Alt`+click (Zen Glance) is taken by Cinnamon's window-drag modifier, so Glance isn't reachable that way here.
  - The popup-window prompt gets focus under Cinnamon. `sessions.restore` keeps index, URL and tab values. `tabs.hide`, `sidebar_action` and `omnibox` all work.
- Shortcuts must work with the Russian layout active (the user switches with Super+Space; layouts us,ru,us). The app maps letters through `keyOf(e)` (physical key when the typed character isn't Latin); content.js matches by `e.code`. Zen's own `commands` handling already copes (tested on a PDF tab with Russian active).
- Decisions for later phases: Done closes the tab (undo reopens it), then goes to the next unfinished sibling before the parent. Dive from selection opens a Google search.
