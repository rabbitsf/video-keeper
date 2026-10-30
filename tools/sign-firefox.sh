#!/bin/bash
# Build the Firefox add-on and have Mozilla sign it as an unlisted (private) add-on.
# The signed .xpi lands in dist/signed/ and installs permanently in regular Firefox.
#
# Credentials (from https://addons.mozilla.org/developers/addon/api/key/) are read from
# $AMO_ENV_FILE (default ~/.config/video-downloader/amo.env), which should contain:
#   export WEB_EXT_API_KEY="user:12345:67"
#   export WEB_EXT_API_SECRET="..."
# Keep that file private (chmod 600). AMO rejects re-uploads of a version: bump "version"
# in manifest.json before signing again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AMO_ENV_FILE="${AMO_ENV_FILE:-$HOME/.config/video-downloader/amo.env}"

if [[ -z "${WEB_EXT_API_KEY:-}" && -f "$AMO_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$AMO_ENV_FILE"
fi
if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
  echo "Missing AMO API credentials. Put WEB_EXT_API_KEY and WEB_EXT_API_SECRET in $AMO_ENV_FILE" >&2
  echo "(get them at https://addons.mozilla.org/developers/addon/api/key/)." >&2
  exit 1
fi
export WEB_EXT_API_KEY WEB_EXT_API_SECRET

cd "$ROOT"
node tools/build-firefox.mjs
npx web-ext lint --source-dir dist/firefox --warnings-as-errors=false
npx web-ext sign --source-dir dist/firefox --artifacts-dir dist/signed --channel unlisted
echo
echo "Signed add-on:"
ls -1t dist/signed/*.xpi | head -1
echo "Install it: Firefox → about:addons → gear icon → Install Add-on From File…"
