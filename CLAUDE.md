# Burrow

Personal learning-map app: cards for topics, links mean "needs this first", statuses to learn / learning / understood. Built for one user on Linux Mint (Cinnamon, X11) who browses with Zen. The design bar is Raycast/Linear: near-black canvas, one pastel accent the user can change, keyboard-first, minimal chrome.

## Layout

- `service/server.js`: Node HTTP server with no dependencies, on `127.0.0.1:7417`.
  - It owns the data file `~/.local/share/burrow/burrow.json`, saves it atomically and keeps daily backups in `backups/`.
  - It serves `web/`.
  - API:
    - `GET /api/state`
    - `GET /api/events` (Server-Sent Events)
    - `POST /api/ops`
    - `POST /api/capture` (from the extension)
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
- `web/app.js`: the whole UI as one vanilla-JS file with no build step. Sections are marked `// ---------- name ----------`.
  - Cards are DOM elements inside `#world`, which is moved and scaled with a CSS transform. Links are drawn in an SVG layer.
  - `commit(ops)` applies an edit locally, sends it to the server and records undo.
  - Edits from other windows arrive over SSE and go through `onRemote()`.
  - `board.focusId` is the capture target and follows the selected card.
- `web/app.css`: design tokens are on `:root`. Status colors are `--todo`, `--doing` and `--done`. `--accent` comes from `settings.accent`.
- `desktop/`: Electron shell with a frameless window. It loads the service URL and starts the service if it isn't running. The preload exposes `window.burrowDesktop` (window controls and the `Ctrl+Alt+B` quick add).
- `extension/`: Firefox MV2 extension for Zen. It needs Mozilla signing (unlisted) to stay installed; see README.
- `install.sh`: copies the app to `~/.local/share/burrow/app`, sets up the systemd user unit `burrow.service` and the `.desktop` entry.

## Working on it

- Run from the repo: `node service/server.js` (set `BURROW_DATA_DIR=/tmp/burrow-dev` to keep test data out of real boards), then open http://127.0.0.1:7417.
- The installed copy is separate. After editing, re-run `./install.sh` or copy `web/` to `~/.local/share/burrow/app/web/`. Restart with `systemctl --user restart burrow` when `service/` or `shared.js` changes; `web/` changes only need a page reload.
- Desktop window from the repo: `cd desktop && npm install && BURROW_PORT=7418 BURROW_DATA_DIR=/tmp/burrow-dev npx electron .` It starts its own service on that port. On any port other than 7417 it uses a separate Electron profile (`~/.config/Burrow-<port>`). Without that, it shares the installed app's single-instance lock and just focuses the installed window.
- No test framework. UI changes were checked by driving the page with Playwright and taking screenshots.

## Known decisions

- `#world` only gets `will-change: transform` while panning or zooming, and it's removed 160 ms later. Keeping it on permanently made cards blurry after zooming in.
- Dragging a card moves its direct neighbours with a spring; `Ctrl`+drag moves it alone.
- Shift+right-click toggles understood. That was a user request, so keep it.
