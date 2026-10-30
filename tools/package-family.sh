#!/bin/bash
# Assemble "Video Keeper for Mac.zip" for sharing with family (dist/family/).
# Contents: the signed Firefox add-on, the Chrome extension folder, the YouTube helper
# (native/host.py + native/install.sh), the double-click installer and the Read Me.
# Sources for the last two live in tools/family/. Run: npm run package:family
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="Video Keeper for Mac"
OUT="$ROOT/dist/family"
STAGE="$OUT/$NAME"

cd "$ROOT"
VERSION="$(node -p "require('./manifest.json').version")"
XPI_SRC="$(ls -t dist/signed/*-"$VERSION".xpi 2>/dev/null | head -1 || true)"
if [[ -z "$XPI_SRC" ]]; then
  echo "No signed Firefox add-on for version $VERSION in dist/signed — run: npm run sign:firefox" >&2
  exit 1
fi
XPI="Video Keeper $VERSION (Firefox).xpi"

rm -rf "$OUT"
mkdir -p "$STAGE/helper" "$STAGE/Chrome extension"
cp "$XPI_SRC" "$STAGE/$XPI"
cp -R manifest.json src icons "$STAGE/Chrome extension/"
rm -f "$STAGE/Chrome extension/src/background.html" # Firefox-only background page.
cp native/host.py native/install.sh native/host-manifest.py "$STAGE/helper/"
cp "tools/family/Install YouTube Helper.command" "$STAGE/"
chmod +x "$STAGE/helper/host.py" "$STAGE/helper/install.sh" "$STAGE/helper/host-manifest.py" "$STAGE/Install YouTube Helper.command"
sed -e "s/{{VERSION}}/$VERSION/g" -e "s/{{XPI}}/$XPI/g" "tools/family/Read Me.html" > "$STAGE/Read Me.html"
find "$STAGE" -name .DS_Store -delete

# ditto keeps the executable bits that a double-clickable .command needs.
(cd "$OUT" && ditto -c -k --keepParent "$NAME" "$NAME.zip")
echo "Built dist/family/$NAME.zip (version $VERSION, $(du -h "$OUT/$NAME.zip" | cut -f1 | tr -d ' '))"
