#!/bin/bash
# Fetch the runtime the Video Keeper helper ships with, into dist/runtime/ (all checksum-verified):
#   python/   standalone CPython (python-build-standalone), universal (arm64 + x86_64), + certifi
#   qjs       QuickJS-NG, universal — the JavaScript engine yt-dlp needs for full YouTube support
#   yt-dlp    the official zipimport build (pure Python, bundles yt-dlp-ejs) — the starting copy;
#             the helper replaces it with newer releases by itself (it's data for Python, so
#             Gatekeeper never blocks an update)
# tools/build-installer.sh signs every program in it so Apple notarizes it with the helper.
set -euo pipefail

PYTHON_VERSION="3.13.18"
PYTHON_BUILD="20261026"
QJS_VERSION="v0.17.0"
QJS_SHA256_ARM64="8be3ddfe3397d2e692e4e1e8972ee9d032a0a580505d2f8b4ea528cf1b651c11" # Must also match GitHub's asset digest.
QJS_SHA256_X86_64="9e5e101b4fd13cda3204222ca9f8be35412c41dcdef3745829633b7a67245412"
CERTIFI_VERSION="2026.10.23"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/runtime"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
is_macho() { python3 -c 'import sys; sys.exit(open(sys.argv[1],"rb").read(4) not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"))' "$1"; }

rm -rf "$OUT" && mkdir -p "$OUT/licenses"

# --- Python (both architectures, merged into universal binaries) -------------------------------
PBS="https://github.com/astral-sh/python-build-standalone/releases/download/$PYTHON_BUILD"
fetch "$PBS/SHA256SUMS" "$WORK/PYSUMS"
for arch in aarch64 x86_64; do
  name="cpython-$PYTHON_VERSION+$PYTHON_BUILD-$arch-apple-darwin-install_only_stripped.tar.gz"
  fetch "$PBS/$name" "$WORK/$name"
  expected="$(awk -v n="$name" '$2 == n { print $1 }' "$WORK/PYSUMS")"
  [[ -n "$expected" && "$(sha "$WORK/$name")" == "$expected" ]] || { echo "Checksum mismatch: $name" >&2; exit 1; }
  mkdir -p "$WORK/$arch" && tar -xzf "$WORK/$name" -C "$WORK/$arch"
done
ditto "$WORK/aarch64/python" "$OUT/python"
( cd "$WORK/aarch64/python" && find . -type f ) | while IFS= read -r rel; do
  if is_macho "$OUT/python/$rel"; then
    lipo -create -output "$OUT/python/$rel" "$WORK/aarch64/python/$rel" "$WORK/x86_64/python/$rel"
  fi
done
"$OUT/python/bin/python3" -m pip install --quiet --disable-pip-version-check --no-cache-dir "certifi==$CERTIFI_VERSION"
# Trim what yt-dlp never uses (GUI toolkit, test suite, headers, pip itself).
PYLIB="$OUT/python/lib/python${PYTHON_VERSION%.*}"
rm -rf "$PYLIB"/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3} "$PYLIB/site-packages/pip" "$PYLIB"/site-packages/pip-* \
       "$OUT/python/include" "$OUT/python/share" "$OUT/python/lib"/{tcl*,tk*,itcl*,thread*} "$OUT/python/lib"/lib{tcl,tk}*
find "$PYLIB" -name '_tkinter*.so' -delete
find "$OUT/python" -name '__pycache__' -type d -prune -exec rm -rf {} +
cp "$PYLIB/LICENSE.txt" "$OUT/licenses/Python-LICENSE.txt"

# --- QuickJS-NG ---------------------------------------------------------------------------------
QJS="https://github.com/quickjs-ng/quickjs/releases/download/$QJS_VERSION"
for arch in arm64 x86_64; do
  fetch "$QJS/qjs-darwin-$arch" "$WORK/qjs-$arch"
  pinned_var="QJS_SHA256_$(echo "$arch" | tr '[:lower:]' '[:upper:]')"
  pinned="${!pinned_var}"
  digest="$(curl -fsSL "https://api.github.com/repos/quickjs-ng/quickjs/releases/tags/$QJS_VERSION" |
    python3 -c 'import sys, json; n = sys.argv[1]; print(next(a["digest"] for a in json.load(sys.stdin)["assets"] if a["name"] == n).split(":")[1])' "qjs-darwin-$arch")"
  actual="$(sha "$WORK/qjs-$arch")"
  [[ "$actual" == "$digest" ]] || { echo "QuickJS $arch does not match GitHub's digest" >&2; exit 1; }
  [[ -z "$pinned" || "$actual" == "$pinned" ]] || { echo "QuickJS $arch changed since it was pinned" >&2; exit 1; }
  [[ -z "$pinned" ]] && echo "NOTE: pin $pinned_var=\"$actual\""
done
lipo -create -output "$OUT/qjs" "$WORK/qjs-arm64" "$WORK/qjs-x86_64" && chmod 755 "$OUT/qjs"
fetch "https://raw.githubusercontent.com/quickjs-ng/quickjs/$QJS_VERSION/LICENSE" "$OUT/licenses/QuickJS-NG-LICENSE.txt"

# --- yt-dlp (starting copy) ---------------------------------------------------------------------
YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
fetch "$YTDLP_BASE/SHA2-256SUMS" "$WORK/YTSUMS"
fetch "$YTDLP_BASE/yt-dlp" "$OUT/yt-dlp"
[[ "$(sha "$OUT/yt-dlp")" == "$(awk '$2 == "yt-dlp" { print $1 }' "$WORK/YTSUMS")" ]] || { echo "yt-dlp checksum mismatch" >&2; exit 1; }
YTDLP_VERSION="$("$OUT/python/bin/python3" "$OUT/yt-dlp" --version)"
fetch "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$YTDLP_VERSION/LICENSE" "$OUT/licenses/yt-dlp-LICENSE.txt"

# Sanity checks with the merged universal runtime.
"$OUT/python/bin/python3" -c 'import ssl, certifi, sqlite3, zipimport; print("python", __import__("sys").version.split()[0], "certifi", certifi.__version__)'
"$OUT/qjs" -e 'print("quickjs ok")' >/dev/null
cat > "$OUT/VERSIONS.txt" <<EOF
Python $PYTHON_VERSION (python-build-standalone $PYTHON_BUILD), certifi $CERTIFI_VERSION
QuickJS-NG $QJS_VERSION
yt-dlp $YTDLP_VERSION (starting copy; the helper updates it daily)
EOF
echo "Fetched runtime into dist/runtime ($(du -sh "$OUT" | cut -f1 | tr -d ' ')): $(tr '\n' ';' < "$OUT/VERSIONS.txt")"
