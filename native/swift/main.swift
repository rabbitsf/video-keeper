// Video Keeper companion helper: native messaging host that runs yt-dlp for the browser extension.
//
// Same protocol as native/host.py (the Homebrew/Python helper used by the family package):
//   extension -> helper: {"type":"ping"} | {"type":"download","url","quality"} | {"type":"cancel"}
//   helper -> extension: {"type":"pong",...} | {"type":"progress",...} | {"type":"done","path","filename","bytes"}
//                        | {"type":"error","error"} | {"type":"cancelled"}
// One process per job; closing the port (stdin EOF) cancels a running download.
//
// Unlike host.py it needs nothing preinstalled. The signed, notarized installer ships it with a
// standalone Python, QuickJS (JavaScript engine yt-dlp needs for YouTube), ffmpeg and a starting copy
// of yt-dlp's zipimport build. yt-dlp is pure Python run by that Python — data, not a program — so the
// helper can update it daily from yt-dlp's GitHub releases without Gatekeeper blocking it. It never
// downloads programs (Gatekeeper rejects unnotarized code when a browser-launched helper downloads it).

import CryptoKit
import Foundation

let helperVersion = 2 // Message protocol version.
let helperRelease = "1.2.1" // Installer version; tools/build-installer.sh reads it from this line.
let progressInterval: TimeInterval = 0.5

// Canonical mapping of the popup's quality choices to yt-dlp format arguments (keep in sync with
// QUALITY_ARGS in native/host.py). Prefer H.264 + AAC so the merged .mp4 plays in QuickTime.
let qualityArgs: [String: [String]] = [
    "best": ["-f", "bv*+ba/b", "-S", "res,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4"],
    "1080": ["-f", "bv*+ba/b", "-S", "res:1080,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4"],
    "720": ["-f", "bv*+ba/b", "-S", "res:720,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4"],
    "audio": ["-f", "ba[ext=m4a]/ba", "-x", "--audio-format", "m4a"],
]

// Respect $HOME like the Python helper (and so tests can use a scratch home).
let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory())
let downloadsDir = home.appendingPathComponent("Downloads")
// The runtime ships next to this executable in the installer (see tools/fetch-runtime.sh).
let toolDir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
let pythonURL = toolDir.appendingPathComponent("python/bin/python3")
let quickjsURL = toolDir.appendingPathComponent("qjs")
let ffmpegURL = toolDir.appendingPathComponent("ffmpeg")
let bundledYtdlpURL = toolDir.appendingPathComponent("yt-dlp")
// Updated copies live in the user's folder (the install folder is read-only).
let userDir = home.appendingPathComponent("Library/Application Support/VideoKeeper")
let userYtdlpURL = userDir.appendingPathComponent("yt-dlp")
let updateStamp = userDir.appendingPathComponent(".last-update-check")

// MARK: - Native messaging I/O

let writeLock = NSLock()

func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    var length = UInt32(data.count).littleEndian // Chrome/Firefox use native byte order (little-endian on Macs).
    writeLock.lock()
    defer { writeLock.unlock() }
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4) + data)
}

func readMessage() -> [String: Any]? {
    let header = FileHandle.standardInput.readData(ofLength: 4)
    guard header.count == 4 else { return nil }
    let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
    let body = FileHandle.standardInput.readData(ofLength: Int(length))
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

// MARK: - yt-dlp (run by the bundled Python; updated daily)

let ytdlpReleases = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
let updateInterval: TimeInterval = 24 * 60 * 60

/// The user's updated copy if there is one, else the starting copy from the installer.
func currentYtdlp() -> URL {
    FileManager.default.fileExists(atPath: userYtdlpURL.path) ? userYtdlpURL : bundledYtdlpURL
}

/// A fixed environment: the bundled tools only, no user site-packages, no .pyc writes.
func toolEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = [toolDir.path, "/usr/bin", "/bin"].joined(separator: ":")
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env
}

/// Run a yt-dlp copy with the bundled Python and capture its output (used for quick commands).
func runYtdlp(_ ytdlp: URL, _ args: [String]) -> (status: Int32, output: String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = pythonURL
    process.arguments = [ytdlp.path] + args
    process.environment = toolEnvironment()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return (-1, "") }
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
}

