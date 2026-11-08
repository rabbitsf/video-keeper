#!/usr/bin/env python3
"""Native messaging host: runs yt-dlp for the Video Keeper extension.

Chrome starts one host process per connectNative() port. Protocol (JSON, length-prefixed):
  extension -> host: {"type": "ping"} | {"type": "download", "url", "quality"} | {"type": "cancel"}
  host -> extension: {"type": "pong", ...} | {"type": "progress", ...} | {"type": "done", "path", "filename"}
                     | {"type": "error", "error"} | {"type": "cancelled"}
Closing the port (stdin EOF) cancels a running download.

Standard library only; must stay compatible with macOS's /usr/bin/python3 (3.9).

Installed layouts:
  macOS family/Homebrew (native/install.sh): host.py alone; tools come from Homebrew.
  Windows (tools/windows/): host.py + release.txt + bin/ (yt-dlp.exe, ffmpeg.exe, qjs.exe) in a
  per-user folder. The bundled yt-dlp updates itself at most once a day.
"""
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time

IS_WINDOWS = os.name == "nt"

VERSION = 1
HELPER_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(HELPER_DIR, "bin")  # Bundled tools (Windows install); searched first.
RELEASE_FILE = os.path.join(HELPER_DIR, "release.txt")
UPDATE_STAMP = os.path.join(HELPER_DIR, "ytdlp-update.stamp")
VERSION_CACHE = os.path.join(HELPER_DIR, "ytdlp-version.json")
UPDATE_INTERVAL = 24 * 60 * 60
# Browsers launch hosts with a minimal PATH; add the usual install locations (yt-dlp, ffmpeg, node).
EXTRA_PATH = [] if IS_WINDOWS else ["/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin")]
# No console windows for yt-dlp/ffmpeg on Windows (the host itself runs without one).
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# Tools never get our stdin (the browser's message pipe): on Windows a child that inherits it hangs at
# startup while the main thread is blocked reading it. Always pass stdin=subprocess.DEVNULL.
OUTPUT_TEMPLATE = "%(title).150B [%(id)s].%(ext)s"
PROGRESS_INTERVAL = 0.5

# Canonical mapping of the popup's quality choices to yt-dlp format arguments.
# Prefer H.264 + AAC at each resolution so the merged .mp4 plays in QuickTime.
QUALITY_ARGS = {
    "best": ["-f", "bv*+ba/b", "-S", "res,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4"],
    "1080": ["-f", "bv*+ba/b", "-S", "res:1080,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4"],
    "720": ["-f", "bv*+ba/b", "-S", "res:720,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4"],
    "audio": ["-f", "ba[ext=m4a]/ba", "-x", "--audio-format", "m4a"],
}

ENV = dict(
    os.environ,
    PATH=os.pathsep.join([BIN_DIR] + EXTRA_PATH + [os.environ.get("PATH", "/usr/bin:/bin")]),
    PYTHONIOENCODING="utf-8",  # yt-dlp.exe is Python too: UTF-8 titles/paths on Windows consoles.
)


def downloads_dir():
    """The user's Downloads folder (Windows: the Known Folder, which may be moved, e.g. to OneDrive)."""
    if IS_WINDOWS:
        try:
            import ctypes
            import uuid
            from ctypes import wintypes

            folder_id = uuid.UUID("{374DE290-123F-4565-9164-39C4925E467B}")  # FOLDERID_Downloads
            guid = (ctypes.c_byte * 16).from_buffer_copy(folder_id.bytes_le)
            result = ctypes.c_wchar_p()
            shell32 = ctypes.windll.shell32
            if shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(result)) == 0:
                try:
                    return result.value
                finally:
                    ctypes.windll.ole32.CoTaskMemFree(result)
        except Exception:  # noqa: BLE001 — fall back to the usual location
            pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


OUTPUT_DIR = downloads_dir()


def helper_release():
    try:
        with open(RELEASE_FILE) as f:
            return f.read().strip() or None
    except OSError:
        return None
_write_lock = threading.Lock()


def send(message):
    data = json.dumps(message).encode("utf-8")
    with _write_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
        sys.stdout.buffer.flush()


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def find_ytdlp():
    return shutil.which("yt-dlp", path=ENV["PATH"])


def ytdlp_version(path):
    """yt-dlp's version, cached per yt-dlp file: running it takes seconds (yt-dlp.exe unpacks itself
    first, slower still under emulation on Windows on Arm), and the browser gives up waiting for pong."""
    try:
        info = os.stat(path)
        key = [os.path.abspath(path), info.st_size, info.st_mtime]
    except OSError:
        key = None
    try:
        with open(VERSION_CACHE) as f:
            cached = json.load(f)
        if key and cached.get("key") == key and cached.get("version"):
            return cached["version"]
    except (OSError, ValueError, AttributeError):
        pass
    version = _run_ytdlp_version(path)
    if key and version:
        try:
            with open(VERSION_CACHE, "w") as f:
                json.dump({"key": key, "version": version}, f)
        except OSError:
            pass
    return version


