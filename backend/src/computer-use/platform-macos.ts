/** Persistent native controller. Fixed source; requests and responses are JSON lines. */
export const MACOS_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import Darwin

struct Failure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
func output(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
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
    var result = list.compactMap { info -> [String: Any]? in
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != getpid(),
              let id = info[kCGWindowNumber as String] as? UInt32,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let appId = identity(pid), let date = NSRunningApplication(processIdentifier: pid)?.launchDate,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 1, rect.height > 1 else { return nil }
        return ["appId": appId, "windowId": "\(id):\(date.timeIntervalSince1970)", "pid": Int(pid),
                "title": info[kCGWindowName as String] as? String ?? "", "bounds": bounds, "nativeId": id, "scope": "window"]
    }
    // A window an agent keeps off screen is out of the person's way but still a real,
    // controllable window: publish it too, marked hidden, so the task can continue there.
    let all = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for info in all {
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != getpid(),
              let id = info[kCGWindowNumber as String] as? UInt32,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let onScreen = info[kCGWindowIsOnscreen as String] as? Bool, onScreen == false,
              let appId = identity(pid), let date = NSRunningApplication(processIdentifier: pid)?.launchDate,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 1, rect.height > 1,
              !result.contains(where: { $0["nativeId"] as? UInt32 == id }) else { continue }
        result.append(["appId": appId, "windowId": "\(id):\(date.timeIntervalSince1970)", "pid": Int(pid),
                       "title": info[kCGWindowName as String] as? String ?? "", "bounds": bounds,
                       "nativeId": id, "scope": "window", "hidden": true])
    }
    // Screen Recording is required for WindowServer enumeration and capture,
    // but Accessibility can still provide a trustworthy interaction target.
    // Keep this fallback window-scoped and reject duplicates by geometry later
    // during target resolution; it does not grant observation capability.
    if AXIsProcessTrusted() {
        for app in NSWorkspace.shared.runningApplications where app.processIdentifier != getpid() {
            guard let executable = app.executableURL, let launch = app.launchDate,
                  let appWindows = ax(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] else { continue }
            let appId = "macos:" + executable.resolvingSymlinksInPath().path
            for (index, item) in appWindows.prefix(128).enumerated() {
                guard (ax(item, kAXMinimizedAttribute) as? Bool) != true, let rect = elementRect(item), rect.width > 1, rect.height > 1 else { continue }
                let duplicate = result.contains { existing in
                    guard existing["appId"] as? String == appId, existing["pid"] as? Int == Int(app.processIdentifier), let existingBounds = existing["bounds"] as? [String: Any], let existingRect = CGRect(dictionaryRepresentation: existingBounds as CFDictionary) else { return false }
                    return abs(existingRect.minX - rect.minX) < 1 && abs(existingRect.minY - rect.minY) < 1 && abs(existingRect.width - rect.width) < 1 && abs(existingRect.height - rect.height) < 1
                }
                if duplicate { continue }
                let title = (ax(item, kAXTitleAttribute) as? String) ?? ""
                let geometry = "\(Int(rect.minX)):\(Int(rect.minY)):\(Int(rect.width)):\(Int(rect.height))"
                result.append(["appId": appId, "windowId": "ax:\(app.processIdentifier):\(launch.timeIntervalSince1970):\(index):\(geometry)", "pid": Int(app.processIdentifier), "title": title, "bounds": rect.dictionaryRepresentation as NSDictionary, "scope": "window"])
            }
        }
        // Directly launched AppKit fixtures and some unsigned development apps
        // can expose AX windows without appearing in NSWorkspace's regular
        // application list. Enumerate process owners through libproc and only
        // publish processes that expose a concrete Accessibility window.
        let processCount = proc_listallpids(nil, 0)
        if processCount > 0 {
            var pids = [pid_t](repeating: 0, count: Int(processCount))
            let bytes = Int32(pids.count * MemoryLayout<pid_t>.size)
            let returned = proc_listallpids(&pids, bytes)
            for pid in pids.prefix(Int(returned)) where pid > 0 && pid != getpid() {
                var pathBuffer = [CChar](repeating: 0, count: 4096)
                guard proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count)) > 0,
                      let path = String(bytes: pathBuffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, encoding: .utf8),
                      path.hasPrefix("/") else { continue }
                let app = AXUIElementCreateApplication(pid)
                guard let appWindows = ax(app, kAXWindowsAttribute) as? [AXUIElement] else { continue }
                let launch = NSRunningApplication(processIdentifier: pid)?.launchDate?.timeIntervalSince1970 ?? 0
                let appId = "macos:" + path
                for (index, item) in appWindows.prefix(128).enumerated() {
                    guard let rect = elementRect(item), rect.width > 1, rect.height > 1 else { continue }
                    let geometry = "\(Int(rect.minX)):\(Int(rect.minY)):\(Int(rect.width)):\(Int(rect.height))"
                    let id = "ax:\(pid):\(launch):\(index):\(geometry)"
                    if !result.contains(where: { ($0["windowId"] as? String) == id }) {
                        result.append(["appId": appId, "windowId": id, "pid": Int(pid), "title": (ax(item, kAXTitleAttribute) as? String) ?? "", "bounds": rect.dictionaryRepresentation as NSDictionary, "scope": "window"])
                    }
                }
            }
        }
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: 32); var count: UInt32 = 0
    if CGGetActiveDisplayList(32, &displays, &count) == .success {
        for id in displays.prefix(Int(count)) {
            let bounds = CGDisplayBounds(id)
            result.append(["appId": "desktop:macos:\(id)", "windowId": "display:\(id)", "pid": 1,
                "title": "Full desktop - display \(id)", "scope": "desktop", "nativeId": id,
                "bounds": bounds.dictionaryRepresentation as NSDictionary])
        }
    }
    return result
}
func publicTarget(_ window: [String: Any]) -> [String: Any] {
    window.filter { ["appId", "windowId", "pid", "title", "scope", "hidden"].contains($0.key) }
}
func resolve(_ target: [String: Any]) throws -> [String: Any] {
    guard let found = windows().first(where: { ($0["appId"] as? String) == (target["appId"] as? String) && ($0["windowId"] as? String) == (target["windowId"] as? String) && ($0["pid"] as? Int) == (target["pid"] as? Int) }) else { try fail("Target identity changed or window is no longer visible") }
    return found
}
func rectOf(_ window: [String: Any]) -> CGRect { CGRect(dictionaryRepresentation: window["bounds"] as! CFDictionary)! }
func desktop(_ window: [String: Any]) -> Bool { window["scope"] as? String == "desktop" }
func elementRect(_ element: AXUIElement) -> CGRect? {
    guard let pos = ax(element, kAXPositionAttribute), CFGetTypeID(pos) == AXValueGetTypeID(),
          let size = ax(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetValue(pos as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func axWindow(_ window: [String: Any]) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { try fail("Accessibility consent is required in System Settings") }
    let app = AXUIElementCreateApplication(pid_t(window["pid"] as! Int)); AXUIElementSetMessagingTimeout(app, 0.5)
    let wanted = rectOf(window)
    let appWindows = (ax(app, kAXWindowsAttribute) as? [AXUIElement] ?? [])
    if let windowId = window["windowId"] as? String, windowId.hasPrefix("ax:") {
        let parts = windowId.split(separator: ":")
        if parts.count >= 5, let index = Int(parts[3]), index >= 0, index < appWindows.count,
           let rect = elementRect(appWindows[index]), abs(rect.minX - wanted.minX) < 1 && abs(rect.minY - wanted.minY) < 1 && abs(rect.width - wanted.width) < 1 && abs(rect.height - wanted.height) < 1 {
            return appWindows[index]
        }
        try fail("Accessibility window identity changed or is ambiguous")
    }
    let matches = appWindows.filter {
        guard let rect = elementRect($0) else { return false }
        return abs(rect.minX - wanted.minX) < 1 && abs(rect.minY - wanted.minY) < 1 && abs(rect.width - wanted.width) < 1 && abs(rect.height - wanted.height) < 1
    }
    guard matches.count == 1 else { try fail("Cannot uniquely bind Accessibility window to capture window") }
    return matches[0]
}
func belongs(_ element: AXUIElement, _ window: AXUIElement, _ pid: Int) -> Bool {
    var actual: pid_t = 0
    guard AXUIElementGetPid(element, &actual) == .success, actual == pid else { return false }
    return CFEqual(element, window) || ax(element, kAXWindowAttribute).map { CFEqual($0, window) } == true
}
func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?; _ = AXUIElementCopyActionNames(element, &names); return names as? [String] ?? []
}
struct ElementRef { let element: AXUIElement; let app: String; let window: String; let pid: Int; let expires: Date }
var references = [String: ElementRef]()
var stopped = false
var active = false
var generation = 0
let eventTag: Int64 = 0x4b4f5259
var heldButton: CGMouseButton? = nil
// Events delivered to a process instead of the active session. The pointer and keys
// reach the authorized window without moving the user's cursor or taking their focus.
var directedPid: Int32? = nil
func deliver(_ event: CGEvent) {
    if let pid = directedPid { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
}
var lastPoint = CGPoint.zero
var pressedKeys = Set<CGKeyCode>()
var panel: NSPanel?
var ring: NSPanel?
var label: NSTextField?
var leaseTimer: Timer?
func releaseInput() {
    for key in pressedKeys { let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false); event?.setIntegerValueField(.eventSourceUserData, value: eventTag); event?.post(tap: .cghidEventTap) }
    pressedKeys.removeAll()
    if let button = heldButton {
        let type: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
        let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: lastPoint, mouseButton: button)
        event?.setIntegerValueField(.eventSourceUserData, value: eventTag); if let event = event { deliver(event) }
    }
    heldButton = nil
}
func endControl(_ revoke: Bool) {
    generation += 1; active = false; stopped = revoke; directedPid = nil; releaseInput(); restoreWindows(); panel?.orderOut(nil); ring?.orderOut(nil); leaseTimer?.invalidate()
    if revoke { references.removeAll(); output(["event": "stopped", "reason": "User stopped computer control or took over input"]) }
}
final class MarkView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlAccentColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
        let mark = "K" as NSString
        let style: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: bounds.height * 0.74), .foregroundColor: NSColor.white]
        let size = mark.size(withAttributes: style)
        mark.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: style)
    }
}
final class RecordingDot: NSView {
    override func draw(_ dirtyRect: NSRect) { NSColor.systemRed.setFill(); NSBezierPath(ovalIn: bounds).fill() }
}
final class RingView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlAccentColor.withAlphaComponent(0.9).setStroke()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1.5, dy: 1.5), xRadius: 7, yRadius: 7)
        path.lineWidth = 3; path.stroke()
    }
}
final class StopButton: NSObject { @objc func stop(_ sender: Any?) { endControl(true) } }
let stopper = StopButton()
// A ring around the window under control: the person can see which window Koryphaios
// drives, while the panel ignores the mouse so it never blocks the task or the person.
func appKitFrame(_ rect: CGRect) -> NSRect {
    let height = NSScreen.screens.first?.frame.height ?? rect.maxY
    return NSRect(x: rect.origin.x, y: height - rect.origin.y - rect.height, width: rect.width, height: rect.height)
}
// Nothing Koryphaios drives is allowed to put pixels on the display of the machine its owner is
// using. The ring and the badge exist for someone who asked to watch the work, so they appear only
// when that is requested explicitly; every other run is observed through the receipt it returns.
let showsOnScreenIndicator = ProcessInfo.processInfo.environment["KORY_COMPUTER_USE_INDICATOR"] == "1"
func showRing(_ window: [String: Any]) {
    if !showsOnScreenIndicator { return }
    if desktop(window) { ring?.orderOut(nil); return }
    if ring == nil {
        let overlay = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        overlay.isOpaque = false; overlay.backgroundColor = .clear; overlay.hasShadow = false
        overlay.ignoresMouseEvents = true; overlay.level = .floating
        overlay.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        overlay.isReleasedWhenClosed = false; overlay.contentView = RingView(frame: .zero)
        ring = overlay
    }
    ring?.setFrame(appKitFrame(rectOf(window)).insetBy(dx: -2, dy: -2), display: true)
    if showsOnScreenIndicator { ring?.orderFrontRegardless() }
}
func showControl(_ window: [String: Any]) {
    if !showsOnScreenIndicator { ring?.orderOut(nil); return }
    if panel == nil {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 56))
        let mark = MarkView(frame: NSRect(x: 12, y: 18, width: 20, height: 20))
        let recording = RecordingDot(frame: NSRect(x: 36, y: 24, width: 8, height: 8))
        let badge = NSTextField(labelWithString: "Controlled by Koryphaios")
        badge.frame = NSRect(x: 50, y: 9, width: 244, height: 38); badge.font = NSFont.systemFont(ofSize: 11); badge.lineBreakMode = .byTruncatingMiddle
        let stop = NSButton(title: "Cancel", target: stopper, action: #selector(StopButton.stop(_:)))
        stop.frame = NSRect(x: 300, y: 13, width: 70, height: 30); stop.bezelStyle = .rounded
        view.addSubview(mark); view.addSubview(recording); view.addSubview(badge); view.addSubview(stop)
        let p = NSPanel(contentRect: view.frame, styleMask: [.nonactivatingPanel, .titled], backing: .buffered, defer: false)
        p.title = "Koryphaios computer use"; p.contentView = view; p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; p.hidesOnDeactivate = false; p.isFloatingPanel = true
        p.isReleasedWhenClosed = false; panel = p; label = badge
    }
    label?.stringValue = "Controlled by Koryphaios\n" + (window["title"] as? String ?? window["appId"] as! String)
    if !active, let screen = NSScreen.main { panel?.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 392, y: screen.visibleFrame.maxY - 12)) }
    showRing(window)
    if showsOnScreenIndicator { panel?.orderFrontRegardless() }
    active = true
    leaseTimer?.invalidate(); leaseTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in endControl(false) }
}
func guardControl(_ window: [String: Any], _ epoch: Int, focused: Bool = false) throws {
    guard !stopped, generation == epoch else { try fail("Computer control stopped") }
    let fresh = try resolve(window)
    guard rectOf(fresh) == rectOf(window) else { try fail("Window moved or resized; observe again") }
    if focused && directedPid == nil && !desktop(window) {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(window["pid"] as! Int) else { try fail("User changed the frontmost application") }
        let app = AXUIElementCreateApplication(pid_t(window["pid"] as! Int))
        guard let focusedWindow = ax(app, kAXFocusedWindowAttribute), CFGetTypeID(focusedWindow) == AXUIElementGetTypeID(),
              CFEqual(focusedWindow, try axWindow(window)) else { try fail("Target window is not focused") }
    }
}
func lookup(_ id: String, _ window: [String: Any]) throws -> AXUIElement {
    guard let ref = references[id], ref.expires > Date(), ref.app == window["appId"] as? String,
          ref.window == window["windowId"] as? String, ref.pid == window["pid"] as? Int else { try fail("Element ID is stale or belongs to another target; list elements again") }
    guard ax(ref.element, kAXRoleAttribute) != nil else { try fail("Element ID is stale or belongs to another target; list elements again") }
    if !desktop(window) {
        let root = try axWindow(window)
        if !belongs(ref.element, root, ref.pid) { try fail("Element moved outside authorized window") }
    }
    var pid: pid_t = 0; AXUIElementGetPid(ref.element, &pid)
    guard pid != getpid() else { try fail("The control indicator cannot be automated") }
    return ref.element
}
func listElements(_ window: [String: Any]) async throws -> [[String: Any]] {
    references = references.filter { $0.value.expires > Date() && $0.value.window != window["windowId"] as? String }
    var queue = [AXUIElement]()
    if desktop(window) {
        for app in NSWorkspace.shared.runningApplications where app.processIdentifier != getpid() && app.activationPolicy == .regular {
            queue.append(AXUIElementCreateApplication(app.processIdentifier))
        }
    } else { queue.append(try axWindow(window)) }
    var result = [[String: Any]](); var index = 0; let deadline = Date().addingTimeInterval(3); let bounds = rectOf(window)
    while index < queue.count && index < 2048 && Date() < deadline {
        let item = queue[index]; index += 1; AXUIElementSetMessagingTimeout(item, 0.1)
        if index % 32 == 0 { await Task.yield(); if stopped { try fail("Computer control stopped") } }
        if ax(item, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
        if let rect = elementRect(item), rect.width > 0, rect.height > 0, bounds.intersects(rect) {
            let id = UUID().uuidString
            references[id] = ElementRef(element: item, app: window["appId"] as! String, window: window["windowId"] as! String, pid: window["pid"] as! Int, expires: Date().addingTimeInterval(30))
            var info: [String: Any] = ["elementId": id, "role": ax(item, kAXRoleAttribute) as? String ?? "unknown",
                "x": rect.minX - bounds.minX, "y": rect.minY - bounds.minY, "width": rect.width, "height": rect.height,
                "enabled": ax(item, kAXEnabledAttribute) as? Bool ?? true, "actions": actions(item)]
            if let name = ax(item, kAXTitleAttribute) as? String { info["name"] = String(name.prefix(512)) }
            if let desc = ax(item, kAXDescriptionAttribute) as? String { info["description"] = String(desc.prefix(512)) }
            if let value = ax(item, kAXValueAttribute) as? String { info["value"] = String(value.prefix(1024)) }
            result.append(info)
        }
        if queue.count < 4096 { queue.append(contentsOf: (ax(item, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(256)) }
    }
    return result
}
var movedWindows: [String: [String: Any]] = [:]
func setPosition(_ root: AXUIElement, _ point: CGPoint) throws {
    var value = point
    guard let axValue = AXValueCreate(.cgPoint, &value) else { try fail("Window position unavailable") }
    guard AXUIElementSetAttributeValue(root, kAXPositionAttribute as CFString, axValue) == .success else { try fail("Window refused to move") }
}
// An off screen window is out of the person's way and still fully controllable: input is
// directed to its process and capture reads its pixels without it being visible.
func offscreenPoint(_ rect: CGRect) -> CGPoint {
    // CoreGraphics, not AppKit: this runs off the main thread, where NSScreen is not allowed.
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return CGPoint(x: rect.maxX + 240, y: rect.minY) }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return CGPoint(x: rect.maxX + 240, y: rect.minY) }
    let right = displays.prefix(Int(count)).map { CGDisplayBounds($0).maxX }.max() ?? rect.maxX
    return CGPoint(x: right + 240, y: rect.minY)
}
func place(_ window: [String: Any], hidden: Bool) throws -> [String: Any] {
    guard !desktop(window) else { try fail("A display cannot be moved") }
    let root = try axWindow(window)
    let key = window["windowId"] as! String
    if hidden {
        if movedWindows[key] == nil { movedWindows[key] = window }
        try setPosition(root, offscreenPoint(rectOf(window)))
    } else {
        guard let original = movedWindows[key] else { try fail("This controller did not move that window") }
        movedWindows[key] = nil
        try setPosition(root, rectOf(original).origin)
    }
    return try resolve(window)
}
func restoreWindows() {
    for (_, original) in movedWindows {
        if let root = try? axWindow(original) { try? setPosition(root, rectOf(original).origin) }
    }
    movedWindows.removeAll()
}
func focus(_ window: [String: Any]) throws {
    if desktop(window) { return }
    let root = try axWindow(window)
    guard AXUIElementPerformAction(root, kAXRaiseAction as CFString) == .success,
          NSRunningApplication(processIdentifier: pid_t(window["pid"] as! Int))?.activate(options: []) == true else { try fail("Application refused focus") }
}
func point(_ request: [String: Any], _ window: [String: Any], _ element: AXUIElement?) throws -> CGPoint {
    let bounds = rectOf(window)
    let p: CGPoint
    if let element = element { guard let rect = elementRect(element) else { try fail("Element has no usable bounds") }; p = CGPoint(x: rect.midX, y: rect.midY) }
    else { guard let x = request["x"] as? Double, let y = request["y"] as? Double else { try fail("Missing coordinates") }; p = CGPoint(x: bounds.minX + x, y: bounds.minY + y) }
    guard bounds.contains(p) else { try fail("Point is outside authorized target") }
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let hit = hit {
        var pid: pid_t = 0; AXUIElementGetPid(hit, &pid)
        guard pid != getpid() else { try fail("The control indicator cannot be automated") }
        if !desktop(window) {
            let root = try axWindow(window)
            // A directed event is delivered to the target process, so a window on top of the
            // target does not receive it. Only session delivery depends on the global hit test.
            if directedPid == nil, !belongs(hit, root, window["pid"] as! Int) { try fail("Point is obscured by another window") }
        }
    } else if !desktop(window) { try fail("Cannot verify pointer target") }
    return p
}
func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { try fail("Pointer event unavailable") }
    event.setIntegerValueField(.eventSourceUserData, value: eventTag); event.setIntegerValueField(.mouseEventClickState, value: clicks)
    lastPoint = p; deliver(event)
}
func keyCode(_ value: String) -> CGKeyCode? {
    let keys: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
      "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"backspace":51,"escape":53,"esc":53,"delete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"left":123,"arrowleft":123,"right":124,"arrowright":124,"down":125,"arrowdown":125,"up":126,"arrowup":126,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111]
    return keys[value.lowercased()]
}
func sendKey(_ key: CGKeyCode, _ down: Bool, _ flags: CGEventFlags, text: [UniChar]? = nil) throws {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else { try fail("Key event unavailable") }
    event.flags = flags; event.setIntegerValueField(.eventSourceUserData, value: eventTag)
    if let text = text { text.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: $0.baseAddress) } }
    if down { pressedKeys.insert(key) } else { pressedKeys.remove(key) }; deliver(event)
}
// Someone else using the keyboard or pointer is interference, not a reason to stop: the
// person may work alongside the task. The agent is told, so it can re-observe before acting.
var lastActionAt = Date()
func hardwareInputSince(_ instant: Date) -> Bool {
    let elapsed = Date().timeIntervalSince(instant) - 0.05
    if elapsed <= 0 { return false }
    for type in [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel] {
        if CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type) < elapsed { return true }
    }
    return false
}
func run(_ request: [String: Any]) async throws -> [String: Any] {
    let kind = request["kind"] as? String ?? ""
    let touched = ["click", "doubleClick", "move", "drag", "type", "key", "scroll", "sequence"].contains(kind) && hardwareInputSince(lastActionAt)
    defer { lastActionAt = Date() }
    var result = try await perform(request)
    if touched {
        result["interference"] = ["kind": "user-input", "message": "The person used the keyboard or pointer during this task; re-observe before relying on the window."]
    }
    return result
}
func perform(_ request: [String: Any]) async throws -> [String: Any] {
    let kind = request["kind"] as? String ?? ""
    if kind == "stop" { endControl(false); references.removeAll(); return ["text": "Stopped"] }
    if kind == "status" {
        var caps = ["discover"]; var supported = ["discover", "wait"]; var limitations = ["Window and explicitly granted display control. Element IDs expire after 30 seconds. Native input is not an OS sandbox."]
        if #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() { caps.append("observe"); supported.append("observe") }
        else { limitations.append("Screen Recording consent required for screenshots.") }
        if AXIsProcessTrusted() { caps += ["interact", "manageWindows"]; supported += ["listElements", "click", "doubleClick", "move", "drag", "type", "key", "scroll", "focus", "sequence"] }
        else { limitations.append("Accessibility consent required for element discovery and input.") }
        return ["platform": "darwin", "available": true, "capabilities": caps, "actions": supported, "limitations": limitations]
    }
    if kind == "discover" { return ["targets": windows().map(publicTarget)] }
    guard !stopped else { try fail("User stopped this controller; re-enable computer use") }
    if kind == "wait" {
        let ms = request["ms"] as? Int ?? 0
        guard ms >= 0, ms <= 10000 else { try fail("Wait must be between 0 and 10000 ms") }
        try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
        return ["text": "Waited \(ms) ms."]
    }
    if kind == "sequence" {
        guard let steps = request["steps"] as? [[String: Any]], !steps.isEmpty, steps.count <= 64 else { try fail("A queue needs 1 to 64 steps") }
        guard !stopped else { try fail("User stopped this controller; re-enable computer use") }
        var reports = [[String: Any]](); var index = 0
        for step in steps {
            var next = step
            if let background = request["background"] as? Bool { next["background"] = background }
            do {
                let outcome = try await perform(next)
                reports.append(["index": index, "status": "done", "message": outcome["text"] as? String ?? ""])
            } catch {
                reports.append(["index": index, "status": "failed", "message": "Step failed"])
                return ["text": "Queue stopped at step \(index + 1) of \(steps.count).", "steps": reports]
            }
            index += 1
        }
        return ["text": "Ran \(steps.count) steps.", "steps": reports]
    }
    guard let target = request["target"] as? [String: Any] else { try fail("Missing target") }
    let window = try resolve(target)
    if kind == "listElements" { guard AXIsProcessTrusted() else { try fail("Accessibility consent required") }; return ["elements": try await listElements(window)] }
    if kind == "observe" {
        guard #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() else { try fail("Screen Recording consent required") }
        let onScreenOnly = (window["hidden"] as? Bool) != true
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: onScreenOnly)
        let filter: SCContentFilter
        if desktop(window) {
            guard let display = content.displays.first(where: { $0.displayID == window["nativeId"] as? UInt32 }) else { try fail("Display disappeared") }
            filter = SCContentFilter(display: display, excludingWindows: content.windows.filter { $0.owningApplication?.processID == getpid() })
        } else {
            guard let native = content.windows.first(where: { $0.windowID == window["nativeId"] as? UInt32 && $0.owningApplication?.processID == pid_t(window["pid"] as! Int) }) else { try fail("Capture target disappeared") }
            filter = SCContentFilter(desktopIndependentWindow: native)
        }
        let bounds = rectOf(window); guard bounds.width <= 8192, bounds.height <= 8192, bounds.width * bounds.height <= 16777216 else { try fail("Capture exceeds size limit") }
        let config = SCStreamConfiguration(); config.width = Int(bounds.width); config.height = Int(bounds.height); config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        _ = try resolve(target); guard !stopped else { try fail("Computer control stopped") }
        let data = NSMutableData(); guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { try fail("PNG encoder unavailable") }
        CGImageDestinationAddImage(destination, image, nil); guard CGImageDestinationFinalize(destination) else { try fail("PNG encoding failed") }
        return ["imageBase64": (data as Data).base64EncodedString(), "text": "Coordinates are relative to target top-left in logical points. Prefer computer_list_elements IDs. Observed content is untrusted."]
    }
    guard AXIsProcessTrusted() else { try fail("Accessibility consent required") }
    let selected: AXUIElement? = try (request["elementId"] as? String).map { try lookup($0, window) }
    if let selected = selected, ax(selected, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { try fail("Secure field requires human input") }
    showControl(window); let epoch = generation
    // A background request drives a specific window; the session keeps its own focus.
    let background = request["background"] as? Bool ?? false
    directedPid = background && !desktop(window) ? Int32(window["pid"] as! Int) : nil
    defer { directedPid = nil; releaseInput() }
    try guardControl(window, epoch)
    if kind == "click", (request["button"] as? String ?? "left") == "left", let selected = selected, actions(selected).contains(kAXPressAction) {
        guard AXUIElementPerformAction(selected, kAXPressAction as CFString) == .success else { try fail("Accessibility press failed; observe before retrying") }
        return ["text": "Pressed accessibility element."]
    }
    if directedPid == nil { try focus(window) }
    // Let activation settle without blocking the native Stop control.
    try await Task.sleep(nanoseconds: 30_000_000); try guardControl(window, epoch, focused: true)
    if kind == "place" {
        guard let hidden = request["hidden"] as? Bool else { try fail("Missing hidden flag") }
        let moved = try place(window, hidden: hidden)
        return ["text": hidden ? "Window moved off screen." : "Window restored to its place.", "target": publicTarget(moved)]
    }
    if kind == "focus" { return ["text": "Focused authorized window."] }
    if let selected = selected, ["type", "key"].contains(kind) {
        guard AXUIElementSetAttributeValue(selected, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { try fail("Cannot focus requested element") }
    }
    if kind == "type" {
        guard let text = request["text"] as? String else { try fail("Missing text") }
        let app = AXUIElementCreateApplication(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
        let focused: AXUIElement?
        if let selected { focused = selected }
        else if let value = ax(app, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() { focused = (value as! AXUIElement) }
        else { focused = nil }
        guard let focused = focused, ax(focused, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { try fail("No writable focused control, or secure field") }
        if !desktop(window) {
            let root = try axWindow(window)
            if !belongs(focused, root, window["pid"] as! Int) { try fail("Focused control outside target") }
        }
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(focused, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue {
            guard AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { try fail("Text insertion failed") }
        } else {
            for character in text {
                try guardControl(window, epoch, focused: true)
                let units = Array(String(character).utf16); try sendKey(0, true, [], text: units); try sendKey(0, false, [], text: units)
                await Task.yield()
            }
        }
        return ["text": "Inserted text; clipboard untouched."]
    }
    if kind == "key" {
        let parts = (request["key"] as? String ?? "").split(separator: "+").map { $0.lowercased() }
        guard let last = parts.last, let code = keyCode(last) else { try fail("Unsupported key") }
        var flags: CGEventFlags = []
        for part in parts.dropLast() { switch part { case "mod", "meta", "cmd", "command": flags.insert(.maskCommand); case "ctrl", "control": flags.insert(.maskControl); case "alt", "option": flags.insert(.maskAlternate); case "shift": flags.insert(.maskShift); default: try fail("Unknown modifier") } }
        try sendKey(code, true, flags); try sendKey(code, false, flags); return ["text": "Sent key chord."]
    }
    if kind == "scroll" {
        let p = try point(["x": rectOf(window).width / 2, "y": rectOf(window).height / 2], window, selected)
        try mouse(.mouseMoved, p, .left); try guardControl(window, epoch, focused: true)
        guard let delta = request["delta"] as? Int, abs(delta) <= 100,
              let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(-delta), wheel2: 0, wheel3: 0) else { try fail("Invalid scroll") }
        event.setIntegerValueField(.eventSourceUserData, value: eventTag); deliver(event); return ["text": "Scrolled target."]
    }
    if kind == "drag" {
        guard let path = request["path"] as? [[String: Any]], path.count >= 2, path.count <= 100 else { try fail("Invalid drag path") }
        var points = try path.map { try point($0, window, nil) }
        if let selected = selected { points[0] = try point([:], window, selected) }
        heldButton = .left; try mouse(.leftMouseDown, points[0], .left)
        for p in points.dropFirst() { try await Task.sleep(nanoseconds: 8_000_000); try guardControl(window, epoch, focused: true); try mouse(.leftMouseDragged, p, .left) }
        try mouse(.leftMouseUp, points.last!, .left); heldButton = nil; return ["text": "Dragged target along path."]
    }
    if ["click", "doubleClick", "move"].contains(kind) {
        let p = try point(request, window, selected)
        if kind == "move" { try mouse(.mouseMoved, p, .left); return ["text": "Moved pointer."] }
        let button: CGMouseButton = request["button"] as? String == "right" ? .right : request["button"] as? String == "middle" ? .center : .left
        for count in 1...(kind == "doubleClick" ? 2 : 1) {
            try guardControl(window, epoch, focused: true); heldButton = button
            try mouse(button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown, p, button, clicks: Int64(count))
            try mouse(button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp, p, button, clicks: Int64(count)); heldButton = nil
            await Task.yield()
        }
        return ["text": "Pointer click delivered; observe to verify outcome."]
    }
    try fail("Unsupported action")
}

let app = NSApplication.shared; app.setActivationPolicy(.accessory)
let inputMask: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .scrollWheel]
let monitor = NSEvent.addGlobalMonitorForEvents(matching: inputMask) { event in
    if active && event.cgEvent?.getIntegerValueField(.eventSourceUserData) != eventTag { endControl(true) }
}
var busy = false
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { output(["error": "Invalid request"]); continue }
        DispatchQueue.main.async {
            if request["kind"] as? String == "stop" { endControl(false); return }
            guard !busy else { output(["id": request["id"] ?? NSNull(), "error": "Controller busy"]); return }
            busy = true
            Task { @MainActor in
                defer { busy = false }
                do { var result = try await run(request); result["id"] = request["id"]; output(result) }
                catch { releaseInput(); output(["id": request["id"] ?? NSNull(), "error": (error as? Failure)?.message ?? String(describing: error)]) }
            }
        }
    }
    DispatchQueue.main.async { endControl(false); exit(0) }
}
app.run()
`;
