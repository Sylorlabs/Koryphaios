// Native driver for the desktop-electron-tauri Tauri scenario.
//
// The scorer requires observations it cannot make itself: a real packaged Tauri bundle, a
// native window that opens, closes and reopens, a genuine NSOpenPanel used twice (once
// cancelled, once accepted), a symlink retargeted underneath an already chosen folder, an
// unregistered command that must stay unreachable, and pixels captured through the window
// server rather than a DOM screenshot.
//
// Everything here is an observation of the running application. Where macOS Accessibility
// exposes the webview tree (it does: the fixture's buttons carry their labels) the driver
// clicks by name; where it does not, the check fails rather than being assumed.
//
// Build: swiftc -O scripts/tauri-native-driver.swift -o <path outside the fixture>
// Usage: tauri-native-driver --fixture=<dir> --scenario=<id> --receipt=<json>
//                             --capture=<png> --nonce=<uuid>

import CoreGraphics
import CryptoKit
import Foundation

let appProcessName = "kory-desktop-native-fixture"
let windowTitle = "Native Workspace Fixture"
let statusSelector = "AXStaticText"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

// MARK: - process helpers

@discardableResult
func run(_ binary: String, _ arguments: [String], timeout: TimeInterval = 60) -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: binary)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        return (-1, "spawn failed: \(error)")
    }
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline { usleep(20_000) }
    if process.isRunning {
        process.terminate()
        usleep(200_000)
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        return (-1, "timeout")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
}

/// Every UI interaction goes through System Events, because Accessibility consent is granted
/// to `osascript` on this platform and cannot be granted to a freshly built binary without a
/// human at the keyboard.
func osascript(_ script: String, timeout: TimeInterval = 90) -> (status: Int32, output: String) {
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("tauri-driver-\(UUID().uuidString).applescript")
    try? script.write(to: url, atomically: true, encoding: .utf8)
    defer { if ProcessInfo.processInfo.environment["KORY_TAURI_DRIVER_DEBUG"] == nil {
        try? FileManager.default.removeItem(at: url)
    } }
    let result = run("/usr/bin/osascript", [url.path], timeout: timeout)
    if ProcessInfo.processInfo.environment["KORY_TAURI_DRIVER_DEBUG"] != nil, result.status != 0 {
        FileHandle.standardError.write(Data(("script failed: " + result.output + "\n").utf8))
    }
    return result
}

func sha256Hex(_ url: URL) -> String? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

struct PngInfo { let width: Int; let height: Int; let bytes: Int }

func pngInfo(_ url: URL) -> PngInfo? {
    guard let data = try? Data(contentsOf: url), data.count > 33 else { return nil }
    let signature = [UInt8](data.prefix(8))
    guard signature == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] else { return nil }
    func be32(_ offset: Int) -> Int {
        data.subdata(in: offset..<(offset + 4)).reduce(0) { $0 << 8 | Int($1) }
    }
    return PngInfo(width: be32(16), height: be32(20), bytes: data.count)
}

// MARK: - accessibility helpers

/// Depth-first search for an element with a matching role and label. The fixture's webview
/// tree is only reachable this way: the window's direct children are the chrome buttons.
let searchPrelude = #"""
on findElement(theElement, targetName, targetRole, depth)
  if depth > 22 then return missing value
  tell application "System Events"
    try
      if role of theElement is targetRole then
        try
          if name of theElement is targetName then return theElement
        end try
      end if
    end try
    try
      repeat with kid in (UI elements of theElement)
        set found to my findElement(kid, targetName, targetRole, depth + 1)
        if found is not missing value then return found
      end repeat
    end try
  end tell
  return missing value
end findElement

on lastStaticText(theElement, depth)
  set collected to missing value
  if depth > 22 then return collected
  tell application "System Events"
    try
      if role of theElement is "AXStaticText" then
        try
          set collected to value of theElement
        end try
      end if
    end try
    try
      repeat with kid in (UI elements of theElement)
        set deeper to my lastStaticText(kid, depth + 1)
        if deeper is not missing value then set collected to deeper
      end repeat
    end try
  end tell
  return collected
end lastStaticText

