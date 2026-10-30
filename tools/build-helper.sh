#!/bin/bash
# Build the Video Keeper companion helper (native/swift/main.swift) as a universal binary
# (Apple Silicon + Intel, macOS 12+) into dist/helper/video-keeper-helper.
# Signing/notarization happen in tools/build-installer.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/helper"
source "$ROOT/tools/release.conf"
mkdir -p "$OUT/arch"
# Generated from tools/release.conf — do not edit.
cat > "$OUT/BuildConfig.swift" <<EOF
let githubRepo = "$GITHUB_REPO"
let teamID = "$TEAM_ID"
EOF
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" -o "$OUT/arch/video-keeper-helper-$arch" \
    "$ROOT/native/swift/main.swift" "$ROOT/native/swift/SelfUpdate.swift" "$OUT/BuildConfig.swift"
done
lipo -create -output "$OUT/video-keeper-helper" "$OUT/arch/video-keeper-helper-arm64" "$OUT/arch/video-keeper-helper-x86_64"
rm -rf "$OUT/arch"
echo "Built dist/helper/video-keeper-helper ($(lipo -archs "$OUT/video-keeper-helper"))"
