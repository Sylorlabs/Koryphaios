import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Compiled from evaluator-owned source, out of reach of the candidate workspace.
// Every row comes from WindowServer or the system Accessibility API.
struct Geometry: Codable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}
struct Element: Codable {
    var identifier: String
    var role: String
    var title: String
    var value: String
    var geometry: Geometry?
}
struct Observation: Codable {
    var pid: Int32
    var windowNumber: Int
    var window: Geometry?
    var accessibilityTrusted: Bool
    var accessibilityWindowFound: Bool
    var elements: [Element]
    var errors: [String]
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}
func stringAttribute(_ element: AXUIElement, _ key: String) -> String {
    attribute(element, key) as? String ?? ""
}
func geometry(_ element: AXUIElement) -> Geometry? {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(),
          CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return Geometry(x: origin.x, y: origin.y, width: dimensions.width, height: dimensions.height)
}
func inspect(_ element: AXUIElement, depth: Int, visited: inout Int, collected: inout [Element]) {
    guard depth <= 22, visited < 900 else { return }
    visited += 1
    let id = stringAttribute(element, kAXIdentifierAttribute)
    let role = stringAttribute(element, kAXRoleAttribute)
    let name = stringAttribute(element, kAXTitleAttribute)
    let value = stringAttribute(element, kAXValueAttribute)
    if !id.isEmpty {
        collected.append(Element(identifier: id, role: role, title: name, value: value, geometry: geometry(element)))
    }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { inspect(child, depth: depth + 1, visited: &visited, collected: &collected) }
    }
}

let pid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? 0
let trusted = AXIsProcessTrusted()
let application = AXUIElementCreateApplication(pid)
let inspectorWindow: AXUIElement? = trusted && pid > 0
    ? (attribute(application, kAXWindowsAttribute) as? [AXUIElement])?.first(where: {
        stringAttribute($0, kAXTitleAttribute) == "Kory Native Document Inspector"
    })
    : nil
let axBounds = inspectorWindow.flatMap { geometry($0) }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
let ownedWindows = windows.filter { row in
    (row[kCGWindowOwnerPID as String] as? Int32) == pid
}
func matchesAXBounds(_ row: [String: Any]) -> Bool {
    guard let ax = axBounds,
          let bounds = row[kCGWindowBounds as String] as? [String: Any],
          let x = bounds["X"] as? NSNumber,
          let y = bounds["Y"] as? NSNumber,
          let width = bounds["Width"] as? NSNumber,
          let height = bounds["Height"] as? NSNumber else { return false }
    // WindowServer can redact kCGWindowName without Screen Recording access.
    // Bind a redacted name to the independently titled AX window by PID and
    // all four physical window coordinates. Ambiguity must fail closed.
    return abs(x.doubleValue - ax.x) <= 3 &&
        abs(y.doubleValue - ax.y) <= 3 &&
        abs(width.doubleValue - ax.width) <= 3 &&
        abs(height.doubleValue - ax.height) <= 3
}
let matches = ownedWindows.filter { row in
    guard (row[kCGWindowLayer as String] as? Int) == 0, inspectorWindow != nil,
          matchesAXBounds(row) else { return false }
    let title = row[kCGWindowName as String] as? String
    return title == nil || title == "Kory Native Document Inspector"
}
let candidate = matches.count == 1 ? matches[0] : nil
let bounds = (candidate?[kCGWindowBounds as String] as? [String: Any]) ?? [:]
let windowBounds: Geometry? = candidate == nil ? nil : Geometry(
    x: (bounds["X"] as? NSNumber)?.doubleValue ?? 0,
    y: (bounds["Y"] as? NSNumber)?.doubleValue ?? 0,
    width: (bounds["Width"] as? NSNumber)?.doubleValue ?? 0,
    height: (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
)
let consoleSession = CGSessionCopyCurrentDictionary() as? [String: Any]
let screenLocked = (consoleSession?["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
var result = Observation(
    pid: pid,
    windowNumber: candidate?[kCGWindowNumber as String] as? Int ?? -1,
    window: windowBounds,
    accessibilityTrusted: trusted,
    accessibilityWindowFound: false,
    elements: [],
    errors: []
)
if screenLocked {
    result.errors.append("Native macOS console session is locked; interactive WindowServer and Accessibility captures require an unlocked desktop")
}
if candidate == nil {
    // Restrict diagnostics to this fixture PID. Other users' desktop titles
    // and window properties never enter the qualification receipt. The full
    // WindowServer list distinguishes a hidden/off-screen fixture from one
    // absent from the compositor entirely; neither counts as a capture.
    let allWindows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    let allOwnedWindows = allWindows.filter { row in
        (row[kCGWindowOwnerPID as String] as? Int32) == pid
    }
    let allMatchingWindows = allOwnedWindows.filter { row in
        (row[kCGWindowLayer as String] as? Int) == 0 &&
        (row[kCGWindowName as String] as? String) == "Kory Native Document Inspector"
    }
    let observed = ownedWindows.prefix(8).map { row -> String in
        let number = row[kCGWindowNumber as String] as? Int ?? -1
        let layer = row[kCGWindowLayer as String] as? Int ?? -1
        let title = row[kCGWindowName as String] as? String ?? "<no title>"
        return "number=\(number),layer=\(layer),title=\(title)"
    }
    let allObserved = allOwnedWindows.prefix(8).map { row -> String in
        let number = row[kCGWindowNumber as String] as? Int ?? -1
        let layer = row[kCGWindowLayer as String] as? Int ?? -1
        let title = row[kCGWindowName as String] as? String ?? "<no title>"
        let alpha = row[kCGWindowAlpha as String] as? Double ?? -1
        let bounds = row[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return "number=\(number),layer=\(layer),title=\(title),alpha=\(alpha),bounds=\(bounds)"
    }
    result.errors.append(
        "WindowServer did not expose the native inspector window; " +
        "on-screen windows owned by PID: \(ownedWindows.count); " +
        "all windows owned by PID: \(allOwnedWindows.count); " +
        "matching windows outside on-screen list: \(allMatchingWindows.count); " +
        "AX/WindowServer geometry matches: \(matches.count); " +
        "on-screen candidates: [\(observed.joined(separator: "; "))]; " +
        "all owned windows: [\(allObserved.joined(separator: "; "))]"
    )
}
if !trusted { result.errors.append("Accessibility permission is unavailable") }
if trusted && pid > 0 {
    if let inspector = inspectorWindow {
        result.accessibilityWindowFound = true
        var visited = 0
        inspect(inspector, depth: 0, visited: &visited, collected: &result.elements)
    } else {
        result.errors.append("AXUIElement did not expose the native inspector window")
    }
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let json = try? encoder.encode(result), let text = String(data: json, encoding: .utf8) {
    print(text)
} else {
    fputs("Observer encoding failure\n", stderr)
    exit(2)
}
