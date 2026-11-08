#!/usr/bin/env python3
"""Write the native messaging host manifest that lets a browser launch the helper.

Usage: host-manifest.py chrome|firefox HELPER_PATH OUTPUT_FILE

Single source for the host name and allowed extension IDs, used by native/install.sh (per-user,
family/Homebrew path), tools/build-installer.sh (system-wide, signed .pkg) and
tools/windows/stage-helper.mjs (Windows: HELPER_PATH is the launcher, relative to the manifest).
"""
import json
import sys

HOST_NAME = "com.videodownloader.ytdlp"  # Must match NATIVE_HOST in src/background.js.
CHROME_ID = "bojccbhkobfebeemknmfclbkhcmkkkie"  # Fixed by the "key" in manifest.json.
FIREFOX_ID = "video-downloader-14a7930f@personal.addon"  # FIREFOX_ID in tools/build-firefox.mjs.


def manifest(browser, path):
    result = {"name": HOST_NAME, "description": "Video Keeper helper", "path": path, "type": "stdio"}
    if browser == "firefox":
        result["allowed_extensions"] = [FIREFOX_ID]
    elif browser == "chrome":
        result["allowed_origins"] = ["chrome-extension://%s/" % CHROME_ID]
    else:
        raise SystemExit("browser must be chrome or firefox")
    return result


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    browser, path, out = sys.argv[1:]
    with open(out, "w") as f:
        json.dump(manifest(browser, path), f, indent=2)
        f.write("\n")