func ytdlpVersion() -> String {
    let result = runYtdlp(currentYtdlp(), ["--version"])
    return result.status == 0 ? result.output : ""
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func fetch(_ url: URL, timeout: TimeInterval) throws -> Data {
    var result: Result<Data, Error> = .failure(URLError(.timedOut))
    let done = DispatchSemaphore(value: 0)
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.setValue("VideoKeeperHelper/\(helperRelease)", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: request) { data, response, error in
        if let error {
            result = .failure(error)
        } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            result = .failure(URLError(.badServerResponse))
        } else {
            result = .success(data ?? Data())
        }
        done.signal()
    }.resume()
    done.wait()
    return try result.get()
}

/// At most once a day: if yt-dlp's latest release differs from our copy, download it, verify it
/// against the release's SHA2-256SUMS, test-run it, then switch to it. Any failure keeps the
/// current copy, so downloads never depend on GitHub being reachable.
func updateYtdlpIfStale(onUpdate: () -> Void) {
    let fm = FileManager.default
    let last = (try? fm.attributesOfItem(atPath: updateStamp.path)[.modificationDate] as? Date) ?? .distantPast
    guard Date().timeIntervalSince(last) > updateInterval else { return }
    try? fm.createDirectory(at: userDir, withIntermediateDirectories: true)
    try? Data().write(to: updateStamp)
    guard let sums = try? fetch(URL(string: ytdlpReleases + "SHA2-256SUMS")!, timeout: 20) else { return }
    var expected: String?
    for line in String(decoding: sums, as: UTF8.self).split(separator: "\n") {
        let parts = line.split(separator: " ", omittingEmptySubsequences: true)
        if parts.count == 2 && parts[1] == "yt-dlp" { expected = parts[0].lowercased() }
    }
    guard let expected else { return }
    if let current = try? Data(contentsOf: currentYtdlp()), sha256Hex(current) == expected { return }
    onUpdate()
    guard let data = try? fetch(URL(string: ytdlpReleases + "yt-dlp")!, timeout: 120), sha256Hex(data) == expected else { return }
    let temp = userYtdlpURL.appendingPathExtension("download")
    guard (try? data.write(to: temp, options: .atomic)) != nil else { return }
    guard runYtdlp(temp, ["--version"]).status == 0 else {
        try? fm.removeItem(at: temp)
        return
    }
    try? fm.removeItem(at: userYtdlpURL)
    try? fm.moveItem(at: temp, to: userYtdlpURL)
}

// MARK: - Download job

final class Job {
    let url: String
    let quality: String
    private var process: Process?
    private let lock = NSLock()
    private(set) var cancelled = false
    private var tempFiles = Set<String>()
    let finished = DispatchSemaphore(value: 0)

    init(url: String, quality: String) {
        self.url = url
        self.quality = qualityArgs[quality] == nil ? "best" : quality
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let running = process
        lock.unlock()
        if let running, running.isRunning { running.terminate() }
    }

    func start() {
        Thread.detachNewThread { [self] in
            run()
            finished.signal()
        }
    }

