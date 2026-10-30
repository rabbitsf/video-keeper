#!/bin/bash
# Remove the Video Keeper Helper (installed by "Video Keeper Helper.pkg").
# Run: sudo "/Library/Application Support/VideoKeeper/uninstall.sh"
# Each user's downloaded yt-dlp copy (~/Library/Application Support/VideoKeeper) is left in place;
# delete that folder too if you like.
set -u
if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo." >&2
  exit 1
fi
HOST="com.videodownloader.ytdlp.json"
rm -f "/Library/Application Support/Mozilla/NativeMessagingHosts/$HOST" \
      "/Library/Google/Chrome/NativeMessagingHosts/$HOST" \
      "/Library/Application Support/Chromium/NativeMessagingHosts/$HOST"
rm -rf "/Library/Application Support/VideoKeeper"
pkgutil --forget com.videokeeper.helper >/dev/null 2>&1
echo "Video Keeper Helper removed."
