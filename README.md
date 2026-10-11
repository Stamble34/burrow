# Burrow

Map the rabbit hole while you learn. When a topic turns out to need three other topics first, each one becomes a card underneath it. You work down to what you're missing, mark cards understood, and climb back up. Zoomed out, a board becomes the roadmap of the whole course.

Burrow has three parts that stay in sync:

- **Desktop app** (Electron), the main window.
- **Browser tab** at `http://127.0.0.1:7417`, the same UI in Zen.
- **Zen extension**, the main way in. It remembers which tab is which card, asks before adding a page you opened from one, and shows the path back up on every page.

All three talk to a small background service that owns a single JSON file, `~/.local/share/burrow/burrow.json`. A daily backup goes to `~/.local/share/burrow/backups/` and the last 14 days are kept.

## Install (Linux Mint)

```bash
sudo apt install nodejs npm zip      # if you don't have them
./install.sh
```

The script:

- copies the app to `~/.local/share/burrow/app`;
- downloads Electron;
- starts the service and makes it start at login (a systemd user service);
- adds **Burrow** to the menu.

It asks once for sudo to set up Electron's sandbox. You can say no, and then the app starts with `--no-sandbox`.

To remove Burrow, run `./uninstall.sh`. Your boards are kept. Add `--purge` to delete them too.

To try it without installing anything:

```bash
node service/server.js               # then open http://127.0.0.1:7417
cd desktop && npm install && npx electron .    # optional desktop window
```

## The loop

