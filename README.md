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

A card keeps every page you read for it. The details panel (`E`, press it again to close) shows the main link, the other sources and, for a card made from a selection, the sentence it came from. A small dot in a card's corner means it's open in a browser tab. New cards are titled in title case: “list of properties” becomes “List of Properties” (acronyms like BFS and notation like O(n log n) are left alone).

### Card pages and notes

Double-click a card (or press `Shift+E`) to open its page, like a page in Notion: a big title, its properties (status, tags, sources, where it came from, what it needs and what needs it) and its notes. `Esc` goes back to the map.

- **Notes** are Markdown, and the page shows them formatted. Click any line to edit it; only the line you're in shows its Markdown. Start a line with `# ` (or `##`, `###`), `- `, `1. `, `[] `, `> ` or ```` ``` ```` to make a heading, list, to-do, quote or code block, or type `/` for a menu of blocks. `---` makes a divider. `Tab` and `Shift+Tab` nest list items, `Alt+↑/↓` moves a line, `Ctrl+Enter` ticks a to-do.
- **Formatting:** `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+E` code, `Ctrl+K` link, `Ctrl+Shift+X` strikethrough, `Ctrl+Shift+H` highlight.
- **Links to other cards:** type `[[` and pick a card. Clicking `[[Linked List]]` opens that card's page; if there's no such card yet, Burrow offers to add it as a prerequisite.
- **Markdown view:** `Ctrl+/` (or *Page* / *Markdown* at the top) switches between the formatted page and the plain Markdown of the whole note, for big edits and pasting.
- **Tags:** click *Add a tag*, type, `Enter`. Tags you've used before are suggested, each tag keeps its color everywhere, and they show on the card on the map. Click a tag to list every card with it (or type `#tag` in `Ctrl+K`).

Notes and tags belong to the concept, so a card that is on several boards has the same notes on all of them.

## Shortcuts

| | |
|---|---|
| `N` / double-click | New card on its own (no parent) |
| `Tab` | Add a prerequisite to the selected card (also works while typing a title) |
| `Enter` | Add another prerequisite next to the selected one |
| `F2` | Rename |
| Double-click card / `Shift+E` | Open the card's page: notes, tags, properties |
| `E` | Details sidebar on or off |
| `D` / `Shift`+right-click | Toggle understood |
| `Shift+D` | Understood, go back up |
| `Space`, `1` `2` `3` | Cycle status / set status |
| `W` | What should I learn next? |
| `↑ ↓ ← →` | Walk the map (up = back toward where you started) |
| `A` | Attach a card: pick one to put under the selected card. `Shift+Enter` puts it above instead, `Ctrl+Enter` moves it there (cuts it from its other parents) |
| `X` | Detach: cut the selected card from the card above or below it. With several links, pick which one; several selected cards are cut from the rest of the map |
| `L` | Link the selected card to another card it needs, by clicking it |
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

On a card's page, the *Needs first* and *Needed for* rows have **+ Add** to attach a card, and hovering a card there shows **×** to detach it. The details sidebar has the same. In `Ctrl+K`, typing a name with a card selected offers both “Add … as a prerequisite” and “Create card … on its own”.

Change the accent color with the dot in the top-right corner. Rename a board by double-clicking its name.

## In the browser

The extension ties tabs to cards. A tab that shows a card is *bound* to it.

- **Start a trail.** On a page you want to understand, press `Alt+Shift+B`. The page becomes a card under the card selected in Burrow (the *capture target*), and the tab is bound to it.
- **Go deeper.** Open links from that page in new tabs as usual (middle-click, `Ctrl`+click). Nothing happens until you look at one. Then a small prompt asks: *Add “Linked list” under “Queue”?*
  - `Enter` adds it under the card it came from.
  - `Shift+Enter` adds it next to that card instead (under the same parent).
  - `Esc` ignores it, and Burrow won't ask about that tab again. `Alt+Shift+B` still adds it later.
  - Clicking into the page leaves the prompt alone. It fades after about 10 seconds, which counts as ignoring it.
- **Next to, not under.** `Alt+Shift+A` adds next to this tab's card instead of under it: the card goes under the same parent (the one on the breadcrumb). With words selected it makes a card of them; otherwise it adds the page.
  - Useful after following a link in the same tab: the page you landed on becomes its own card next to the one you came from, the tab moves to it, and the page is taken off the old card's sources. `Alt+Shift+B` does the same but puts it under the old card.
  - On a card at the top of the board, the new card goes beside it with no parent.
