# Burrow

Map the rabbit hole while you learn. When a topic turns out to need three other topics first, each one becomes a card underneath it. You work down to what you're missing, mark cards understood, and climb back up. Zoomed out, a board becomes the roadmap of the whole course.

Burrow has three parts that stay in sync:

- **Desktop app** (Electron), the main window.
- **Browser tab** at `http://127.0.0.1:7417`, the same UI in Zen.
- **Zen extension**, which sends the page you're reading, or a link you right-click, to Burrow as a prerequisite of the card you're on.

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
   - You can also do this from the browser: select the card in Burrow, then in Zen press `Alt+Shift+B` or right-click a link and choose **Add link to Burrow**. The page lands under that card, and the chip at the top of Burrow shows which card is receiving captures.
3. The breadcrumb at the bottom and the highlighted line show how you got here: *Search algorithms / BFS / Queue / Linked lists / Doubly linked list*.
4. When a card makes sense, `Shift`+right-click it or press `D`. `Shift+D` marks it understood **and** jumps back up to the card that needed it.
   - When everything under a card is understood, it gets a **Ready** tag. Press `W` and Burrow picks the next card to learn.

Statuses: **to learn** (blue), **learning** (yellow), **understood** (grey).

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

Change the accent color with the dot in the top-right corner. Rename a board by double-clicking its name.

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

**Using it:** select a card in Burrow so the top bar says *Capturing under …*. Then in Zen, either press `Alt+Shift+B` or click the toolbar icon to add the current page, or right-click a link and choose **Add link to Burrow**. To change the shortcut, open `about:addons`, click the gear icon, and choose **Manage Extension Shortcuts**.

**No extension?** Add a bookmark with this as its URL and click it on any page:

```
javascript:(()=>{window.open('http://127.0.0.1:7417/capture?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'burrow','width=420,height=140')})()
```

## Troubleshooting

- `systemctl --user status burrow` shows whether the service is running. View its logs with `journalctl --user -u burrow -f`.
- If port 7417 is taken, set `BURROW_PORT` in `~/.config/systemd/user/burrow.service` and in the extension's `background.js`.
- If the desktop app doesn't start on a fresh Mint install, run it from a terminal to see the error: `~/.local/share/burrow/app/desktop/node_modules/electron/dist/electron ~/.local/share/burrow/app/desktop`. A sandbox error means re-running `./install.sh` and accepting the sudo step.
