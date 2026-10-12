#!/usr/bin/env bash
# Sign the extension with Mozilla (unlisted) and print the signed .xpi.
# The AMO keys live in ~/.config/burrow/amo.env (outside the repo, mode 600):
#   WEB_EXT_API_KEY=user:12345:678
#   WEB_EXT_API_SECRET=...
set -euo pipefail
cd "$(dirname "$0")"
KEYS="${BURROW_AMO_KEYS:-$HOME/.config/burrow/amo.env}"
if [ ! -r "$KEYS" ]; then
  echo "No keys in $KEYS. Get them at https://addons.mozilla.org/developers/addon/api/key/ and save them there as:" >&2
  echo "  WEB_EXT_API_KEY=...   and   WEB_EXT_API_SECRET=..." >&2
  exit 1
fi
set -a; . "$KEYS"; set +a
npx --yes web-ext sign --channel=unlisted --source-dir extension --artifacts-dir web-ext-artifacts
version=$(node -p "require('./extension/manifest.json').version")
echo
echo "Signed: $(ls -t web-ext-artifacts/*"$version".xpi | head -1)"
echo "Install it in Zen: about:addons → gear → Install Add-on From File…"
