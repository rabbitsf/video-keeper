// Helper self-update. The installer puts a stable copy in /Library (where the browsers' host
// manifests point); newer releases are installed per user, without a password, into
//   ~/Library/Application Support/VideoKeeper/helper/<release>/
// and the installed copy hands over to the newest one at launch.
//
// Updates come from the GitHub release named in tools/release.conf (helper-update.json + zip) and are
// accepted only if: the zip matches the manifest's SHA-256, every program in it is signed by our
// Developer ID team AND notarized by Apple, and the new helper and yt-dlp run. Anything else is
// discarded and the current version keeps working.

import Foundation
import Security

let helperCheckInterval: TimeInterval = 24 * 60 * 60
let installsDir = userDir.appendingPathComponent("helper")
let helperStamp = userDir.appendingPathComponent(".last-helper-check")
let verifiedMarker = ".verified"
// VIDEO_KEEPER_UPDATE_URL lets tests point at a local server; updates are verified the same way.
let updateManifestURL = URL(string: ProcessInfo.processInfo.environment["VIDEO_KEEPER_UPDATE_URL"]
    ?? "https://github.com/\(githubRepo)/releases/latest/download/helper-update.json")!

/// Numeric comparison of dotted versions ("1.10.0" > "1.9.2").
func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
    let x = a.split(separator: ".").map { Int($0) ?? 0 }
    let y = b.split(separator: ".").map { Int($0) ?? 0 }
    for i in 0..<max(x.count, y.count) {
        let l = i < x.count ? x[i] : 0
        let r = i < y.count ? y[i] : 0
        if l != r { return l < r ? .orderedAscending : .orderedDescending }
    }
    return .orderedSame
}

/// Signed by our Developer ID team (and, if requested, notarized by Apple).
func hasValidSignature(_ url: URL, requireNotarized: Bool) -> Bool {
    var text = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\""
    if requireNotarized { text += " and notarized" }
    var requirement: SecRequirement?
    var code: SecStaticCode?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement,
          SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return false }
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate)
    return SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess
}

func isMachO(_ url: URL) -> Bool {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? handle.close() }
    let magic = handle.readData(ofLength: 4)
    return [Data([0xcf, 0xfa, 0xed, 0xfe]), Data([0xce, 0xfa, 0xed, 0xfe]),
            Data([0xca, 0xfe, 0xba, 0xbe]), Data([0xbe, 0xba, 0xfe, 0xca])].contains(magic)
}

/// Newest fully verified update in the user's folder.
func newestInstalledUpdate() -> (version: String, dir: URL)? {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: installsDir.path) else { return nil }
    return names
        .filter { !$0.hasPrefix(".") && fm.fileExists(atPath: installsDir.appendingPathComponent("\($0)/\(verifiedMarker)").path) }
        .max { compareVersions($0, $1) == .orderedAscending }
        .map { ($0, installsDir.appendingPathComponent($0)) }
}

/// At launch: if a newer verified helper is installed for this user, become it (same arguments and
/// stdin/stdout, so the browser never notices). Returns only if this copy should keep running.
func handOverToNewestHelper() {
    guard let newest = newestInstalledUpdate(),
          compareVersions(newest.version, helperRelease) == .orderedDescending else { return }
    let exe = newest.dir.appendingPathComponent("video-keeper-helper")
    guard hasValidSignature(exe, requireNotarized: false) else { return } // Fully checked at install time.
    let args = [exe.path] + CommandLine.arguments.dropFirst()
    var cArgs = args.map { strdup($0) }
    cArgs.append(nil)
    execv(exe.path, cArgs) // Only returns on failure; then this copy simply carries on.
}

/// Start a background update check if one is due. It runs in its own session so it outlives the
/// browser closing this helper when the download finishes.
func startHelperUpdateCheckIfDue() {
    let last = (try? FileManager.default.attributesOfItem(atPath: helperStamp.path)[.modificationDate] as? Date) ?? .distantPast
    guard Date().timeIntervalSince(last) > helperCheckInterval else { return }
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    for fd: Int32 in [0, 1, 2] {
        posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0)
    }
    let me = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    var argv: [UnsafeMutablePointer<CChar>?] = [strdup(me), strdup("--update-helper"), nil]
    var pid: pid_t = 0
    posix_spawn(&pid, me, &actions, &attributes, &argv, environ)
    posix_spawn_file_actions_destroy(&actions)
    posix_spawnattr_destroy(&attributes)
}

