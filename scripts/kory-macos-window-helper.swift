// Window and input helper for the native desktop evaluation driver.
//
// The driver runs inside the candidate sandbox, where Apple Events to System Events are refused
// with a privilege violation. Accessibility queries, the window server and directed keyboard and
// mouse delivery all remain available there, so this helper speaks them over a line delimited
// JSON protocol on stdin and stdout. Each request carries an `id` that is echoed back, and one
// response line is written per request.
//
// Verbs: windows, cgwindows, text, sheets, press, pressRole, focus, setValue, key, type,
// frontmost, activate, click.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func respond(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func elementAT(_ pid: pid_t, _ point: CGPoint) -> AXUIElement? {
    let application = AXUIElementCreateApplication(pid)
    var hit: AXUIElement?
    let result = AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit)
    return result == .success ? hit : nil
}

func attribute(_ element: AXUIElement, _ name: String) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func windowList(_ pid: pid_t) -> [[String: Any]] {
    let application = AXUIElementCreateApplication(pid)
    guard let raw = attribute(application, kAXWindowsAttribute as String) as? [AXUIElement] else { return [] }
    return raw.enumerated().map { index, window in
        var frame: [String: Any] = [:]
        if let position = attribute(window, kAXPositionAttribute as String) {
            var point = CGPoint.zero
            AXValueGetValue(position as! AXValue, .cgPoint, &point)
            frame["x"] = point.x
            frame["y"] = point.y
        }
        if let size = attribute(window, kAXSizeAttribute as String) {
            var dimensions = CGSize.zero
            AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
            frame["w"] = dimensions.width
            frame["h"] = dimensions.height
        }
        let title = attribute(window, kAXTitleAttribute as String) as? String ?? ""
        return ["index": index + 1, "title": title].merging(frame) { current, _ in current }
    }
}

func windowServerList(_ pid: pid_t) -> [[String: Any]] {
    // Geometry and names come from the window server, which still answers when the accessibility
    // server reports nothing for the process.
    let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var found: [[String: Any]] = []
    for window in list where (window[kCGWindowOwnerPID as String] as? Int) == Int(pid) {
        let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
        found.append([
            "id": window[kCGWindowNumber as String] as? Int ?? 0,
            "name": window[kCGWindowName as String] as? String ?? "",
            "layer": window[kCGWindowLayer as String] as? Int ?? 0,
            "x": bounds["X"] as? Double ?? 0,
            "y": bounds["Y"] as? Double ?? 0,
            "w": bounds["Width"] as? Double ?? 0,
            "h": bounds["Height"] as? Double ?? 0,
        ])
    }
    return found
}

func collectText(_ element: AXUIElement, depth: Int, into lines: inout [String]) {
    if depth > 12 { return }
    let role = attribute(element, kAXRoleAttribute as String) as? String ?? ""
    if let value = attribute(element, kAXValueAttribute as String) as? String, !value.isEmpty {
        lines.append(value)
    }
    if let title = attribute(element, kAXTitleAttribute as String) as? String, !title.isEmpty {
        lines.append(title)
    }
    if let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children { collectText(child, depth: depth + 1, into: &lines) }
    }
    if !role.isEmpty { _ = role }
}

func findButton(_ element: AXUIElement, label: String, depth: Int = 0) -> AXUIElement? {
    if depth > 12 { return nil }
    let role = attribute(element, kAXRoleAttribute as String) as? String ?? ""
    let title = attribute(element, kAXTitleAttribute as String) as? String ?? ""
    let description = attribute(element, kAXDescriptionAttribute as String) as? String ?? ""
    if role.contains("Button") && (title == label || description == label) { return element }
    if let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children {
            if let match = findButton(child, label: label, depth: depth + 1) { return match }
        }
    }
    return nil
}