- **Cards with no parent.** Right-click a page → **Add page on its own (no parent)**, or in the palette (`Alt+Shift+K`) type a name and pick the “on its own” line. The popup offers it for pages that aren't on the map.
- **Make a card from words.** Select a few words you don't understand and press `Alt+Shift+S` (or right-click → **Make a card from “…”**). They become a card under this tab's card, titled in title case, and nothing opens: you stay where you are. The card keeps the sentence they came from. No prompt, since you asked; `Alt+Shift+Z` undoes it.
- **Dive into a link.** Right-click a link → **Dive into this link** adds the link's page as a card under this one and opens it in a new tab tied to it. `Alt+Shift+Z` undoes the card and closes the tab.
- **Read around.** Following links inside a bound tab adds those pages as extra sources of the same card (search result pages don't count). It never makes new cards by itself; `Alt+Shift+A` or `Alt+Shift+B` turns the page you're on into one.
- **The breadcrumb** at the bottom left of every page shows the trail from the top card down to this tab: *BFS / Queue / Linked lists / Doubly linked list · 4 deep*. Click a step to switch to its tab, or to reopen its page. On a tab that isn't on the map it shows where a capture would go. It hides in fullscreen.
  - A card with no page (like *BFS*, which you typed in yourself) opens its notes in Burrow instead. If Burrow isn't open, a small box asks *Burrow isn't open. Show “BFS” there?*: `Enter` starts the app on that card's page, `Esc` (or ignoring it) does nothing.
  - `Ctrl`+click a step to open that card's notes in Burrow instead of its page.
  - Hover it on a page you made a card from to see where the card came from: *From Queues: “A circular buffer is a fixed-size queue that wraps around at the end.”* Click that line to go back to that sentence.
- **Take notes.** `Alt+Shift+N` opens this tab's card on its page in Burrow, starting the app if it isn't open. Or click the Burrow icon in the toolbar and type a quick note: `Ctrl+Enter` adds it to the end of the card's notes, without leaving the page.
- **Climb back out.** When a page makes sense, press `Alt+Shift+D`. The card is marked understood, its tab closes (the page stays on the card), and Burrow takes you to the next prerequisite of the same card that you haven't finished, or back up to the card itself when there are none left. If that card's tab is closed, its page reopens where you left off. A next prerequisite with no page yet opens a search for it; a card above with no page is left alone. When everything a card needs is understood, the toast says so.
  - `Alt+Shift+U` just goes up to the card that needs this one, without changing anything.
  - `Alt+Shift+X` says a page was a wrong turn: the card it made is removed and the tab stays open. A tab that was only matched to an existing card lets go of it instead.
  - All of these are in the page's right-click menu too, and `Alt+Shift+Z` undoes them, reopening a closed tab.
- **Pick up where you were.** Leaving a bound tab remembers how far down you'd read. When the page is reopened later (from the breadcrumb or the app), it scrolls back there.
  - On pages where extensions can't draw (PDFs, `about:` pages, addons.mozilla.org), the toolbar icon shows the depth instead, and the prompt opens as a small window.
- **Undo anything.** `Alt+Shift+Z` undoes the last Burrow change, and `Alt+Shift+Y` redoes it. The app and the browser share one history, so `Ctrl+Z` in the app undoes a page added in the browser and vice versa. Undoing an add also unbinds the tab.
- **The toolbar popup** (click the Burrow icon) shows this tab's card with its tags and the end of its notes, a box for a quick note, and every command with its shortcut. `↑`/`↓` and `Enter` run them.
- **Find anything.** `Alt+Shift+K` opens the Burrow palette over the page: type to jump to any card (its tab, or its page reopened), make a card under this one, or run any of the commands below. In the address bar, `bw` then a space searches cards too.
- **See the whole map.** `Alt+Shift+O` opens the outline in Zen's sidebar: the board you're on as a tree, the card for this tab highlighted, open ones marked with a dot. Click a card to go to it.
- **Focus mode** (off by default; preferences or the palette): tabs on the map that aren't on your current trail, next to the card you're on, or under it get hidden, or unloaded if you prefer. Turning it off brings them all back.
- After a browser restart, tabs find their cards again.
- Clicking a card's link in the app switches to the tab that already shows that page, instead of opening another one. If it isn't open, it opens in a new tab tied to the card, and Zen comes to the front. Without the extension, links open in a new tab as before.

| Browser shortcut | |
|---|---|
| `Alt+Shift+B` | Add this page (under the card it was opened from, or the capture target) |
| `Alt+Shift+A` | Add next to this card, under its parent: the selected words, else this page |
| `Alt+Shift+S` | Make a card from the selected words (nothing opens) |
| `Alt+Shift+N` | Open this tab's card and its notes in Burrow |
| `Alt+Shift+D` | Understood: close this tab, go to the next one |
| `Alt+Shift+U` | Up to the card that needs this one |
| `Alt+Shift+X` | Not related: remove this page's card |
| `Alt+Shift+K` | Palette: jump to a card, make one, run a command |
| `Alt+Shift+O` | Outline in the sidebar |
| `bw` + space in the address bar | Search cards |
| `Alt+Shift+Z` / `Alt+Shift+Y` | Undo / redo |
| `Alt+Shift+H` | Show or hide the breadcrumb |

Some sites use `Alt+Shift` letters for their own shortcuts (on Wikipedia `Alt+Shift+U` opens the upload page). On pages Burrow can draw on, its shortcuts win. Right-click a link and choose **Add link to Burrow** to add it without opening it.

To stop the prompts and only add pages with the shortcut, to search with something other than Google, or to turn on focus mode, open the extension's preferences (`about:addons` → Burrow → Preferences).

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
