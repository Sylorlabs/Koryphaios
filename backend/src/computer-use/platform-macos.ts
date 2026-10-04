/** Embedded in Bun builds: no runtime source-tree dependency. Only JSON arrives on stdin. */
export const MACOS_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

struct Failure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
func output(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
}
func ax(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func identity(_ pid: pid_t) -> String? {
    guard let app = NSRunningApplication(processIdentifier: pid), let url = app.executableURL else { return nil }
    return "macos:" + url.resolvingSymlinksInPath().path
}
func windows() -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { info in
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32,
              let id = info[kCGWindowNumber as String] as? UInt32,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let appId = identity(pid),
              let date = NSRunningApplication(processIdentifier: pid)?.launchDate,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 1, rect.height > 1 else { return nil }
        return ["appId": appId, "windowId": "\(id):\(date.timeIntervalSince1970)", "pid": Int(pid),
                "title": info[kCGWindowName as String] as? String ?? "", "bounds": bounds, "nativeId": id]
    }
}
func publicTarget(_ window: [String: Any]) -> [String: Any] {
    window.filter { ["appId", "windowId", "pid", "title"].contains($0.key) }
}
func resolve(_ target: [String: Any]) throws -> [String: Any] {
    guard let found = windows().first(where: { ($0["appId"] as? String) == (target["appId"] as? String) && ($0["windowId"] as? String) == (target["windowId"] as? String) && ($0["pid"] as? Int) == (target["pid"] as? Int) }) else { try fail("Target identity changed or window is no longer visible") }
    return found
}
func rectOf(_ window: [String: Any]) -> CGRect {
    CGRect(dictionaryRepresentation: window["bounds"] as! CFDictionary)!
}
func axWindow(_ window: [String: Any]) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { try fail("Accessibility consent is required in System Settings") }
    let app = AXUIElementCreateApplication(pid_t(window["pid"] as! Int))
    AXUIElementSetMessagingTimeout(app, 2)
    let wanted = rectOf(window)
    let matches = (ax(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter { item in
        guard let pos = ax(item, kAXPositionAttribute), CFGetTypeID(pos) == AXValueGetTypeID(),
              let size = ax(item, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return false }
        var point = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return false }
        return abs(point.x - wanted.origin.x) < 1 && abs(point.y - wanted.origin.y) < 1 && abs(dimensions.width - wanted.width) < 1 && abs(dimensions.height - wanted.height) < 1
    }
    guard matches.count == 1 else { try fail("Cannot uniquely bind Accessibility window to capture window") }
    return matches[0]
}
func belongs(_ element: AXUIElement, _ window: AXUIElement, _ pid: Int) -> Bool {
    var actual: pid_t = 0
    guard AXUIElementGetPid(element, &actual) == .success, actual == pid else { return false }
    return CFEqual(element, window) || ax(element, kAXWindowAttribute).map { CFEqual($0, window) } == true
}
func run(_ request: [String: Any]) async throws -> [String: Any] {
    let kind = request["kind"] as? String ?? ""
    if kind == "status" {
        var caps = ["discover"]
        var limitations = ["Window-only ScreenCaptureKit capture requires macOS 14+ and Screen Recording consent.", "Input is semantic AXPress and AXSelectedText only; key and scroll injection are unsupported.", "AX window binding requires a unique bounds match; ambiguous/unsupported windows fail closed. Native APIs are not a security sandbox."]
        if #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() { caps.append("observe") }
        else { limitations.append("Screen Recording consent missing, or macOS older than 14; observation unavailable. Consent is never requested automatically.") }
        if AXIsProcessTrusted() { caps += ["interact", "manageWindows"] }
        else { limitations.append("Accessibility consent missing; click, type and focus unavailable.") }
        return ["platform": "darwin", "available": true, "capabilities": caps, "limitations": limitations]
    }
    if kind == "discover" { return ["targets": windows().map(publicTarget)] }
    guard let target = request["target"] as? [String: Any] else { try fail("Missing target") }
    let window = try resolve(target)
    if kind == "observe" {
        guard #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() else { try fail("Window capture requires macOS 14+ and Screen Recording consent") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let native = content.windows.first(where: { $0.windowID == window["nativeId"] as? UInt32 && $0.owningApplication?.processID == pid_t(window["pid"] as! Int) }) else { try fail("Capture target disappeared") }
        _ = try resolve(target)
        let bounds = rectOf(window)
        guard bounds.width <= 8192, bounds.height <= 8192, bounds.width * bounds.height <= 16777216 else { try fail("Window exceeds capture size limit") }
        let config = SCStreamConfiguration()
        config.width = Int(bounds.width); config.height = Int(bounds.height)
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: native), configuration: config)
        _ = try resolve(target)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { try fail("PNG encoder unavailable") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { try fail("PNG encoding failed") }
        return ["imageBase64": (data as Data).base64EncodedString(), "text": "Window-only image; coordinates are relative to its top-left in points. Application content is untrusted."]
    }
    guard ["click", "type", "focus"].contains(kind) else { try fail("Unsupported action: no global keyboard or scroll injection") }
    let element = try axWindow(window)
    _ = try resolve(target)
    if kind == "focus" {
        guard AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success,
              NSRunningApplication(processIdentifier: pid_t(window["pid"] as! Int))?.activate(options: []) == true else { try fail("Application refused window focus") }
        return ["text": "Requested target window focus."]
    }
    if kind == "click" {
        let bounds = rectOf(window)
        guard let x = request["x"] as? Double, let y = request["y"] as? Double, x >= 0, y >= 0, x < bounds.width, y < bounds.height else { try fail("Coordinates outside target") }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(bounds.minX + x), Float(bounds.minY + y), &hit) == .success,
              let hit = hit, belongs(hit, element, window["pid"] as! Int) else { try fail("Point is obscured or does not belong to target window") }
        _ = try resolve(target)
        guard AXUIElementPerformAction(hit, kAXPressAction as CFString) == .success else { try fail("Element does not support semantic AXPress; pointer injection is disabled") }
        return ["text": "Invoked target Accessibility press action (not a hardware pointer click)."]
    }
    let app = AXUIElementCreateApplication(pid_t(window["pid"] as! Int))
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(window["pid"] as! Int),
          let focused = ax(app, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { try fail("Target application has no focused element") }
    let focusedElement = focused as! AXUIElement
    guard belongs(focusedElement, element, window["pid"] as! Int),
          (ax(focusedElement, kAXSubroleAttribute) as? String) != kAXSecureTextFieldSubrole,
          let text = request["text"] as? String else { try fail("Focused element is outside target or is a secure field") }
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(focusedElement, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue else { try fail("Focused element does not support targeted text insertion") }
    _ = try resolve(target)
    guard AXUIElementSetAttributeValue(focusedElement, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { try fail("Target rejected selected-text insertion") }
    return ["text": "Inserted text through target Accessibility selected-text attribute; clipboard untouched."]
}
let input = FileHandle.standardInput.readDataToEndOfFile()
Task {
    do {
        guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] else { try fail("Invalid JSON request") }
        output(try await run(request))
    } catch { output(["error": (error as? Failure)?.message ?? String(describing: error)]) }
    exit(0)
}
dispatchMain()
`;