"""#

func isAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0
}

func processAlive() -> Bool {
    let (status, output) = run("/bin/ps", ["-Ao", "pid=,comm="], timeout: 20)
    guard status == 0 else { return false }
    return output.split(separator: "\n").contains { $0.contains(appProcessName) }
}

func processId() -> Int32? {
    let (status, output) = run("/usr/bin/pgrep", ["-f", "MacOS/\(appProcessName)"], timeout: 20)
    guard status == 0, let first = output.split(separator: "\n").first, let pid = Int32(first) else { return nil }
    return pid
}

/// AppleScript must address the process by pid. `tell process "<name>"` resolves by name and
/// silently answers 0 windows when another instance or helper shares the name, which reads as
/// "the app never presented a window" while the window server shows a live 640x420 window.
var currentAppPid: Int32?

/// A keystroke must reach the application under test without taking focus from whoever is using
/// the machine. `System Events keystroke` goes to the frontmost application, so the driver used to
/// activate the fixture first, which stole the operator's focus mid-task and made every Escape,
/// Return and Cmd-Shift-G land in whatever they were working in when activation lost a race.
/// `CGEvent.postToPid` delivers the same events to one process and leaves focus alone.
func postKeys(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
    guard let pid = currentAppPid ?? processId() else { return }
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.postToPid(pid)
    usleep(20_000)
    let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.postToPid(pid)
    usleep(120_000)
}

/// Type text into the focused field of the target process without activating it.
func postText(_ text: String) {
    guard let pid = currentAppPid ?? processId() else { return }
    let units = Array(text.utf16)
    let source = CGEventSource(stateID: .hidSystemState)
    for direction in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: direction) else { continue }
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        event.postToPid(pid)
    }
    usleep(200_000)
}

/// Cancel through the sheet's own AX button first, so the observation does not depend on focus.
func pressDialogButton(_ titles: [String]) -> Bool {
    for title in titles {
        let hit = osascript(substitute("""
tell application "System Events"
  tell (first process whose unix id is PPID)
    try
      repeat with theSheet in sheets of window "WTITLE"
        try
          if exists button "BTN" of theSheet then
            click button "BTN" of theSheet
            return "clicked"
          end if
        end try
      end repeat
    end try
  end tell
end tell
""".replacingOccurrences(of: "BTN", with: title)), timeout: 15)
        if hit.output.contains("clicked") { return true }
    }
    return false
}

func substitute(_ script: String) -> String {
    var text = script.replacingOccurrences(of: "WTITLE", with: windowTitle)
    if let pid = currentAppPid ?? processId() {
        currentAppPid = pid
        text = text.replacingOccurrences(of: "PPID", with: String(pid))
    }
    return text
}

extension String {
    /// See `substitute`: name-based process addressing is ambiguous, pid addressing is not.
    var withAppContext: String { substitute(self) }
}

func windowVisible() -> Bool {
    let script = searchPrelude + #"""
tell application "System Events"
  tell (first process whose unix id is PPID)
    try
      repeat with candidate in windows
        if name of candidate is "WTITLE" then return "yes"
      end repeat
    end try
    return "no"
  end tell
end tell
"""#
    let result = osascript(substitute(script))
    return result.output.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("yes")
}

func waitForWindow(_ seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if windowVisible() { return true }
        usleep(400_000)
    }
    return false
}

func waitForStatus(_ seconds: Double) -> String? {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if let text = readStatus(), !text.isEmpty { return text }
        usleep(400_000)
    }
    return readStatus()
}

func readStatus() -> String? {
    // The status line is the last static text inside the webview's content group. Walking the
    // whole window instead returns the window's own title, which reads as a frozen value and
    // makes every status check look identical.
    let fast = #"""
tell application "System Events"
  tell (first process whose unix id is PPID)
    try
      set values to value of every static text of (last group of last group of UI element 1 of scroll area 1 of group 1 of group 1 of window "WTITLE")
      if (count of values) > 0 then return (item -1 of values) as text
    end try
    try
      set values to value of every static text of group 1 of group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of window "WTITLE"
      if (count of values) > 0 then return (item -1 of values) as text
    end try
    return "missing value"
  end tell
end tell
"""#.withAppContext
    let first = osascript(fast, timeout: 20).output.trimmingCharacters(in: .whitespacesAndNewlines)
    if !first.isEmpty && first != "missing value" { return first }
    let script = searchPrelude + #"""
tell application "System Events"
  tell (first process whose unix id is PPID)
    try
      return my lastStaticText(window "WTITLE", 0)
    end try
    return missing value
  end tell
end tell
"""#
    let result = osascript(substitute(script))
    let value = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty || value == "missing value" { return nil }
    return value
}

func clickButton(_ label: String) -> Bool {
    let script = searchPrelude + #"""
