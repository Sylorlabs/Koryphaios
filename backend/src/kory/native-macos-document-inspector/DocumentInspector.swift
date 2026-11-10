import AppKit
import Foundation

// A real AppKit application. The evaluator controls its states over stdin and
// observes the resulting window through WindowServer and the Accessibility API.
// The fault build is solely a negative control for live red/green qualification.
struct InspectorConfiguration: Decodable {
    var revision: Int
    var width: Int
    var height: Int
    var appearance: String
    var language: String
    var content: String
    var textSize: String
}

// NSScrollView starts an unflipped document at its bottom when content is
// taller than the viewport, hiding the heading in the overflow cases.
final class InspectorDocumentView: NSView {
    override var isFlipped: Bool { true }
}

final class InspectorApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let windowTitle = "Kory Native Document Inspector"
    private var sidebarWidthConstraint: NSLayoutConstraint?
    private var metadataLabelWidthConstraints: [NSLayoutConstraint] = []

    // A genuine AppKit resize must reflow the *existing* controls. A layout
    // rebuilt only when a test sends another state would conceal resize bugs.
    private func updateResponsiveWidths(_ windowWidth: CGFloat) {
        let compact = windowWidth < 760
        let wide = windowWidth >= 1150
        sidebarWidthConstraint?.constant = compact ? 190 : (wide ? 260 : 230)
        let labelWidth: CGFloat = compact ? 120 : (wide ? 205 : 170)
        for constraint in metadataLabelWidthConstraints { constraint.constant = labelWidth }
    }

    func windowDidResize(_ notification: Notification) {
        guard window != nil else { return }
        updateResponsiveWidths(window.frame.width)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 80, y: 100, width: 900, height: 700)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = windowTitle
        window.minSize = NSSize(width: 620, height: 520)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.delegate = self
        let initial = InspectorConfiguration(
            revision: 0, width: 900, height: 700, appearance: "light",
            language: "en", content: "normal", textSize: "standard"
        )
        apply(initial)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let config = try? JSONDecoder().decode(InspectorConfiguration.self, from: data)
                else {
                    fputs("INVALID_CONFIG\n", stderr)
                    fflush(stderr)
                    continue
                }
                DispatchQueue.main.async { self.apply(config) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func label(_ text: String, id: String, size: CGFloat, strong: Bool = false) -> NSTextField {
        let view = NSTextField(labelWithString: text)
        view.font = strong ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        view.lineBreakMode = .byWordWrapping
        view.maximumNumberOfLines = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultHigh, for: .vertical)
        view.setAccessibilityIdentifier(id)
        view.setAccessibilityLabel(text)
        return view
    }

    private func button(_ text: String, id: String, size: CGFloat) -> NSButton {
        let view = NSButton(title: text, target: nil, action: nil)
        view.bezelStyle = .rounded
        view.font = .systemFont(ofSize: size)
        view.setAccessibilityIdentifier(id)
        view.setAccessibilityLabel(text)
        return view
    }

    private func vertical(_ views: [NSView], spacing: CGFloat) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        return stack
    }

    private func localized(_ en: String, _ de: String, _ config: InspectorConfiguration) -> String {
        config.language == "de" ? de : en
    }

    private func apply(_ config: InspectorConfiguration) {
        let declaredSizes = [(620, 520), (900, 700), (1400, 900)]
        guard declaredSizes.contains(where: { $0.0 == config.width && $0.1 == config.height }),
              ["light", "dark"].contains(config.appearance),
              ["en", "de"].contains(config.language),
              ["normal", "empty", "max"].contains(config.content),
              ["standard", "large"].contains(config.textSize) else {
            fputs("UNSUPPORTED_STATE\n", stderr)
            fflush(stderr)
            return
        }

        let large = config.textSize == "large"
        let textSize: CGFloat = large ? 16 : 13
        let subtitleSize: CGFloat = large ? 14 : 11
        let headingSize: CGFloat = large ? 23 : 19
        window.appearance = NSAppearance(named: config.appearance == "dark" ? .darkAqua : .aqua)

        let sidebarWidth: CGFloat = config.width == 620 ? 190 : (config.width == 900 ? 230 : 260)
        metadataLabelWidthConstraints.removeAll()
        sidebarWidthConstraint = nil
        let root = NSView()
        // Assigning a zero-frame NSView as the content view collapses AppKit's
        // window to its title bar. Establish a real content frame before install.
        root.frame = NSRect(x: 0, y: 0, width: config.width, height: config.height - 32)
        root.autoresizingMask = [.width, .height]
        // AppKit also recalculates the window height from the content view's
        // fitted size during layout. Without this constraint only the toolbar
        // contributes height, shrinking a 700pt window to its 97pt title/toolbar.
        root.heightAnchor.constraint(greaterThanOrEqualToConstant: CGFloat(config.height - 32)).isActive = true

        let toolbar = NSVisualEffectView()
        toolbar.material = .headerView
        toolbar.blendingMode = .withinWindow
        toolbar.state = .active
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        let toolbarTitle = label(
            localized("Document Inspector", config.width == 620 ? "Dokumente" : "Dokumenteneigenschaften", config),
            id: "toolbar.title", size: headingSize, strong: true
        )
        let importButton = button(localized("Import", "Importieren", config), id: "toolbar.import", size: textSize)
        let shareButton = button(localized("Share", "Teilen", config), id: "toolbar.share", size: textSize)
        toolbar.addSubview(toolbarTitle)
        toolbar.addSubview(importButton)
        toolbar.addSubview(shareButton)
        for view in [toolbarTitle, importButton, shareButton] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        let toolbarConstraints = [
            toolbarTitle.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 18),
            toolbarTitle.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            importButton.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            shareButton.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
            shareButton.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -18),
            importButton.trailingAnchor.constraint(equalTo: shareButton.leadingAnchor, constant: -8),
            toolbarTitle.trailingAnchor.constraint(lessThanOrEqualTo: importButton.leadingAnchor, constant: -12)
        ]
        NSLayoutConstraint.activate(toolbarConstraints)

        let sidebar = NSVisualEffectView()
        sidebar.material = .sidebar
        sidebar.blendingMode = .withinWindow
        sidebar.state = .active
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        let sidebarHeading = label(
            localized("DOCUMENTS", "DOKUMENTE", config), id: "sidebar.heading", size: subtitleSize, strong: true
        )
        let docs = [
            localized("Annual report", "Jahresabschluss und Geschäftsbericht", config),
            localized("Roadmap", "Strategische Produktentwicklungsplanung", config),
            localized("Design brief", "Dokument mit ausführlicher Gestaltungsspezifikation", config)
        ]
        let documentButtons = docs.enumerated().map { index, title in
            button(title, id: "sidebar.document.\(index)", size: textSize)
        }
        for doc in documentButtons {
            doc.bezelStyle = .inline
            doc.alignment = .left
            doc.lineBreakMode = .byTruncatingTail
            doc.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        for (button, title) in zip(documentButtons, docs) {
            // Preserve the entire translated name when a compact sidebar
            // necessarily ellipsizes an individual document's visible title.
            button.toolTip = title
        }
        let sideStack = vertical([sidebarHeading] + documentButtons, spacing: large ? 12 : 9)
        sidebar.addSubview(sideStack)
        sideStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            sideStack.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 18),
            sideStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 14),
            sideStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -14)
        ])
        NSLayoutConstraint.activate(documentButtons.map {
            $0.widthAnchor.constraint(equalTo: sideStack.widthAnchor)
        })

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView()
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.drawsBackground = true
        scroll.backgroundColor = .windowBackgroundColor
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let heading = label(
            localized("Document details", "Dokumentdetails und Eigenschaften", config),
            id: "inspector.heading", size: headingSize, strong: true
        )
        let context = label(
            "\(config.language)-\(config.appearance) · \(config.content) · \(config.textSize)",
            id: "inspector.context", size: subtitleSize
        )
        context.textColor = .secondaryLabelColor
        let items: [(String, String, String)] = [
            ("name", localized("Name", "Vollständiger Dokumententitel", config), localized("Annual report 2026", "Jahresabschluss und Geschäftsbericht 2026", config)),
            ("owner", localized("Owner", "Verantwortliche Ansprechpartnerin", config), "Amelia Chen"),
            ("created", localized("Created", "Erstellungsdatum des Dokuments", config), "2026-04-18"),
            ("modified", localized("Last modified", "Letzter Bearbeitungszeitpunkt", config), "2026-10-07"),
            ("type", localized("Document type", "Dokumentklassifizierung und Dateityp", config), "PDF / PDF-A"),
            ("access", localized("Access level", "Veröffentlichungsberechtigungen", config), localized("Internal review", "Nur zur internen Qualitätssicherung", config)),
            ("location", localized("Storage location", "Übergeordneter Ablageort", config), "/Company/Records/2026"),
            ("revision", localized("Revision history", "Vollständiger Überarbeitungsverlauf", config), "v12 · 8 contributors"),
            ("review", localized("Review status", "Qualitätsprüfungs- und Freigabestatus", config), localized("Pending review", "Zur abschließenden Überprüfung vorgesehen", config)),
            ("retention", localized("Retention policy", "Gesetzliche Aufbewahrungsrichtlinien", config), "7 years"),
            ("identifier", localized("Document identifier", "Dokumentenidentifikationsnummer", config), "KORY-DOC-2026-0041"),
            ("distribution", localized("Distribution", "Zuständige Verteilergruppen und Organisationseinheiten", config), "Finance · Operations"),
            ("notes", localized("Compliance notes", "Zusätzliche Überprüfungshinweise", config), localized("External release requires approval", "Externe Veröffentlichung nur nach schriftlicher Freigabe", config))
        ]
        var contentViews: [NSView] = [heading, context]
        if config.content == "empty" {
            let empty = label(
                localized("No document selected", "Kein Dokument ausgewählt", config),
                id: "inspector.empty", size: textSize, strong: true
            )
            contentViews.append(empty)
        } else {
            let selected = config.content == "max" ? items : Array(items.prefix(6))
            let labelWidth: CGFloat = config.width == 620 ? 120 : (config.width == 900 ? 170 : 205)
            for (key, caption, value) in selected {
                let keyLabel = label(caption, id: "metadata.\(key).label", size: textSize)
                keyLabel.textColor = .secondaryLabelColor
                let valueLabel = label(value, id: "metadata.\(key).value", size: textSize)
                valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                let row = NSStackView(views: [keyLabel, valueLabel])
                row.orientation = .horizontal
                row.alignment = .top
                row.spacing = 12
                keyLabel.translatesAutoresizingMaskIntoConstraints = false
                valueLabel.translatesAutoresizingMaskIntoConstraints = false
                #if INSPECTOR_FAULT
                // Deliberately broken: the fixed fields overlap in a genuinely
                // narrow window. Without negative spacing, required field widths
                // cause AppKit to enlarge the window and hide the visual fault.
                row.spacing = -205
                keyLabel.widthAnchor.constraint(equalToConstant: 280).isActive = true
                valueLabel.widthAnchor.constraint(equalToConstant: 265).isActive = true
                #else
                let fieldWidth = keyLabel.widthAnchor.constraint(equalToConstant: labelWidth)
                fieldWidth.isActive = true
                metadataLabelWidthConstraints.append(fieldWidth)
                #endif
                row.setAccessibilityIdentifier("metadata.\(key).row")
                contentViews.append(row)
            }
        }

        let detailsStack = vertical(contentViews, spacing: large ? 18 : 13)
        let document = InspectorDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(detailsStack)
        detailsStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            detailsStack.topAnchor.constraint(equalTo: document.topAnchor, constant: 24),
            detailsStack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
            detailsStack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
            detailsStack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -24),
            heading.widthAnchor.constraint(equalTo: detailsStack.widthAnchor),
            context.widthAnchor.constraint(equalTo: detailsStack.widthAnchor)
        ])
        for row in contentViews.dropFirst(2) {
            row.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true
        }
        scroll.documentView = document
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            document.heightAnchor.constraint(greaterThanOrEqualTo: scroll.contentView.heightAnchor)
        ])

        window.contentView = root
        root.addSubview(toolbar)
        root.addSubview(sidebar)
        root.addSubview(separator)
        root.addSubview(scroll)
        let sidebarWidthAnchor = sidebar.widthAnchor.constraint(equalToConstant: sidebarWidth)
        sidebarWidthConstraint = sidebarWidthAnchor
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: root.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: large ? 76 : 64),
            sidebar.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebarWidthAnchor,
            separator.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            separator.topAnchor.constraint(equalTo: sidebar.topAnchor),
            separator.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            separator.widthAnchor.constraint(equalToConstant: 1),
            scroll.leadingAnchor.constraint(equalTo: separator.trailingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: sidebar.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1800, height: 1200)
        window.setFrame(NSRect(
            x: screen.minX + 40,
            y: screen.maxY - CGFloat(config.height) - 40,
            width: CGFloat(config.width), height: CGFloat(config.height)
        ), display: true, animate: false)
        updateResponsiveWidths(window.frame.width)
        window.layoutIfNeeded()
        window.displayIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
            self.window.displayIfNeeded()
            let frame = self.window.frame
            let content = self.window.contentView?.bounds ?? .zero
            print("FRAME \(config.revision) \(Int(frame.width))x\(Int(frame.height)) \(Int(content.width))x\(Int(content.height)) visible=\(self.window.isVisible) active=\(NSApp.isActive) occluded=\(!self.window.occlusionState.contains(.visible))")
            print("READY \(config.revision)")
            fflush(stdout)
        }
    }
}

let app = NSApplication.shared
let delegate = InspectorApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
