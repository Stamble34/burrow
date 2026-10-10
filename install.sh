#!/usr/bin/env bash
# Installs Burrow for the current user on Linux Mint (or any systemd desktop).
#   - copies the app to ~/.local/share/burrow/app
#   - installs Electron for the desktop window
#   - runs the sync service in the background (systemd user service, starts at login)
#   - adds "Burrow" to the application menu
# Your data lives in ~/.local/share/burrow/burrow.json and is never touched by this script.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/burrow/app"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
PORT="${BURROW_PORT:-7417}"

say() { printf '\033[1;35m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js is missing. Install it with:  sudo apt install nodejs npm"
command -v npm  >/dev/null || die "npm is missing. Install it with:  sudo apt install npm"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"

say "Copying Burrow to $APP"
mkdir -p "$APP"
rm -rf "$APP/service" "$APP/web" "$APP/extension"
cp -r "$SRC/service" "$SRC/web" "$SRC/extension" "$APP/"
mkdir -p "$APP/desktop"
cp "$SRC/desktop/main.js" "$SRC/desktop/preload.js" "$SRC/desktop/package.json" "$SRC/desktop/icon.png" "$APP/desktop/"

say "Installing Electron (one-time download, ~100 MB)"
( cd "$APP/desktop" && npm install --no-audit --no-fund --loglevel=error )
ELECTRON="$APP/desktop/node_modules/electron/dist/electron"
[ -x "$ELECTRON" ] || die "Electron did not install correctly. Try again, or run: cd '$APP/desktop' && npm install"

# Electron's sandbox helper needs root ownership on Ubuntu-based systems.
SANDBOX="$APP/desktop/node_modules/electron/dist/chrome-sandbox"
SANDBOX_FLAG=""
if [ -f "$SANDBOX" ]; then
  ans="y"
  if [ -t 0 ]; then read -r -p "  Set up Electron's sandbox helper with sudo? Recommended. [Y/n] " ans || ans="n"; fi
  if [[ ! "$ans" =~ ^[Nn] ]] && sudo chown root:root "$SANDBOX" && sudo chmod 4755 "$SANDBOX"; then
    say "Sandbox set up"
  else
    SANDBOX_FLAG="--no-sandbox"
    say "Skipped. The app will start with --no-sandbox (it only ever loads Burrow's own local page)."
  fi
fi

# Background service: system Node if it's new enough, otherwise Electron's bundled Node.
if [ "$NODE_MAJOR" -ge 18 ]; then
  EXEC="$(command -v node) $APP/service/server.js"
  ENV_LINE=""
else
  EXEC="$ELECTRON $APP/service/server.js"
  ENV_LINE="Environment=ELECTRON_RUN_AS_NODE=1"
fi

say "Setting up the background service"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/burrow.service" <<EOF
[Unit]
Description=Burrow sync service (data file + live sync for app, browser tab and extension)

[Service]
ExecStart=$EXEC
Environment=BURROW_PORT=$PORT
$ENV_LINE
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable burrow.service >/dev/null
systemctl --user restart burrow.service

say "Adding Burrow to the application menu"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/burrow.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Burrow
Comment=Map the rabbit hole while you learn
Exec=$ELECTRON $SANDBOX_FLAG $APP/desktop
Icon=$APP/web/icon-512.png
Terminal=false
Categories=Education;Office;
StartupWMClass=Burrow
EOF
update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

# Package the browser extension so it's ready to load in Zen.
if command -v zip >/dev/null; then
  ( cd "$APP/extension" && rm -f ../burrow-extension.xpi && zip -qr ../burrow-extension.xpi . )
fi

sleep 0.5
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  say "Done. Burrow is running at http://127.0.0.1:$PORT"
else
  say "Installed, but the service didn't answer yet. Check: systemctl --user status burrow"
fi
cat <<EOF

  Open the app:        Menu → Burrow   (quick add from anywhere: Ctrl+Alt+B while it's open)
  Open in Zen:         http://127.0.0.1:$PORT   (pin the tab)
  Browser extension:   $APP/extension  (see README for installing it in Zen)
  Your data:           ${XDG_DATA_HOME:-$HOME/.local/share}/burrow/burrow.json

EOF
