#!/bin/bash
# Registers the yt-dlp helper (native messaging host) with Chrome and Firefox and makes sure
# yt-dlp is installed.
#
# Usage:
#   native/install.sh                       install or update (helper runs from this folder)
#   native/install.sh --standalone          copy the helper to ~/Library/Application Support/VideoDownloader
#                                           and register that copy (the source folder can then be deleted)
#   native/install.sh --install-deps        also install Homebrew (if missing) and ffmpeg
#   native/install.sh --uninstall           remove the registration (and the standalone copy)
#   native/install.sh --browser-dir DIR     also register in DIR/NativeMessagingHosts (repeatable;
#                                           e.g. a custom Chrome --user-data-dir used for testing)
# The family package's "Install YouTube Helper.command" runs: --standalone --install-deps
set -euo pipefail

# Host name and allowed extension IDs live in host-manifest.py (shared with the .pkg build).
HOST_NAME="com.videodownloader.ytdlp"
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$DIR/host.py"
STANDALONE_DIR="$HOME/Library/Application Support/VideoDownloader"

BROWSER_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome"
  "$HOME/Library/Application Support/Google/Chrome Beta"
  "$HOME/Library/Application Support/Chromium"
)
# Firefox reads host manifests from one per-user folder (created if Firefox is installed).
FIREFOX_DIR="$HOME/Library/Application Support/Mozilla"
UNINSTALL=0
STANDALONE=0
INSTALL_DEPS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --standalone) STANDALONE=1 ;;
    --install-deps) INSTALL_DEPS=1 ;;
    --browser-dir) shift; BROWSER_DIRS+=("$1") ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ $UNINSTALL -eq 1 ]]; then
  for d in "${BROWSER_DIRS[@]}" "$FIREFOX_DIR"; do
    f="$d/NativeMessagingHosts/$HOST_NAME.json"
    [[ -f "$f" ]] && rm -f "$f" && echo "Removed $f"
  done
  [[ -d "$STANDALONE_DIR" ]] && rm -rf "$STANDALONE_DIR" && echo "Removed $STANDALONE_DIR"
  exit 0
fi

# Homebrew lives in /opt/homebrew (Apple Silicon) or /usr/local (Intel).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v brew >/dev/null 2>&1 && [[ $INSTALL_DEPS -eq 1 ]]; then
  echo "Installing Homebrew (asks for your Mac password; the first install can take 5–15 minutes)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  hash -r
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing yt-dlp with Homebrew…"
    brew install yt-dlp
  else
    echo "yt-dlp not found and Homebrew is unavailable. Install yt-dlp, then rerun this script." >&2
    exit 1
  fi
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  if [[ $INSTALL_DEPS -eq 1 ]]; then
    echo "Installing ffmpeg with Homebrew (merges video and audio)…"
    brew install ffmpeg
  else
    echo "Warning: ffmpeg not found — run 'brew install ffmpeg' (needed to merge video and audio)."
  fi
fi

if ! /usr/bin/env python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  echo "python3 (3.9+) is required on the default PATH for the helper." >&2
  exit 1
fi

if [[ $STANDALONE -eq 1 ]]; then
  # A fixed location, so the helper keeps working after the downloaded folder is deleted.
  mkdir -p "$STANDALONE_DIR"
  cp "$DIR/host.py" "$STANDALONE_DIR/host.py"
  HOST_PATH="$STANDALONE_DIR/host.py"
  # Files from AirDrop/browser downloads carry a quarantine flag; the browser runs this script directly.
  xattr -d com.apple.quarantine "$HOST_PATH" 2>/dev/null || true
  echo "Installed helper to $STANDALONE_DIR"
fi
chmod +x "$HOST_PATH"

# write_host_manifest <file> <chrome|firefox>
write_host_manifest() {
  /usr/bin/env python3 "$DIR/host-manifest.py" "$2" "$HOST_PATH" "$1"
}

installed=0
for d in "${BROWSER_DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  mkdir -p "$d/NativeMessagingHosts"
  write_host_manifest "$d/NativeMessagingHosts/$HOST_NAME.json" chrome
  echo "Registered helper in $d/NativeMessagingHosts"
  installed=1
done
if [[ -d /Applications/Firefox.app || -d "$FIREFOX_DIR" ]]; then
  mkdir -p "$FIREFOX_DIR/NativeMessagingHosts"
  write_host_manifest "$FIREFOX_DIR/NativeMessagingHosts/$HOST_NAME.json" firefox
  echo "Registered helper in $FIREFOX_DIR/NativeMessagingHosts (Firefox)"
  installed=1
fi

if [[ $installed -eq 0 ]]; then
  echo "No Chrome profile folder or Firefox found — open the browser once, then rerun this script." >&2
  exit 1
fi
echo "yt-dlp $(yt-dlp --version) ready. Reload the extension in your browser."
