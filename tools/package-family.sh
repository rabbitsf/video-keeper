#!/bin/bash
# Assemble "Video Keeper for Mac.zip" for sharing with family (dist/family/).
# Contents: the newest Mozilla-signed Firefox add-on (dist/signed), the signed + notarized
# Video Keeper Helper installer (dist/installer, from tools/build-installer.sh), the Chrome
# extension folder and the Read Me (template: tools/family/Read Me.html). Run: npm run package:family
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="Video Keeper for Mac"
OUT="$ROOT/dist/family"
STAGE="$OUT/$NAME"
cd "$ROOT"

# Newest signed add-on by the version inside it (file names vary: web-ext sign vs. AMO download).
XPI_SRC="$(python3 - <<'EOF'
import glob, json, zipfile
def version(path):
    v = json.loads(zipfile.ZipFile(path).read('manifest.json'))['version']
    return [int(x) for x in v.split('.')], v, path
found = sorted(version(p) for p in glob.glob('dist/signed/*.xpi'))
print(found[-1][2] if found else '')
EOF
)"
[[ -n "$XPI_SRC" ]] || { echo "No signed Firefox add-on in dist/signed — download it from AMO or run: npm run sign:firefox" >&2; exit 1; }
VERSION="$(unzip -p "$XPI_SRC" manifest.json | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])')"

PKG_SRC="$(ls -t dist/installer/Video\ Keeper\ Helper\ *.pkg 2>/dev/null | head -1 || true)"
[[ -n "$PKG_SRC" ]] || { echo "No helper installer in dist/installer — run: tools/build-installer.sh" >&2; exit 1; }
xcrun stapler validate "$PKG_SRC" > /dev/null || { echo "$PKG_SRC is not notarized — run: tools/build-installer.sh" >&2; exit 1; }
HELPER_RELEASE="$(basename "$PKG_SRC" .pkg | sed 's/^Video Keeper Helper //')"

XPI="Video Keeper $VERSION (Firefox).xpi"
PKG="Video Keeper Helper $HELPER_RELEASE.pkg"
rm -rf "$OUT"
mkdir -p "$STAGE/Chrome extension"
cp "$XPI_SRC" "$STAGE/$XPI"
cp "$PKG_SRC" "$STAGE/$PKG"
cp -R manifest.json src icons "$STAGE/Chrome extension/"
rm -f "$STAGE/Chrome extension/src/background.html" # Firefox-only background page.
sed -e "s/{{VERSION}}/$VERSION/g" -e "s/{{XPI}}/$XPI/g" -e "s/{{PKG}}/$PKG/g" "tools/family/Read Me.html" > "$STAGE/Read Me.html"
find "$STAGE" -name .DS_Store -delete

# --norsrc --noextattr: no "._" AppleDouble files for quarantine/Finder metadata in the zip.
(cd "$OUT" && ditto -c -k --norsrc --noextattr --keepParent "$NAME" "$NAME.zip")
echo "Built dist/family/$NAME.zip (add-on $VERSION, helper $HELPER_RELEASE, $(du -h "$OUT/$NAME.zip" | cut -f1 | tr -d ' '))"
