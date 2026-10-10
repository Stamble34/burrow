#!/usr/bin/env bash
# Removes the Burrow app, service and menu entry. Keeps your data file unless you pass --purge.
set -uo pipefail
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/burrow"

systemctl --user disable --now burrow.service 2>/dev/null
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/burrow.service"
systemctl --user daemon-reload 2>/dev/null
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/burrow.desktop"
rm -rf "$DATA/app"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DATA"
  echo "Removed Burrow and all of its data."
else
  echo "Removed Burrow. Your boards are still in $DATA (run with --purge to delete them)."
fi