tell application "System Events"
  tell (first process whose unix id is PPID)
    set target to my findElement(window "WTITLE", "LABEL", "AXButton", 0)
    if target is missing value then return "missing"
    click target
    return "clicked"
  end tell
end tell
"""#
    let result = osascript(substitute(script).replacingOccurrences(of: "LABEL", with: label))
    return result.output.contains("clicked")
}

func dialogOpen() -> Bool {
    let script = #"""
tell application "System Events"
  tell (first process whose unix id is PPID)
    try
      repeat with win in windows
        repeat with theSheet in sheets of win
          return "sheet"
        end repeat
      end repeat
    end try
    try
      repeat with win in windows
        if description of win is "open" then return "window"
      end repeat
    end try
    return "none"
  end tell
end tell
"""#
    let result = osascript(substitute(script))
    return !result.output.contains("none")
}

func waitForDialog(_ seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if dialogOpen() { return true }
        usleep(300_000)
    }
    return false
}

func waitForDialogClose(_ seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if !dialogOpen() { return true }
        usleep(300_000)
    }
    return false
}

/// A native sheet only appears for an active application, so the dialog segment is the one place a
/// run has to borrow focus. It borrows the smallest possible amount: the operator's frontmost
/// application is captured before and restored immediately after, and no keystroke is ever sent to
/// whatever they were using, because keys are posted to the fixture's pid. `KORY_TAURI_DRIVER_NO_ACTIVATE`
/// forbids the borrow entirely; the dialog checks then report that they could not be observed.
var focusBorrows: [[String: String]] = []
let activationAllowed = ProcessInfo.processInfo.environment["KORY_TAURI_DRIVER_NO_ACTIVATE"] == nil

func activateFixture() -> Bool {
    let hit = osascript(substitute("""
tell application "System Events"
  try
    set frontmost of (first process whose unix id is PPID) to true
    return "activated"
  end try
  return "refused"
"""), timeout: 10)
    usleep(400_000)
    return hit.output.contains("activated")
}

func restoreFrontmost(_ name: String) {
    guard !name.isEmpty else { return }
    _ = osascript("""
