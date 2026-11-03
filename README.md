# Video Keeper

A browser extension that saves videos from the pages you visit as ordinary MP4 files in your Downloads folder.

- **Video files** on a page (`<video>` elements, links to `.mp4`/`.webm`, files the player loads) — one click to save.
- **Streaming video (HLS)** — pick the quality, watch the progress, cancel any time. Streams are joined into a
  standard MP4 that plays in QuickTime, Photos and on iPhone; AES-128-encrypted streams are supported.
- **YouTube** (Mac) — with the free **Video Keeper Helper** companion app, which runs
  [yt-dlp](https://github.com/yt-dlp/yt-dlp) for you and keeps it up to date.

Video Keeper can't save copy-protected (DRM) video such as Netflix, Disney+ or Prime Video, or live streams.

## Install

**Firefox:** install [Video Keeper from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/video-keeper/).

**Chrome:** the Chrome Web Store doesn't allow YouTube downloaders, so load it yourself: download this repository
(**Code → Download ZIP**), unzip it somewhere permanent, open `chrome://extensions`, turn on **Developer mode** and
click **Load unpacked** on the unzipped folder.

After installing, a welcome page explains the basics. Pin the button from the puzzle-piece menu in the toolbar.

## YouTube downloads: Video Keeper Helper (Mac)

Browsers don't let extensions run programs, so YouTube downloads go through a small helper app.

1. Download **Video Keeper Helper** (`.pkg`) from the [latest release](https://github.com/rabbitsf/video-keeper/releases/latest).
2. Open it and follow the installer (it asks for your Mac password once).
3. Quit and reopen your browser. On a YouTube video, the Video Keeper button now offers **Download with yt-dlp**.

The helper is signed with a Developer ID and notarized by Apple. It installs into
`/Library/Application Support/VideoKeeper`: the helper itself, yt-dlp, a private copy of Python to run it,
QuickJS (the JavaScript engine yt-dlp needs for YouTube) and FFmpeg (to combine picture and sound).

**It keeps itself up to date.** At most once a day it checks for a newer yt-dlp
([yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases), verified against the published checksum) and a newer
helper ([this repository's releases](https://github.com/rabbitsf/video-keeper/releases)). A helper update is installed
in your user folder only if every program in it is signed by the same developer team and notarized by Apple.

**Uninstall:** run in Terminal

```sh
sudo "/Library/Application Support/VideoKeeper/uninstall.sh"
rm -rf ~/Library/Application\ Support/VideoKeeper
```

## Privacy

Video Keeper collects no data. See the [privacy policy](PRIVACY.md).

## Please download responsibly

Only download videos you have the right to: your own, openly licensed ones, or where the website allows it.
Many sites' terms of service — including YouTube's — prohibit downloading.

## Building from source

Requirements: macOS, Node.js 22+, Xcode command-line tools.

```sh
npm install
npm test                    # unit tests
npm run build:firefox       # Firefox build in dist/firefox (Chrome loads the repository root)
npm run build:chrome-store  # Chrome Web Store build in dist/chrome-store (+ .zip), without YouTube support
tools/build-installer.sh    # helper .pkg + self-update files (needs Developer ID certificates
                            # and a notarytool profile; --no-notarize for a local build)
```

| Path | What it is |
|---|---|
| `manifest.json`, `src/` | The extension (Chrome uses the root; Firefox's manifest is derived by `tools/build-firefox.mjs`) |
| `src/lib/` | Shared logic: detection, HLS parsing and joining, MP4 building, helper status |
| `native/swift/` | Video Keeper Helper (native messaging host) |
| `native/host.py`, `native/install.sh` | Lightweight Python helper using Homebrew's yt-dlp, for personal setups |
| `tools/` | Build, signing, notarization and packaging scripts; `tools/release.conf` holds release settings |
| `test/` | Unit tests (`node --test`) |

## License

[MIT](LICENSE). Bundled and downloaded third-party software keeps its own license:
[mux.js](src/vendor/mux.js-LICENSE) (Apache-2.0), FFmpeg (LGPL-2.1, built without GPL or non-free parts), yt-dlp and
yt-dlp-ejs (Unlicense), Python (PSF License), certifi (MPL-2.0) and QuickJS-NG (MIT). The helper installs their
license texts in `/Library/Application Support/VideoKeeper`.
