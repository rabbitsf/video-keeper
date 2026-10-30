#!/bin/bash
# Build, sign and notarize "Video Keeper Helper <release>.pkg" (dist/installer/).
#
# Installs (system-wide, all users):
#   /Library/Application Support/VideoKeeper/   video-keeper-helper, python/, qjs, yt-dlp, ffmpeg, ffprobe,
#                                               licenses/, uninstall.sh  (runtime: tools/fetch-runtime.sh)
#   native messaging host manifests for Firefox, Chrome and Chromium (written by native/host-manifest.py)
#
# Needs: Developer ID Application + Developer ID Installer certificates in the keychain, and a
# notarytool keychain profile (default "video-keeper-notary"). Also writes the self-update files for
# the GitHub release (tools/release.conf): video-keeper-helper-<release>.zip (same signed programs as
# the .pkg, so they are covered by its notarization) and helper-update.json. Options:
#   --no-notarize    sign only (quick local test)
# Overrides: APP_SIGN_ID, INSTALLER_SIGN_ID, NOTARY_PROFILE
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NOTARIZE=1
[[ "${1:-}" == "--no-notarize" ]] && NOTARIZE=0

source tools/release.conf
RELEASE="$(sed -n 's/^let helperRelease = "\([^"]*\)".*/\1/p' native/swift/main.swift)"
PKG_ID="com.videokeeper.helper"
HOST_FILE="com.videodownloader.ytdlp.json"
INSTALL_DIR="/Library/Application Support/VideoKeeper"
identity() { security find-identity -v -p basic | sed -n "s/.*\"\($1: [^\"]*\)\".*/\1/p" | head -1; }
APP_SIGN_ID="${APP_SIGN_ID:-$(identity "Developer ID Application")}"
INSTALLER_SIGN_ID="${INSTALLER_SIGN_ID:-$(identity "Developer ID Installer")}"
NOTARY_PROFILE="${NOTARY_PROFILE:-video-keeper-notary}"
[[ -n "$RELEASE" && -n "$APP_SIGN_ID" && -n "$INSTALLER_SIGN_ID" ]] || {
  echo "Missing release number or Developer ID certificates (application: '$APP_SIGN_ID', installer: '$INSTALLER_SIGN_ID')." >&2
  exit 1
}

tools/build-helper.sh
[[ -x dist/ffmpeg/ffmpeg && -x dist/ffmpeg/ffprobe ]] || tools/build-ffmpeg.sh
[[ -x dist/runtime/python/bin/python3 && -x dist/runtime/qjs && -f dist/runtime/yt-dlp ]] || tools/fetch-runtime.sh

WORK="$ROOT/dist/installer/work"
OUT="$ROOT/dist/installer/Video Keeper Helper $RELEASE.pkg"
PAYLOAD="$WORK/root"
APPDIR="$PAYLOAD$INSTALL_DIR"
rm -rf "$WORK" "$OUT"
mkdir -p "$APPDIR" "$WORK/resources"

# Programs, signed with the hardened runtime (required for notarization).
cp dist/helper/video-keeper-helper dist/ffmpeg/ffmpeg dist/ffmpeg/ffprobe "$APPDIR/"
for tool in video-keeper-helper ffmpeg ffprobe; do
  codesign --force --options runtime --timestamp --identifier "$PKG_ID.$tool" --sign "$APP_SIGN_ID" "$APPDIR/$tool"
done
cp dist/ffmpeg/COPYING.LGPLv2.1 "$APPDIR/"
cp dist/ffmpeg/SOURCE.txt "$APPDIR/FFMPEG-SOURCE.txt"
cp tools/installer/uninstall.sh "$APPDIR/" && chmod 755 "$APPDIR/uninstall.sh"

# Runtime: standalone Python (+ certifi), QuickJS and the starting yt-dlp. Sign every Mach-O file
# (libraries and extension modules first, executables last) so Apple notarizes all of it, then run
# the signed copies once: a signing problem must fail the build, not reach users.
ditto dist/runtime/python "$APPDIR/python"
cp dist/runtime/qjs dist/runtime/yt-dlp "$APPDIR/"
mkdir -p "$APPDIR/licenses" && cp dist/runtime/licenses/* dist/runtime/VERSIONS.txt "$APPDIR/licenses/"
python3 - "$APPDIR/python" > "$WORK/runtime-binaries.txt" <<'EOF'
import os, sys
MAGIC = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')
libs, exes = [], []
for root, _, files in os.walk(sys.argv[1]):
    for name in files:
        path = os.path.join(root, name)
        if not os.path.islink(path) and open(path, 'rb').read(4) in MAGIC:
            (exes if os.access(path, os.X_OK) and '/bin/' in path else libs).append(path)
print('\n'.join(libs + exes))
EOF
while IFS= read -r binary; do
  codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$binary"
done < "$WORK/runtime-binaries.txt"
codesign --force --options runtime --timestamp --identifier "$PKG_ID.qjs" --sign "$APP_SIGN_ID" "$APPDIR/qjs"
echo "Signed runtime ($(wc -l < "$WORK/runtime-binaries.txt" | tr -d ' ') Python binaries + QuickJS)"
env -i PATH=/usr/bin:/bin PYTHONNOUSERSITE=1 "$APPDIR/python/bin/python3" -c 'import ssl, certifi, sqlite3' &&
  env -i PATH=/usr/bin:/bin "$APPDIR/python/bin/python3" "$APPDIR/yt-dlp" --version > /dev/null &&
  "$APPDIR/qjs" -e '1' > /dev/null || { echo "Signed runtime does not run" >&2; exit 1; }

# Browser registrations pointing at the installed helper.
for target in "firefox:/Library/Application Support/Mozilla/NativeMessagingHosts" \
              "chrome:/Library/Google/Chrome/NativeMessagingHosts" \
              "chrome:/Library/Application Support/Chromium/NativeMessagingHosts"; do
  mkdir -p "$PAYLOAD${target#*:}"
  python3 native/host-manifest.py "${target%%:*}" "$INSTALL_DIR/video-keeper-helper" "$PAYLOAD${target#*:}/$HOST_FILE"
done

pkgbuild --quiet --root "$PAYLOAD" --identifier "$PKG_ID" --version "$RELEASE" \
  --install-location / --ownership recommended "$WORK/helper.pkg"
cp tools/installer/welcome.html tools/installer/license.html "$WORK/resources/"
cat > "$WORK/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Video Keeper Helper</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <license file="license.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="12.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="$PKG_ID"/></choices-outline>
  <choice id="$PKG_ID" title="Video Keeper Helper"><pkg-ref id="$PKG_ID"/></choice>
  <pkg-ref id="$PKG_ID" version="$RELEASE" onConclusion="none">helper.pkg</pkg-ref>
</installer-gui-script>
EOF
productbuild --quiet --distribution "$WORK/distribution.xml" --resources "$WORK/resources" \
  --package-path "$WORK" --sign "$INSTALLER_SIGN_ID" --timestamp "$OUT"
echo "Signed: $OUT"

if [[ $NOTARIZE -eq 1 ]]; then
  echo "Submitting to Apple for notarization (usually a few minutes)…"
  RESULT="$(xcrun notarytool submit "$OUT" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)"
  echo "$RESULT" | grep -E '^ *(id|status):' | awk '!seen[$1]++'
  if ! echo "$RESULT" | grep -q "status: Accepted"; then
    ID="$(echo "$RESULT" | sed -n 's/^ *id: //p' | head -1)"
    [[ -n "$ID" ]] && xcrun notarytool log "$ID" --keychain-profile "$NOTARY_PROFILE" || true
    echo "Notarization failed." >&2
    exit 1
  fi
  xcrun stapler staple "$OUT"
  spctl --assess --type install --verbose=2 "$OUT"
fi
# Self-update files (see native/swift/SelfUpdate.swift). Upload both to GitHub release "helper-v$RELEASE".
ZIP_NAME="video-keeper-helper-$RELEASE.zip"
rm -f "$ROOT/dist/installer/"video-keeper-helper-*.zip
ditto -c -k "$APPDIR" "$ROOT/dist/installer/$ZIP_NAME"
cat > "$ROOT/dist/installer/helper-update.json" <<EOF
{
  "version": "$RELEASE",
  "url": "https://github.com/$GITHUB_REPO/releases/download/helper-v$RELEASE/$ZIP_NAME",
  "sha256": "$(shasum -a 256 "$ROOT/dist/installer/$ZIP_NAME" | cut -d' ' -f1)"
}
EOF
rm -rf "$WORK"
echo "Done: $OUT"
echo "Update files: dist/installer/$ZIP_NAME, dist/installer/helper-update.json"