private func run(_ tool: String, _ args: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = args
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return -1 }
    process.waitUntilExit()
    return process.terminationStatus
}

private func output(_ tool: URL, _ args: [String]) -> String? {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = tool
    process.arguments = args
    process.environment = toolEnvironment()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// `video-keeper-helper --update-helper`: check, download, verify and install a newer helper.
/// Returns 0 when up to date or updated, non-zero when an update was found but rejected.
func runHelperUpdate() -> Int32 {
    let fm = FileManager.default
    try? fm.createDirectory(at: installsDir, withIntermediateDirectories: true)
    let lockFD = open(userDir.appendingPathComponent(".update.lock").path, O_CREAT | O_RDWR, 0o600)
    guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { return 0 } // Another check is running.
    defer { close(lockFD) }
    try? Data().write(to: helperStamp)

    guard let manifestData = try? fetch(updateManifestURL, timeout: 30),
          let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
          let version = manifest["version"] as? String, let zipURL = (manifest["url"] as? String).flatMap(URL.init(string:)),
          let expectedHash = (manifest["sha256"] as? String)?.lowercased() else { return 0 }
    let current = [helperRelease, newestInstalledUpdate()?.version].compactMap { $0 }
        .max { compareVersions($0, $1) == .orderedAscending } ?? helperRelease
    guard compareVersions(version, current) == .orderedDescending else { return 0 }

    let staging = installsDir.appendingPathComponent(".staging-\(version)")
    let zipFile = installsDir.appendingPathComponent(".download-\(version).zip")
    defer {
        try? fm.removeItem(at: staging)
        try? fm.removeItem(at: zipFile)
    }
    guard let zip = try? fetch(zipURL, timeout: 900), sha256Hex(zip) == expectedHash,
          (try? zip.write(to: zipFile)) != nil else { return 1 }
    try? fm.removeItem(at: staging)
    try? fm.createDirectory(at: staging, withIntermediateDirectories: true)
    guard run("/usr/bin/ditto", ["-x", "-k", zipFile.path, staging.path]) == 0 else { return 1 }

    // Every program must be ours and notarized before anything in the update runs.
    let files = fm.enumerator(at: staging, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])?
        .compactMap { $0 as? URL }
        .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true } ?? []
    let programs = files.filter(isMachO)
    let helper = staging.appendingPathComponent("video-keeper-helper")
    guard programs.contains(where: { $0.standardizedFileURL.path == helper.standardizedFileURL.path }),
          programs.allSatisfy({ hasValidSignature($0, requireNotarized: true) }) else { return 2 }
    // Verified as Apple-notarized code from our team, so the browser's download quarantine can go.
    _ = run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staging.path])

    // The new helper must report the advertised version, and its Python must run yt-dlp.
    guard output(helper, ["--version"]) == version,
          output(staging.appendingPathComponent("python/bin/python3"),
                 [staging.appendingPathComponent("yt-dlp").path, "--version"]) != nil else { return 3 }

    try? fm.removeItem(at: installsDir.appendingPathComponent(version))
    guard (try? fm.moveItem(at: staging, to: installsDir.appendingPathComponent(version))) != nil else { return 1 }
    try? Data().write(to: installsDir.appendingPathComponent("\(version)/\(verifiedMarker)"))

    // Keep the newest two verified versions.
    if let names = try? fm.contentsOfDirectory(atPath: installsDir.path) {
        let versions = names.filter { !$0.hasPrefix(".") }.sorted { compareVersions($0, $1) == .orderedDescending }
        for old in versions.dropFirst(2) { try? fm.removeItem(at: installsDir.appendingPathComponent(old)) }
    }
    return 0
}