    private func run() {
        send(["type": "progress", "status": "starting"])
        guard FileManager.default.isExecutableFile(atPath: pythonURL.path),
              FileManager.default.fileExists(atPath: bundledYtdlpURL.path) else {
            send(["type": "error", "error": "Video Keeper Helper is incomplete — please reinstall it"])
            return
        }
        updateYtdlpIfStale { send(["type": "progress", "status": "starting", "message": "Updating yt-dlp…"]) }
        if cancelled { send(["type": "cancelled"]); return }

        var args = [currentYtdlp().path, "--no-playlist", "--newline", "--progress", "--quiet", "--no-simulate",
                    "--progress-template", "download:VDLP %(progress)j",
                    "--print", "before_dl:VDLT %(title)s",
                    "--print", "after_move:VDLF %(filepath)s"]
        args += qualityArgs[quality]!
        if FileManager.default.isExecutableFile(atPath: ffmpegURL.path) {
            args += ["--ffmpeg-location", toolDir.path]
        }
        if FileManager.default.isExecutableFile(atPath: quickjsURL.path) {
            args += ["--js-runtimes", "quickjs:\(quickjsURL.path)"]
        }
        args += ["-P", downloadsDir.path, "-o", "%(title).150B [%(id)s].%(ext)s", "--", url]

        let process = Process()
        let pipe = Pipe()
        process.executableURL = pythonURL
        process.arguments = args
        process.environment = toolEnvironment()
        process.standardOutput = pipe
        process.standardError = pipe
        lock.lock()
        self.process = process
        let cancelledEarly = cancelled
        lock.unlock()
        if cancelledEarly { send(["type": "cancelled"]); return }
        do { try process.run() } catch {
            send(["type": "error", "error": "Couldn't start yt-dlp: \(error.localizedDescription)"])
            return
        }

        var finalPath: String?
        var lastError: String?
        var passes = 0
        var lastSent = Date.distantPast
        var buffer = Data()
        let reader = pipe.fileHandleForReading
        while true {
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0a) {
                let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
                buffer.removeSubrange(buffer.startIndex...newline)
                if line.hasPrefix("VDLT ") {
                    send(["type": "progress", "status": "downloading", "title": String(line.dropFirst(5)), "percent": 0, "pass": passes + 1])
                } else if line.hasPrefix("VDLF ") {
                    finalPath = String(line.dropFirst(5))
                } else if line.hasPrefix("VDLP "),
                          let progress = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(5).utf8)) as? [String: Any] {
                    for key in ["tmpfilename", "filename"] { if let f = progress[key] as? String { tempFiles.insert(f) } }
                    if progress["status"] as? String == "finished" {
                        passes += 1
                        send(["type": "progress", "status": "processing"])
                    } else if Date().timeIntervalSince(lastSent) >= progressInterval {
                        lastSent = Date()
                        let done = (progress["downloaded_bytes"] as? Double) ?? 0
                        let total = (progress["total_bytes"] as? Double) ?? (progress["total_bytes_estimate"] as? Double)
                        var message: [String: Any] = ["type": "progress", "status": "downloading", "bytes": done, "pass": passes + 1]
                        message["percent"] = total.map { ($0 > 0 ? (1000 * done / $0).rounded() / 10 : 0) as Any } ?? NSNull()
                        message["speed"] = progress["speed"] ?? NSNull()
                        message["eta"] = progress["eta"] ?? NSNull()
                        send(message)
                    }
                } else if line.hasPrefix("ERROR:") {
                    lastError = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                }
            }
        }
        process.waitUntilExit()

        if cancelled {
            removeTempFiles(keeping: finalPath)
            send(["type": "cancelled"])
        } else if process.terminationStatus == 0, let finalPath {
            let size = (try? FileManager.default.attributesOfItem(atPath: finalPath)[.size] as? Int) ?? nil
            send(["type": "done", "path": finalPath, "filename": (finalPath as NSString).lastPathComponent, "bytes": size ?? NSNull()])
        } else {
            send(["type": "error", "error": lastError ?? "yt-dlp exited with code \(process.terminationStatus)"])
        }
    }

    /// Only files yt-dlp reported writing for this job (partial downloads and unmerged parts).
    private func removeTempFiles(keeping keep: String?) {
        for path in tempFiles {
            for candidate in [path, path + ".part", path + ".ytdl"] where candidate != keep {
                try? FileManager.default.removeItem(atPath: candidate)
            }
        }
    }
}

// MARK: - Main loop

// Modes used by the self-updater (browsers pass other arguments, which are ignored).
if CommandLine.arguments.contains("--version") {
    print(helperRelease)
    exit(0)
}
if CommandLine.arguments.contains("--update-helper") {
    exit(runHelperUpdate())
}
handOverToNewestHelper() // Becomes a newer verified per-user install, if there is one.
startHelperUpdateCheckIfDue()

var job: Job?
while let message = readMessage() {
    switch message["type"] as? String {
    case "ping":
        let installed = FileManager.default.fileExists(atPath: currentYtdlp().path)
        send([
            "type": "pong",
            "version": helperVersion,
            "release": helperRelease,
            "ytdlp": installed ? currentYtdlp().path : NSNull(),
            "quickjs": FileManager.default.isExecutableFile(atPath: quickjsURL.path),
            "ytdlpVersion": installed ? ytdlpVersion() : "",
            "ffmpeg": FileManager.default.isExecutableFile(atPath: ffmpegURL.path),
        ])
    case "download" where job == nil:
        let newJob = Job(url: message["url"] as? String ?? "", quality: message["quality"] as? String ?? "best")
        job = newJob
        newJob.start()
    case "cancel":
        job?.cancel()
    default:
        break
    }
}
// Port closed (extension disconnected or the browser quit): stop any running download.
if let job {
    job.cancel()
    _ = job.finished.wait(timeout: .now() + 10)
}