1. Make a card for what you actually want to understand, e.g. **BFS**. Double-click the canvas, or press `N`.
2. When you hit something you don't know, press `Tab` to add it as a prerequisite and type its name. Press `Tab` again to go one level deeper.
   - Usually this happens in the browser instead: see [In the browser](#in-the-browser).
3. The breadcrumb at the bottom and the highlighted line show how you got here: *Search algorithms / BFS / Queue / Linked lists / Doubly linked list*.
4. When a card makes sense, `Shift`+right-click it or press `D`. `Shift+D` marks it understood **and** jumps back up to the card that needed it.
   - When everything under a card is understood, it gets a **Ready** tag. Press `W` and Burrow picks the next card to learn.

Statuses: **to learn** (blue), **learning** (yellow), **understood** (grey), **parked** (dashed: set aside for now).

A card keeps every page you read for it. The details panel (`E`) shows the main link and the other sources, and a small dot in a card's corner means it's open in a browser tab.

## Shortcuts

| | |
|---|---|
| `N` / double-click | New card |
| `Tab` | Add a prerequisite to the selected card (also works while typing a title) |
| `Enter` | Add another prerequisite next to the selected one |
| `F2` / double-click card | Rename |
| `E` | Details: link, notes, what it needs, what needs it |
| `D` / `Shift`+right-click | Toggle understood |
| `Shift+D` | Understood, go back up |
| `Space`, `1` `2` `3` | Cycle status / set status |
| `W` | What should I learn next? |
| `↑ ↓ ← →` | Walk the map (up = back toward where you started) |
| `L` | Link the selected card to another card it needs |
| Drag the dot under a card | Link to a card, or drop on empty space to create a prerequisite |
| Drag a card | Moves it; its directly linked cards follow. `Ctrl`+drag moves it alone |
| `Shift`+drag | Select several cards |
| `T` | Tidy layout (just the selected branch if one card is selected) |
| `Ctrl+V` | Paste a URL or a list of lines as cards |
| `Ctrl+K` | Search cards, boards and commands |
| `Ctrl+B` | Switch or create boards |
| `F` / `C` | Fit board / center selected |
| `O` | Open the card's link in your browser |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+Alt+B` (anywhere) | Bring up the desktop app and add a prerequisite to the current card |
| `?` | All shortcuts |

A topic you add on a new board that you already have on another one is linked to it, so a course board starts out showing what you already understand. Marking it understood, renaming it or editing its notes updates every board it is on. Use `Ctrl+K` → “Link repeated concepts across boards” to link cards you made before this existed, or “Detach from other boards” if two cards only share a name.

Change the accent color with the dot in the top-right corner. Rename a board by double-clicking its name.

## In the browser

The extension ties tabs to cards. A tab that shows a card is *bound* to it.

- **Start a trail.** On a page you want to understand, press `Alt+Shift+B`. The page becomes a card under the card selected in Burrow (the *capture target*), and the tab is bound to it.
- **Go deeper.** Open links from that page in new tabs as usual (middle-click, `Ctrl`+click). Nothing happens until you look at one. Then a small prompt asks: *Add “Linked list” under “Queue”?*
  - `Enter` adds it under the card it came from.
  - `Shift+Enter` adds it next to that card instead (under the same parent).
  - `Esc` ignores it, and Burrow won't ask about that tab again. `Alt+Shift+B` still adds it later.
  - Clicking into the page leaves the prompt alone. It fades after about 10 seconds, which counts as ignoring it.
- **Read around.** Following links inside a bound tab adds those pages as extra sources of the same card. It never makes new cards.
- **The breadcrumb** at the bottom left of every page shows the trail from the top card down to this tab: *BFS / Queue / Linked lists / Doubly linked list · 4 deep*. Click a step to switch to its tab, or to reopen its page. On a tab that isn't on the map it shows where a capture would go. It hides in fullscreen.
  - On pages where extensions can't draw (PDFs, `about:` pages, addons.mozilla.org), the toolbar icon shows the depth instead, and the prompt opens as a small window.
- **Undo anything.** `Alt+Shift+Z` undoes the last Burrow change, and `Alt+Shift+Y` redoes it. The app and the browser share one history, so `Ctrl+Z` in the app undoes a page added in the browser and vice versa. Undoing an add also unbinds the tab.
- After a browser restart, tabs find their cards again.
- Clicking a card's link in the app switches to the tab that already shows that page, instead of opening another one. If it isn't open, it opens in a new tab tied to the card, and Zen comes to the front. Without the extension, links open in a new tab as before.

| Browser shortcut | |
|---|---|
| `Alt+Shift+B` | Add this page (under the card it was opened from, or the capture target) |
| `Alt+Shift+Z` / `Alt+Shift+Y` | Undo / redo |
| `Alt+Shift+H` | Show or hide the breadcrumb |

Some sites use `Alt+Shift` letters for their own shortcuts (on Wikipedia `Alt+Shift+P` prints). On pages Burrow can draw on, its shortcuts win. Right-click a link and choose **Add link to Burrow** to add it without opening it.

To stop the prompts and only add pages with the shortcut, open the extension's preferences (`about:addons` → Burrow → Preferences).

## Installing the Zen extension

Zen only keeps add-ons that Mozilla has signed. It ignores `xpinstall.signatures.required`, so an unsigned `.xpi` can't be installed permanently. Signing is free and private.

**Permanent install (recommended, about 5 minutes, once):**

1. Sign in at <https://addons.mozilla.org/developers/> with a Firefox account.
2. Open **Tools → Manage API Keys**, generate credentials, and copy the *JWT issuer* and *JWT secret*.
3. In a terminal, from the Burrow folder, run:
   ```bash
   npx web-ext sign --channel=unlisted --source-dir extension \
     --api-key="JWT issuer" --api-secret="JWT secret"
   ```
   *Unlisted* means it's signed but never published. It usually takes under a minute, and the signed file is saved in `web-ext-artifacts/`.
4. In Zen, open `about:addons`, click the gear icon, choose **Install Add-on From File…**, and pick the signed `.xpi`. Then click **Add**.
5. Optional: pin the Burrow icon to the toolbar.

To publish a change to the extension, raise `"version"` in `extension/manifest.json` and sign it again.

**Quick test (removed when Zen restarts):** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and pick `extension/manifest.json`.

**Using it:** see [In the browser](#in-the-browser). To change a shortcut, open `about:addons`, click the gear icon, and choose **Manage Extension Shortcuts**.

Version 2 asks for more permissions than version 1 (all tabs, navigation, sessions and every page), because it reads which tab opened which and draws the breadcrumb on pages. Nothing leaves your computer: it only talks to the Burrow service on `127.0.0.1`.

**No extension?** Add a bookmark with this as its URL and click it on any page:

```
javascript:(()=>{window.open('http://127.0.0.1:7417/capture?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'burrow','width=420,height=140')})()
```

## Troubleshooting

- Updating from an older Burrow converts your data file once. The file as it was is kept in `~/.local/share/burrow/backups/` as `burrow-v1-before-migration-….json`.
- `systemctl --user status burrow` shows whether the service is running. View its logs with `journalctl --user -u burrow -f`.
- If port 7417 is taken, set `BURROW_PORT` in `~/.config/systemd/user/burrow.service` and in the extension's `background.js`.
- If the desktop app doesn't start on a fresh Mint install, run it from a terminal to see the error: `~/.local/share/burrow/app/desktop/node_modules/electron/dist/electron ~/.local/share/burrow/app/desktop`. A sandbox error means re-running `./install.sh` and accepting the sudo step.
