#!/usr/bin/env python3
"""Native messaging host: runs yt-dlp for the Video Keeper extension.

Chrome starts one host process per connectNative() port. Protocol (JSON, length-prefixed):
  extension -> host: {"type": "ping"} | {"type": "download", "url", "quality"} | {"type": "cancel"}
  host -> extension: {"type": "pong", ...} | {"type": "progress", ...} | {"type": "done", "path", "filename"}
                     | {"type": "error", "error"} | {"type": "cancelled"}
Closing the port (stdin EOF) cancels a running download.

Standard library only; must stay compatible with macOS's /usr/bin/python3 (3.9).
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import threading
import time

VERSION = 1
# Chrome launches hosts with a minimal PATH; add the usual install locations (yt-dlp, ffmpeg, node).
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin")]
OUTPUT_DIR = os.path.expanduser("~/Downloads")
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

ENV = dict(os.environ, PATH=os.pathsep.join(EXTRA_PATH + [os.environ.get("PATH", "/usr/bin:/bin")]))
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
    try:
        return subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15, env=ENV).stdout.strip()
    except Exception:  # noqa: BLE001 — report "unknown" rather than fail the ping
        return ""


class Job:
    def __init__(self, url, quality):
        self.url = url
        self.quality = quality if quality in QUALITY_ARGS else "best"
        self.proc = None
        self.cancelled = False
        self.temp_files = set()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def cancel(self):
        self.cancelled = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

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
            "-P", OUTPUT_DIR, "-o", OUTPUT_TEMPLATE,
            "--", self.url,
        ]
        send({"type": "progress", "status": "starting"})
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            errors="replace", bufsize=1, env=ENV,
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
            send({
                "type": "pong",
                "version": VERSION,
                "ytdlp": path,
                "ytdlpVersion": ytdlp_version(path) if path else "",
                "ffmpeg": bool(shutil.which("ffmpeg", path=ENV["PATH"])),
            })
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