func pressElement(_ element: AXUIElement) -> Bool {
    AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

let keyCodes: [String: CGKeyCode] = [
    "Return": 36, "Escape": 53, "Tab": 48, "Space": 49, "Delete": 51,
    "Up": 126, "Down": 125, "Left": 123, "Right": 124,
]

func postKey(_ pid: pid_t, code: CGKeyCode, flags: CGEventFlags, global: Bool) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    if global {
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    } else {
        down?.postToPid(pid)
        up?.postToPid(pid)
    }
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        respond(["error": "malformed request"])
        continue
    }
    let identifier = request["id"] as? String ?? ""
    let pid = pid_t(request["pid"] as? Int ?? 0)

    switch request["kind"] as? String ?? "" {
    case "windows":
        respond(["id": identifier, "windows": windowList(pid)])
    case "cgwindows":
        respond(["id": identifier, "windows": windowServerList(pid)])
    case "text":
        let application = AXUIElementCreateApplication(pid)
        var lines: [String] = []
        collectText(application, depth: 0, into: &lines)
        respond(["id": identifier, "text": lines.joined(separator: "\n")])
    case "sheets":
        let application = AXUIElementCreateApplication(pid)
        let sheets = attribute(application, "AXSheets") as? [AXUIElement] ?? []
        respond(["id": identifier, "sheets": sheets.count])
    case "press":
        let label = request["label"] as? String ?? ""
        let application = AXUIElementCreateApplication(pid)
        guard let button = findButton(application, label: label) else {
            respond(["id": identifier, "pressed": false])
            continue
        }
        respond(["id": identifier, "pressed": pressElement(button)])
    case "pressRole":
        let role = request["role"] as? String ?? ""
        let application = AXUIElementCreateApplication(pid)
        let found = findButton(application, label: role)
        respond(["id": identifier, "pressed": found.map(pressElement) ?? false])
    case "focus":
        let application = AXUIElementCreateApplication(pid)
        if let window = attribute(application, kAXFocusedWindowAttribute as String) {
            let raised = AXUIElementPerformAction(window as! AXUIElement, kAXRaiseAction as CFString) == .success
            respond(["id": identifier, "focused": raised])
        } else {
            respond(["id": identifier, "focused": false])
        }
    case "setValue":
        let value = request["value"] as? String ?? ""
        let application = AXUIElementCreateApplication(pid)
        if let focused = attribute(application, kAXFocusedUIElementAttribute as String) {
            let result = AXUIElementSetAttributeValue(focused as! AXUIElement, kAXValueAttribute as CFString, value as CFTypeRef)
            respond(["id": identifier, "set": result == .success])
        } else {
            respond(["id": identifier, "set": false])
        }
    case "key":
        var flags: CGEventFlags = []
        if request["command"] as? Bool == true { flags.insert(.maskCommand) }
        if request["shift"] as? Bool == true { flags.insert(.maskShift) }
        if request["option"] as? Bool == true { flags.insert(.maskAlternate) }
        if request["control"] as? Bool == true { flags.insert(.maskControl) }
        let name = request["name"] as? String ?? ""
        var code = keyCodes[name]
        if code == nil, let numeric = request["code"] as? Int { code = CGKeyCode(numeric) }
        if code == nil, name.count == 1, let character = name.lowercased().first,
           let ascii = character.asciiValue {
            code = CGKeyCode(ascii)   // US layout virtual code for a single letter
        }
        guard let keyCode = code else {
            respond(["id": identifier, "error": "unknown key"])
            continue
        }
        postKey(pid, code: keyCode, flags: flags, global: (request["global"] as? Bool) == true)
        respond(["id": identifier, "sent": true])
    case "type":
        let text = request["text"] as? String ?? ""
        for unit in text.utf16 {
            var character = unit
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
            up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
        }
        respond(["id": identifier, "typed": true])
    case "frontmost":
        let app = NSRunningApplication(processIdentifier: pid)
        respond(["id": identifier, "frontmost": app?.isActive ?? false])
    case "activate":
        let app = NSRunningApplication(processIdentifier: pid)
        let activated = app?.activate(options: [.activateAllWindows]) ?? false
        respond(["id": identifier, "activated": activated])
    case "click":
        let point = CGPoint(x: request["x"] as? Double ?? 0, y: request["y"] as? Double ?? 0)
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        respond(["id": identifier, "clicked": true])
    default:
        respond(["error": "unknown kind"])
    }
}