def _run_ytdlp_version(path):
    try:
        return subprocess.run(
            [path, "--version"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15, env=ENV,
            creationflags=NO_WINDOW,
        ).stdout.strip()
    except Exception:  # noqa: BLE001 — report "unknown" rather than fail the ping
        return ""


def js_runtime_args():
    """yt-dlp needs a JS engine for YouTube; use the bundled QuickJS when there is one."""
    qjs = shutil.which("qjs", path=BIN_DIR)
    return ["--js-runtimes", "quickjs:" + qjs] if qjs else []


def update_bundled_ytdlp_if_stale(path):
    """At most once a day, let the bundled yt-dlp update itself (its own verified updater).

    Runs detached so it outlives this host process (which exits when the port closes). A
    Homebrew-managed yt-dlp is never touched. Any failure just keeps the current copy.
    """
    if not path or os.path.dirname(os.path.abspath(path)) != BIN_DIR:
        return
    try:
        if time.time() - os.path.getmtime(UPDATE_STAMP) < UPDATE_INTERVAL:
            return
    except OSError:
        pass
    try:
        with open(UPDATE_STAMP, "w"):  # Stamp first: a failing update still waits a day.
            pass
        flags = NO_WINDOW | getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen(
            [path, "-U"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=ENV, creationflags=flags, start_new_session=not IS_WINDOWS,
        )
    except OSError:
        pass


class Job:
    def __init__(self, url, quality):
        self.url = url
        self.quality = quality if quality in QUALITY_ARGS else "best"
        self.proc = None
        self.cancelled = False
        self.temp_files = set()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def cancel(self):
        # Stop yt-dlp with everything it started: yt-dlp.exe runs the real yt-dlp as a child process,
        # and yt-dlp runs ffmpeg. Stopping only the top process would let the download go on.
        self.cancelled = True
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW, timeout=15,
                )
            else:
                os.killpg(self.proc.pid, signal.SIGTERM)  # its own process group (start_new_session)
        except (OSError, subprocess.SubprocessError):
            self.proc.kill()

    def run(self):
        ytdlp = find_ytdlp()
        if not ytdlp:
            send({"type": "error", "error": "yt-dlp not found — run native/install.sh"})
            return
        cmd = [
            ytdlp, "--no-playlist", "--newline", "--progress", "--quiet", "--no-simulate",
            "--progress-template", "download:VDLP %(progress)j",
            "--print", "before_dl:VDLT %(title)s",
            "--print", "after_move:VDLF %(filepath)s",
            *QUALITY_ARGS[self.quality],
            *js_runtime_args(),
            "-P", OUTPUT_DIR, "-o", OUTPUT_TEMPLATE,
            "--", self.url,
        ]
        send({"type": "progress", "status": "starting"})
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace", bufsize=1, env=ENV, creationflags=NO_WINDOW,
            start_new_session=not IS_WINDOWS,
        )
        final_path, error, passes, last_sent = None, None, 0, 0.0
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            if line.startswith("VDLT "):
                send({"type": "progress", "status": "downloading", "title": line[5:], "percent": 0, "pass": passes + 1})
            elif line.startswith("VDLF "):
                final_path = line[5:]
            elif line.startswith("VDLP "):
                try:
                    progress = json.loads(line[5:])
                except ValueError:
                    continue
                for key in ("tmpfilename", "filename"):
                    if progress.get(key):
                        self.temp_files.add(progress[key])
                if progress.get("status") == "finished":
                    passes += 1
                    send({"type": "progress", "status": "processing"})
                elif time.time() - last_sent >= PROGRESS_INTERVAL:
                    last_sent = time.time()
                    total = progress.get("total_bytes") or progress.get("total_bytes_estimate")
                    done = progress.get("downloaded_bytes") or 0
                    send({
                        "type": "progress",
                        "status": "downloading",
                        "percent": round(100 * done / total, 1) if total else None,
                        "bytes": done,
                        "speed": progress.get("speed"),
                        "eta": progress.get("eta"),
                        "pass": passes + 1,
                    })
            elif line.startswith("ERROR:"):
                error = line[6:].strip()
        code = self.proc.wait()

        if self.cancelled:
            self.remove_temp_files(keep=final_path)
            send({"type": "cancelled"})
        elif code == 0 and final_path:
            size = os.path.getsize(final_path) if os.path.isfile(final_path) else None
            send({"type": "done", "path": final_path, "filename": os.path.basename(final_path), "bytes": size})
        else:
            send({"type": "error", "error": error or "yt-dlp exited with code %d" % code})

    def remove_temp_files(self, keep=None):
        # Only files yt-dlp reported writing for this job (partial downloads and unmerged parts).
        for path in self.temp_files:
            for candidate in (path, path + ".part", path + ".ytdl"):
                if candidate != keep and os.path.isfile(candidate):
                    try:
                        os.remove(candidate)
                    except OSError:
                        pass


def main():
    job = None
    while True:
        message = read_message()
        if message is None:  # Port closed by the extension or Chrome exited.
            break
        kind = message.get("type")
        if kind == "ping":
            path = find_ytdlp()
            pong = {
                "type": "pong",
                "version": VERSION,
                "ytdlp": path,
                "ytdlpVersion": ytdlp_version(path) if path else "",
                "ffmpeg": bool(shutil.which("ffmpeg", path=ENV["PATH"])),
            }
            release = helper_release()
            if release:
                pong["release"] = release
            send(pong)
            update_bundled_ytdlp_if_stale(path)
        elif kind == "download" and job is None:
            job = Job(message.get("url", ""), message.get("quality", "best"))
            job.thread.start()
        elif kind == "cancel" and job:
            job.cancel()
    if job:
        job.cancel()
        job.thread.join(timeout=10)


if __name__ == "__main__":
    main()