tell application "System Events"
  try
    set frontmost of (first process whose name is \"NAME\") to true
  end try
end tell
""".replacingOccurrences(of: "NAME", with: name), timeout: 10)
    usleep(300_000)
}

/// Run a dialog segment, borrowing focus only when the sheet cannot appear otherwise.
func withDialogFocus(_ body: () -> Void) {
    let before = frontmostApp()
    let needsBorrow = activationAllowed && !before.isEmpty && before != windowTitle && !isFixtureFrontmost()
    if needsBorrow { _ = activateFixture() }
    body()
    if needsBorrow {
        restoreFrontmost(before)
        focusBorrows.append(["borrowedFrom": before, "restoredTo": frontmostApp()])
    }
}

func isFixtureFrontmost() -> Bool {
    let hit = osascript(substitute("""
tell application "System Events"
  try
    return (frontmost of (first process whose unix id is PPID)) as text
  end try
  return "unknown"
end tell
"""), timeout: 10)
    return hit.output.contains("true")
}

/// The operator's frontmost application, recorded so a run can prove it did not take focus.
func frontmostApp() -> String {
    let result = osascript("""
tell application "System Events" to get name of first process whose frontmost is true
""", timeout: 10)
    return result.output.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - window server capture

func windowNumber(for pid: Int32) -> Int? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    // A native app also publishes thin layer-0 accessory windows (a menu bar strip is 1800x39), and
    // `screencapture -l` refuses those. Taking the first match therefore captured nothing at random
    // depending on list order. Only a window with both dimensions over 100 px is a content window,
    // and the largest such window is the app's main one.
    var best: (number: Int, area: Double)?
    for entry in list {
        guard let owner = entry[kCGWindowOwnerPID as String] as? Int, Int32(owner) == pid,
              let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
              let number = entry[kCGWindowNumber as String] as? Int,
              let bounds = entry[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double,
              width > 100, height > 100 else { continue }
        let area = width * height
        if best == nil || area > best!.area { best = (number, area) }
    }
    return best?.number
}

func capture(to path: String, pid: Int32) -> Bool {
    guard let number = windowNumber(for: pid) else { return false }
    let (status, _) = run("/usr/sbin/screencapture", ["-x", "-o", "-l\(number)", path], timeout: 60)
    return status == 0
}

// MARK: - packaged artifact

func packagedApp(in fixture: URL) -> URL? {
    let bundleRoot = fixture.appendingPathComponent("src-tauri/target/release/bundle/macos")
    guard let entries = try? FileManager.default.contentsOfDirectory(at: bundleRoot, includingPropertiesForKeys: nil) else {
        return nil
    }
    for bundle in entries where bundle.pathExtension == "app" {
        let macos = bundle.appendingPathComponent("Contents/MacOS")
        guard let executables = try? FileManager.default.contentsOfDirectory(at: macos, includingPropertiesForKeys: nil) else { continue }
        if let executable = executables.first(where: { !$0.hasDirectoryPath }) { return executable }
    }
    return nil
}

func isMachO(_ url: URL) -> Bool {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? handle.close() }
    let header = handle.readData(ofLength: 4)
    let magic = [UInt8](header).map { String(format: "%02x", $0) }.joined()
    return ["cffaedfe", "feedfacf", "cefaedfe", "feedface", "cafebabe", "bebafeca"].contains(magic)
}

func tauriVersion(in fixture: URL) -> String? {
    let lock = fixture.appendingPathComponent("src-tauri/Cargo.lock")
    guard let text = try? String(contentsOf: lock, encoding: .utf8) else { return nil }
    var inTauri = false
    for line in text.split(separator: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed == "name = \"tauri\"" { inTauri = true; continue }
        if inTauri, trimmed.hasPrefix("version = ") {
            return trimmed.replacingOccurrences(of: "version = \"", with: "").replacingOccurrences(of: "\"", with: "")
        }
        if inTauri, trimmed.hasPrefix("[[") { inTauri = false }
    }
    return nil
}

// MARK: - application control

/// Launch through LaunchServices so the bundle gets its own window server identity; exec'ing
/// `Contents/MacOS/<binary>` directly starts a process whose WKWebView never presents a window.
/// This bundle's own instances, not every process that shares the executable name.
/// A concurrent run of another checkout of the same fixture made `pgrep -f MacOS/<name>`
/// return that instance first, so the driver then waited on the wrong pid's window.
func instancePids(for binary: URL) -> [Int32] {
    let (status, output) = run("/usr/bin/pgrep", ["-f", binary.path], timeout: 20)
    guard status == 0 else { return [] }
    return output.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
}

func instanceBearing(name: String) -> [Int32] {
    let (status, output) = run("/usr/bin/pgrep", ["-f", "Contents/MacOS/" + name], timeout: 10)
    guard status == 0 || status == 1 else { return [] }
    return output.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
}

func launch(_ binary: URL) -> Int32? {
    // Spawn the executable directly instead of asking LaunchServices. `open -n -a` decides on its
    // own whether a bundle identifier is already running and silently activates the old instance,
    // so a launch could report success while the window belonged to an earlier, killed process.
    // A direct spawn gives this run its own pid and inherits KORY_FIXTURE_ROOT unchanged.
    let process = Process()
    process.executableURL = binary
    var environment = ProcessInfo.processInfo.environment
    environment["KORY_FIXTURE_ROOT"] = args.fixture.path
    if let virtualDisplay {
        // Placement travels with the launch: the window's first frame is already on the private
        // display, so it never appears on the operator's screen even for an instant.
        environment["KORY_FIXTURE_POSITION"] =
            "\(Int(virtualDisplay.placement.x)),\(Int(virtualDisplay.placement.y))"
    }
    process.environment = environment
    do {
        try process.run()
    } catch {
        errors.append("cannot spawn the packaged bundle: \(error)")
        return nil
    }
    let pid = process.processIdentifier
    let deadline = Date().addingTimeInterval(25)
    while Date() < deadline {
        if !isAlive(pid) { return nil }
        if windowNumber(for: pid) != nil { return pid }
        usleep(300_000)
    }
    return pid
}

func quitApp(_ pid: Int32) {
    kill(pid, SIGTERM)
    let deadline = Date().addingTimeInterval(10)
    while processAlive() && Date() < deadline { usleep(200_000) }
    if processAlive() { kill(pid, SIGKILL); usleep(300_000) }
}

// MARK: - main

struct Args {
    let fixture: URL
    let scenario: String
    let receipt: URL
    let capture: URL
    let nonce: String
}

func parse(_ argv: [String]) -> Args {
    var values: [String: String] = [:]
    for argument in argv.dropFirst() {
        guard argument.hasPrefix("--"), let equals = argument.firstIndex(of: "=") else { continue }
        values[String(argument[argument.index(argument.startIndex, offsetBy: 2)..<equals])] =
            String(argument[argument.index(after: equals)...])
    }
    guard let fixture = values["fixture"], let scenario = values["scenario"],
          let receipt = values["receipt"], let capture = values["capture"],
          let nonce = values["nonce"] else {
        fail("usage: --fixture=<dir> --scenario=<id> --receipt=<json> --capture=<png> --nonce=<uuid>")
    }
    return Args(fixture: URL(fileURLWithPath: fixture), scenario: scenario,
                receipt: URL(fileURLWithPath: receipt), capture: URL(fileURLWithPath: capture), nonce: nonce)
}

let args = parse(CommandLine.arguments)
var events: [String] = []
var errors: [String] = []
var checks: [(String, Bool, String)] = []

func record(_ id: String, _ passed: Bool, _ detail: String) {
    checks.append((id, passed, detail))
}

func event(_ name: String) {
    if events.last != name { events.append(name) }
}

guard let appBinary = packagedApp(in: args.fixture) else {
    fail("no packaged Tauri bundle inside the fixture; the scorer builds it before dispatch")
}
let packagedHash = sha256Hex(appBinary) ?? ""

// The fixture ships `selected-link` pointing at the contained workspace. A previous run may
// have retargeted it, and the driver must never depend on leftover state.
let selectedLinkPath = args.fixture.appendingPathComponent("safe-workspace/selected-link")
_ = try? FileManager.default.removeItem(at: selectedLinkPath)
try? FileManager.default.createSymbolicLink(
    at: selectedLinkPath, withDestinationURL: args.fixture.appendingPathComponent("safe-workspace/inside"))

// The previous run parks the chosen folder and swaps it for an escape link. Put the real
// directory back so a repeated run of the same fixture observes the same starting state.
let chosenAtStart = args.fixture.appendingPathComponent("safe-workspace/inside")
let parkedAtStart = args.fixture.appendingPathComponent("safe-workspace/inside-parked")
if FileManager.default.fileExists(atPath: parkedAtStart.path) {
    var isDirectory: ObjCBool = false
    _ = FileManager.default.fileExists(atPath: parkedAtStart.path, isDirectory: &isDirectory)
    if isDirectory.boolValue {
        _ = try? FileManager.default.removeItem(at: chosenAtStart)
        try? FileManager.default.moveItem(at: parkedAtStart, to: chosenAtStart)
    } else {
        // An interrupted earlier run left the parked path as the escape link. A driver cannot
        // guess the fixture's original content, so it refuses instead of inventing it.
        _ = try? FileManager.default.removeItem(at: parkedAtStart)
        errors.append("fixture link state was left inconsistent by a previous run; re-materialize it")
    }
}
/// A display with no physical output. The fixture window is placed here, so a native evaluation
/// never puts a window on the operator's screen, while the window server still composites it and
/// `screencapture -l` remains a real observation.
struct VirtualDisplay {
    let process: Process
    let frameOrigin: CGPoint
    let frameSize: CGSize
    let axOrigin: CGPoint

    var placement: CGPoint {
        CGPoint(x: axOrigin.x + 150, y: axOrigin.y + 150)
    }
}

func startVirtualDisplay() -> VirtualDisplay? {
    let environment = ProcessInfo.processInfo.environment
    let candidate = environment["KORY_TAURI_VIRTUAL_DISPLAY"]
        ?? URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent()
            .appendingPathComponent("kory-virtual-display").path
    guard FileManager.default.isExecutableFile(atPath: candidate) else { return nil }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: candidate)
    process.arguments = ["600"]
    let pipe = Pipe()
    process.standardOutput = pipe
    do {
        try process.run()
    } catch {
        errors.append("cannot start the virtual display: \(error)")
        return nil
    }
    // The helper prints one line once the display is registered: sizes, screen origin and the
    // accessibility origin the driver places windows at.
    var text = ""
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline, !text.contains("\n") {
        let chunk = pipe.fileHandleForReading.availableData
        if chunk.isEmpty { usleep(150_000); continue }
        text += String(decoding: chunk, as: UTF8.self)
    }
    guard let line = text.split(separator: "\n").first.map(String.init),
          let frame = value(after: "frame=", in: line),
          let ax = value(after: "ax=", in: line)
    else {
        errors.append("virtual display did not report its frame: \(text)")
        process.terminate()
        return nil
    }
    let sizes = frame.split(separator: "+")
    let width = Double(sizes.first?.split(separator: "x").first ?? "") ?? 0
    let height = Double(sizes.first?.split(separator: "x").last ?? "") ?? 0
    let originX = Double(sizes.count > 1 ? sizes[1] : "0") ?? 0
    let originY = Double(sizes.count > 2 ? sizes[2] : "0") ?? 0
    let axParts = ax.split(separator: ",")
    guard width > 200, height > 200, axParts.count == 2,
          let axX = Double(axParts[0]), let axY = Double(axParts[1])
    else {
        errors.append("virtual display reported an unusable frame: \(line)")
        process.terminate()
        return nil
    }
    return VirtualDisplay(process: process,
                          frameOrigin: CGPoint(x: originX, y: originY),
                          frameSize: CGSize(width: width, height: height),
                          axOrigin: CGPoint(x: axX, y: axY))
}

func value(after key: String, in line: String) -> String? {
    guard let range = line.range(of: key) else { return nil }
    let rest = line[range.upperBound...]
    return rest.split(separator: " ").first.map(String.init)
}

let version = tauriVersion(in: args.fixture) ?? "unknown"

record("tauri-packaged-runtime", version.hasPrefix("2.") && isMachO(appBinary),
       "\(appBinary.lastPathComponent) tauri \(version) mach-o=\(isMachO(appBinary))")

// A previous scoring pass of this same fixture may still be running; a second `open -n` instance
// then presents no window. Only processes whose executable is this bundle are terminated.
// Match on the executable name, not on this copy's path. LaunchServices refuses to start a second
// instance of a bundle identifier that is already running, and an earlier pass of the same fixture
// copied to another directory is exactly that. Leaving it alive made `open -n -a` return success
// while no window ever appeared for this run, which read as a candidate that renders nothing.
let executableName = appBinary.lastPathComponent
let existingPids = instanceBearing(name: executableName)
for pid in existingPids { kill(pid, SIGTERM) }
let reapDeadline = Date().addingTimeInterval(8)
while Date() < reapDeadline, !instanceBearing(name: executableName).isEmpty { usleep(200_000) }
for pid in instanceBearing(name: executableName) { kill(pid, SIGKILL) }
usleep(800_000)

let virtualDisplay = startVirtualDisplay()
if let virtualDisplay {
    event("display:virtual")
    _ = virtualDisplay
}
let frontmostBefore = frontmostApp()
guard let firstPid = launch(appBinary) else { fail("cannot launch the packaged bundle") }
guard waitForWindow(25) else {
    errors.append("native window never appeared")
    fail("native window never appeared for \(appProcessName)")
}
event("window:created")
// A window that Accessibility lists but the window server never puts on screen is a session that
// cannot present windows, not an app that failed to render. Scoring that as a candidate zero put a
// host state into the pass rate once already, so it is refused as unobservable instead.
if windowNumber(for: firstPid) == nil {
    errors.append("environment cannot present a native window")
    fail("environment cannot present a native window for \(appProcessName)")
}
usleep(600_000)

// Capture before touching anything, while the window shows its first paint. A window that exists
// but has not been composited yet is not a candidate fault, so a failed window-server grab is
// retried before it is reported: scoring a slow first paint as a missing renderer punished a
// correct app once already.
var captured = false
var captureWindow = windowNumber(for: firstPid)
for attempt in 0..<4 {
    captureWindow = windowNumber(for: firstPid)
    captured = capture(to: args.capture.path, pid: firstPid)
    if captured, let probe = pngInfo(args.capture), probe.width > 100 { break }
    if attempt < 3 { usleep(700_000) }
}
var shot: [String: Any] = [:]
if let info = pngInfo(args.capture) {
    shot = ["sha256": sha256Hex(args.capture) ?? "", "width": info.width, "height": info.height,
            "source": "native-window-compositor"]
}
event("renderer:capture")
record("native-renderer-and-capture", captured && (shot["width"] as? Int ?? 0) > 100,
       captured ? "window server PNG \(shot["width"] ?? 0)x\(shot["height"] ?? 0)" : "window server capture failed")

// Cancelled native folder dialog: the status must fall back to the canonical empty state.
// The first press can land before the webview has attached its listener, which looks identical to
// a button that does nothing. Press again before calling the dialog missing.
var cancelOpened = false
withDialogFocus {
    cancelOpened = clickButton("Choose folder") && waitForDialog(10)
    for _ in 0..<2 where !cancelOpened {
        _ = clickButton("Choose folder")
        cancelOpened = waitForDialog(10)
    }
}
event("dialog:opened")
// A sheet that ignores the first Escape leaves the driver talking to a dialog it believes is
// gone, so the cancellation is retried and confirmed rather than assumed.
var cancelled = pressDialogButton(["Cancel"]) && waitForDialogClose(8)
for _ in 0..<3 where !cancelled {
    postKeys(53) // Escape, delivered to the fixture only.
    cancelled = waitForDialogClose(8)
}
let cancelStatus = readStatus() ?? ""
event("dialog:cancelled")
record("native-folder-dialog-opened", cancelOpened,
       cancelOpened ? "NSOpenPanel sheet observed" : "no native folder dialog appeared")
record("native-dialog-cancel-is-none", cancelOpened && cancelled && cancelStatus == "No folder selected",
       "opened=\(cancelOpened) closed=\(cancelled) status after cancel: \(cancelStatus.isEmpty ? "<empty>" : cancelStatus)")

// Accepted dialog selecting the link the driver later retargets.
let selectedLink = args.fixture.appendingPathComponent("safe-workspace/selected-link")
var acceptOpened = false
withDialogFocus {
    acceptOpened = clickButton("Choose folder") && waitForDialog(10)
    for _ in 0..<2 where !acceptOpened {
        _ = clickButton("Choose folder")
        acceptOpened = waitForDialog(10)
    }
}
event("dialog:opened")
postKeys(5, flags: [.maskCommand, .maskShift]) // Cmd-Shift-G: "Go to the folder:"
usleep(900_000)
postText(selectedLink.path)
usleep(900_000)
postKeys(36) // Return
usleep(1_500_000)
postKeys(36)
let accepted = waitForDialogClose(12)
let acceptStatus = readStatus() ?? ""
event("dialog:accepted")
// NSOpenPanel resolves the chosen symlink, so the status may show either the link or the
// directory it points at. Both mean the same absolute folder was chosen.
record("native-folder-selection", acceptOpened && accepted && acceptStatus.contains("safe-workspace"),
       "opened=\(acceptOpened) closed=\(accepted) status after accept: \(acceptStatus.isEmpty ? "<empty>" : acceptStatus)")

// Allowed read through the chosen folder, which resolves inside the fixture root.
_ = clickButton("Read workspace")
usleep(1_200_000)
let allowedStatus = readStatus() ?? ""
record("allowed-command-inside-root", allowedStatus == "contained workspace fixture",
       "status after read: \(allowedStatus.isEmpty ? "<empty>" : allowedStatus)")

// TOCTOU: the already chosen folder is swapped for a link that points outside the fixture
// root. A reader that canonicalises at use time must refuse; one that trusts the path it was
// handed earlier reads the escaped file.
let outside = args.fixture.appendingPathComponent("outside-workspace")
let chosenFolder = args.fixture.appendingPathComponent("safe-workspace/inside")
let parked = args.fixture.appendingPathComponent("safe-workspace/inside-parked")
do {
    if FileManager.default.fileExists(atPath: parked.path) {
        try? FileManager.default.removeItem(at: parked)
    }
    try FileManager.default.moveItem(at: chosenFolder, to: parked)
    try FileManager.default.createSymbolicLink(at: chosenFolder, withDestinationURL: outside)
    event("fs:symlink-retargeted")
} catch {
    errors.append("cannot swap the chosen folder: \(error)")
}
_ = clickButton("Read workspace")
usleep(1_200_000)
let swappedStatus = readStatus() ?? ""
// A refusal only means anything when the same reader accepted the real folder a moment earlier.
// Without that precondition the swap proves nothing: a build that never selects a folder refuses
// every read for the wrong reason and would otherwise collect this check for free.
let swapArmed = allowedStatus == "contained workspace fixture"
record("symlink-swap-at-use-denied",
       swapArmed && !swappedStatus.contains("ESCAPED WORKSPACE") && swappedStatus != "contained workspace fixture",
       "status after symlink swap: \(swappedStatus.isEmpty ? "<empty>" : swappedStatus) (selection established: \(swapArmed))")

// The swap is undone before the next check. Leaving the chosen folder pointing outside the fixture
// made every later observation read the escaped path instead of the state its own check is about.
do {
    if FileManager.default.fileExists(atPath: chosenFolder.path) || (try? FileManager.default.destinationOfSymbolicLink(atPath: chosenFolder.path)) != nil {
        try? FileManager.default.removeItem(at: chosenFolder)
    }
    if FileManager.default.fileExists(atPath: parked.path) {
        try FileManager.default.moveItem(at: parked, to: chosenFolder)
    }
    event("fs:symlink-restored")
} catch {
    errors.append("cannot restore the chosen folder: \(error)")
}

// Unregistered command must stay unreachable.
let probed = clickButton("Probe capability")
usleep(1_200_000)
let probeStatus = readStatus() ?? ""
record("unexposed-command-denied", probed && probeStatus.lowercased().hasPrefix("denied"),
       "status after probe: \(probeStatus.isEmpty ? "<empty>" : probeStatus)")

// Closing the last window must not terminate the application. LaunchServices activation is not
// drivable from outside in a way that is reliable enough to assert on, so the observation stops
// at the property that is: the process is still there after its window is gone.
let beforeClosePid = processId()
_ = osascript(#"""
tell application "System Events"
  tell (first process whose unix id is PPID)
    try
      click button 1 of window "WTITLE"
    end try
  end tell
end tell
"""#.withAppContext)
usleep(1_500_000)
usleep(2_000_000)
event("window:closed")
let afterClosePid = processId()
record("native-window-lifecycle",
       beforeClosePid != nil && afterClosePid != nil && beforeClosePid == afterClosePid,
       "pid \(beforeClosePid ?? -1) before close, \(afterClosePid ?? -1) two seconds after close")

// Quit and relaunch: the canonical state must come back, not the previous selection. When the
// previous step already terminated the application, that close was the quit and is recorded as
// one instead of leaving the event sequence looking impossible.
if let pid = processId() {
    quitApp(pid)
    event("app:quit")
} else if !events.contains("app:quit") {
    event("app:quit")
}
usleep(500_000)
guard let restartPid = launch(appBinary) else { fail("cannot relaunch the packaged bundle") }
// Every AppleScript below is addressed by pid, so the cached pid has to follow the relaunch.
// Reading the restarted application through the previous pid answered "<empty>" for a state that
// was in fact restored.
currentAppPid = restartPid
event("app:restarted")
let restartWindow = waitForWindow(25)
// A freshly launched webview attaches its status element after the window exists. Reading once
// recorded "<empty>" for an application that had already written its canonical state.
let restartStatus = waitForStatus(8) ?? ""
record("restart-restores-canonical-state", restartWindow && restartStatus == "No folder selected",
       "status after restart: \(restartStatus.isEmpty ? "<empty>" : restartStatus)")

quitApp(restartPid)
event("app:quit")

let expected = ["tauri-packaged-runtime", "native-window-lifecycle", "native-renderer-and-capture",
                "native-folder-dialog-opened", "native-dialog-cancel-is-none", "native-folder-selection",
                "allowed-command-inside-root", "symlink-swap-at-use-denied", "unexposed-command-denied",
                "restart-restores-canonical-state"]
if checks.map({ $0.0 }).sorted() != expected.sorted() { errors.append("driver produced an unexpected check inventory") }

virtualDisplay?.process.terminate()

var receipt: [String: Any] = [
    "nonce": args.nonce,
    "scenarioId": args.scenario,
    "runtime": "tauri",
    "nativeVersion": version,
    "pid": Int(firstPid),
    "checks": checks.map { ["id": $0.0, "passed": $0.1, "detail": $0.2] },
    "screenshot": shot,
    "captureWindow": captureWindow ?? -1,
    // Proof that the run did not steal focus: a native evaluation must work while the operator
    // keeps using the machine.
    "frontmostBefore": frontmostBefore,
    "frontmostAfter": frontmostApp(),
    "focusBorrows": focusBorrows,
    "nativeEvents": events,
    "errors": errors,
    "packagedArtifact": appBinary.path,
    "packagedSha256": packagedHash,
]
if let os = ProcessInfo.processInfo.operatingSystemVersionString.split(separator: " ").dropFirst().first {
    receipt["platformVersion"] = String(os)
}
let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
try data.write(to: args.receipt)
if ProcessInfo.processInfo.environment["KORY_TAURI_DRIVER_DEBUG"] != nil {
    try? data.write(to: URL(fileURLWithPath: "/tmp/last-tauri-receipt.json"))
}
exit(0)
