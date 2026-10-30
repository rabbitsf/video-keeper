#!/bin/bash
# Double-click to set up the YouTube button of Video Keeper on this Mac.
# Installs Homebrew (if missing), yt-dlp and ffmpeg, copies the helper to
# ~/Library/Application Support/VideoDownloader and registers it with Firefox and Chrome.
# All the work is done by helper/install.sh; this file only makes it double-clickable.

cd "$(dirname "$0")" || exit 1
clear
echo "=========================================="
echo "  Video Keeper — YouTube helper setup"
echo "=========================================="
echo
echo "This installs the free tools the YouTube button needs (Homebrew, yt-dlp, ffmpeg)."
echo "If Homebrew isn't installed yet, you'll be asked for your Mac password, and it"
echo "may take 5–15 minutes. Typing your password shows nothing — that's normal."
echo

if bash helper/install.sh --standalone --install-deps; then
  echo
  echo "✅ All set. Restart Firefox (or Chrome), open a YouTube video, and click the"
  echo "   Video Keeper button. Videos are saved to your Downloads folder."
else
  echo
  echo "❌ Something went wrong (see the messages above)."
  echo "   Take a screenshot of this window and send it to whoever shared this with you."
fi
echo
read -n 1 -s -r -p "Press any key to close this window."
echo
