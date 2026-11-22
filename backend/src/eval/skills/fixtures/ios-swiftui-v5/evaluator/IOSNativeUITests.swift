import XCTest

/// Evaluator-owned XCTest suite. This file is never included in candidate snapshots.
final class NavigationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["--kory-eval-reset-navigation"]
        app.launch()
        let list = app.buttons["open-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 20))
        list.tap()
    }

    private func waitForLabel(_ id: String, containing text: String, timeout: TimeInterval = 15) {
        let target = app.staticTexts[id]
        XCTAssertTrue(target.waitForExistence(timeout: timeout), "Missing native element: \(id)")
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        let check = expectation(for: predicate, evaluatedWith: target)
        wait(for: [check], timeout: timeout)
    }

    private func capture(_ name: String) {
        let evidence = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        evidence.name = name
        evidence.lifetime = .keepAlways
        add(evidence)
    }

    private func waitForPending(_ expected: String, timeout: TimeInterval = 15) {
        let counter = app.staticTexts["pending-counts"]
        XCTAssertTrue(counter.waitForExistence(timeout: timeout))
        let predicate = NSPredicate(format: "label == %@", expected)
        let pending = XCTNSPredicateExpectation(predicate: predicate, object: counter)
        XCTAssertEqual(XCTWaiter.wait(for: [pending], timeout: timeout), .completed,
                       "Expected pending \(expected), actual \(counter.label). Hierarchy: \(app.debugDescription)")
    }

    func testNavigationRace() throws {
        app.buttons["open-A"].tap()
        waitForLabel("detail-status", containing: "loading")
        waitForPending("A: 1 B: 0")
        app.buttons["open-B"].tap()
        waitForLabel("detail-title", containing: "B")
        waitForPending("A: 1 B: 1")
        app.buttons["release-B"].tap()
        waitForLabel("detail-response", containing: "Response B")
        app.buttons["release-first-A"].tap()
        waitForPending("A: 0 B: 0")
        // Let the deliberately cancellation-insensitive callback reach the app
        // process before checking the stable, final rendered state. An immediate
        // predicate on B could pass before the stale A callback runs.
        Thread.sleep(forTimeInterval: 1.0)
        let visible = app.staticTexts["detail-response"].label
        XCTAssertTrue(visible.contains("Response B"),
                      "stale-response-overwrote-B: \(visible)")
        capture("navigation-race-B-before-A")
    }

    func testCancelAndRevisit() throws {
        app.buttons["open-A"].tap()
        waitForLabel("detail-status", containing: "loading")
        waitForPending("A: 1 B: 0")
        app.buttons["open-list"].tap()
        app.buttons["open-A"].tap()
        waitForLabel("detail-title", containing: "A")
        waitForPending("A: 2 B: 0")
        app.buttons["release-first-A"].tap()
        waitForPending("A: 1 B: 0")
        Thread.sleep(forTimeInterval: 1.0)
        waitForLabel("detail-status", containing: "loading")
        let response = app.staticTexts["detail-response"]
        XCTAssertFalse(response.exists && response.label.contains("Response A"),
                       "A canceled navigation generation must not render stale content")
        app.buttons["release-last-A"].tap()
        waitForPending("A: 0 B: 0")
        waitForLabel("detail-response", containing: "Response A")
        let cancelled = app.staticTexts["cancelled-count"]
        XCTAssertTrue(cancelled.exists)
        XCTAssertNotEqual(cancelled.label, "Cancelled: 0", "SwiftUI must cancel departed task")
        capture("cancelled-previous-generation")
    }

    func testOfflineAndRetry() throws {
        app.buttons["go-offline"].tap()
        app.buttons["open-B"].tap()
        waitForLabel("detail-status", containing: "error")
        let retry = app.buttons["retry-load"]
        XCTAssertTrue(retry.exists)
        XCTAssertTrue(retry.isEnabled)
        XCTAssertEqual(retry.label, "Retry")
        XCTAssertEqual(app.staticTexts["detail-status"].label, "Status: error")
        capture("accessible-offline-error")
        app.buttons["go-online"].tap()
        retry.tap()
        waitForLabel("detail-status", containing: "loading")
        waitForPending("A: 0 B: 1")
        app.buttons["release-B"].tap()
        waitForLabel("detail-response", containing: "Response B")
        capture("recovered-after-retry")
    }

    func testLifecycleAndRestoration() throws {
        app.buttons["open-B"].tap()
        waitForLabel("detail-title", containing: "B")
        waitForPending("A: 0 B: 1")
        XCUIDevice.shared.press(.home)
        app.activate()
        waitForLabel("scene-phase", containing: "active")
        waitForLabel("detail-title", containing: "B")
        app.buttons["release-B"].tap()
        waitForLabel("detail-response", containing: "Response B")
        capture("background-foreground")
        app.terminate()
        app.launchArguments = []
        app.launch()
        waitForLabel("detail-title", containing: "B")
        capture("navigation-restored-after-process-relaunch")
    }

    func testAccessibilityAndLargeType() throws {
        app.buttons["open-A"].tap()
        waitForLabel("detail-title", containing: "A")
        XCTAssertEqual(app.staticTexts["detail-status"].label, "Status: loading")
        XCTAssertEqual(app.staticTexts["detail-title"].label, "Detail A")
        waitForLabel("dynamic-type", containing: "yes")
        waitForPending("A: 1 B: 0")
        let keyboard = app.textFields["focus-input"]
        XCTAssertTrue(keyboard.exists)
        keyboard.tap()
        keyboard.typeText("focus")
        XCTAssertTrue(keyboard.value.debugDescription.contains("focus"))
        app.buttons["release-first-A"].tap()
        waitForPending("A: 0 B: 0")
        waitForLabel("detail-status", containing: "loaded")
        XCTAssertEqual(app.staticTexts["detail-status"].label, "Status: loaded")
        XCTAssertTrue(app.staticTexts["detail-response"].label.contains("Response A"))
        capture("large-type-and-accessibility-tree")
    }
}

final class DocumentUITests: XCTestCase {
    private var app: XCUIApplication!
    private var foregroundDocumentID: String?

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["--kory-eval-reset-documents", "--kory-eval-reset-navigation"]
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 10),
                          "Previous iPad fixture process did not terminate before relaunch")
        }
        app.launch()
        foregroundDocumentID = nil
        showLauncher()
    }

    @discardableResult
    private func showLauncher() -> XCUIElement {
        // iPad can reconnect only the last foreground document on process
        // relaunch. Explicitly activate the real launcher scene before opening
        // documents, including the process-restoration phase without reset flags.
        if !app.windows.firstMatch.buttons["launch-doc-both"].exists {
            let launcher = app.windows.firstMatch.buttons.matching(NSPredicate(
                format: "identifier BEGINSWITH %@", "activate-launcher-from-"
            )).firstMatch
            XCTAssertTrue(launcher.waitForExistence(timeout: 20), "No restored document can activate the launcher")
            launcher.tap()
        }
        let window = app.windows.firstMatch
        XCTAssertTrue(window.buttons["launch-doc-both"].waitForExistence(timeout: 20))
        return window
    }

    private func openBoth() {
        // Keep the launcher tappable until both genuine WindowGroup scenes have
        // been requested; opening A first can foreground A over the launcher.
        showLauncher().buttons["launch-doc-both"].tap()
        XCTAssertTrue(app.staticTexts["document-A"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["document-B"].waitForExistence(timeout: 15))
        let windows = app.windows
        XCTAssertGreaterThanOrEqual(windows.count, 3, "Two distinct native iPad document scenes plus launcher are required")
        let windowA = windows.containing(.staticText, identifier: "document-A").firstMatch
        let windowB = windows.containing(.staticText, identifier: "document-B").firstMatch
        XCTAssertTrue(windowA.exists && windowB.exists)
        XCTAssertFalse(windowA.staticTexts["document-B"].exists, "A and B must have distinct UIWindow scenes")
        XCTAssertFalse(windowB.staticTexts["document-A"].exists, "A and B must have distinct UIWindow scenes")
        // WindowGroup creation order does not define which iPad scene the
        // system leaves in front. XCTest must discover the interactive scene.
        foregroundDocumentID = nil
    }

    private func focusDocument(_ id: String) {
        let editor = app.textViews["draft-\(id)"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        if editor.isHittable {
            foregroundDocumentID = id
            return
        }
        let other = id == "A" ? "B" : "A"
        let switcher = app.buttons["activate-\(id)-from-\(other)"]
        let launcher = app.buttons["launch-doc-\(id)"]
        // iPad can leave either document or the launcher active after opening
        // both scenes. Only tap a native control in the genuinely foreground
        // window; an existing control in a background scene is not tappable.
        let deadline = Date().addingTimeInterval(10)
        var switched = false
        repeat {
            if switcher.isHittable {
                switcher.tap()
                switched = true
                break
            }
            if launcher.isHittable {
                launcher.tap()
                switched = true
                break
            }
            Thread.sleep(forTimeInterval: 0.2)
        } while Date() < deadline
        XCTAssertTrue(switched,
                      "No foreground native scene can activate document \(id). Hierarchy: \(app.debugDescription)")
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: editor)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 10), .completed,
                       "Native document \(id) did not become interactive after foreground activation")
        foregroundDocumentID = id
    }

    private func capture(_ name: String) {
        let evidence = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        evidence.name = name
        evidence.lifetime = .keepAlways
        add(evidence)
    }

    private func append(_ id: String, _ value: String) {
        focusDocument(id)
        let editor = app.textViews["draft-\(id)"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        editor.typeText(value)
    }

    private func draft(_ id: String) -> String {
        let editor = app.textViews["draft-\(id)"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        guard let value = editor.value as? String else {
            XCTFail("Native editor for \(id) has no readable accessibility value")
            return ""
        }
        return value
    }

    private func moveCaretToEnd(_ editor: XCUIElement, _ id: String) {
        // Xcode 27 can stall waiting for quiescence when tapping a coordinate in
        // an already focused editor after switching native iPad scenes.
        // iPad Simulator XCUITest does not honor End or Command+Right when
        // typed into a SwiftUI TextEditor after changing native scenes.
        // typeText inserts the RightArrow glyph as literal text, so synthesize
        // genuine hardware key events one at a time instead.
        // The exact rendered text assertions below verify the resulting caret.
        let text = draft(id)
        XCTAssertFalse(text.contains("\n"), "Caret fixture must remain single-line")
        for _ in 0...text.utf16.count {
            editor.typeKey(.rightArrow, modifierFlags: [])
        }
    }

    private func revision(_ id: String) -> Int {
        let text = app.staticTexts["revision-\(id)"]
        XCTAssertTrue(text.waitForExistence(timeout: 10))
        return Int(text.label.replacingOccurrences(of: "Revision ", with: "")) ?? -1
    }

    private func waitForSavedRevision(_ id: String) {
        let text = app.staticTexts["revision-\(id)"]
        XCTAssertTrue(text.waitForExistence(timeout: 10))
        let predicate = NSPredicate(format: "label != %@", "Revision 0")
        let pending = XCTNSPredicateExpectation(predicate: predicate, object: text)
        XCTAssertEqual(XCTWaiter.wait(for: [pending], timeout: 10), .completed,
                       "Real autosave never advanced revision for \(id)")
        XCTAssertGreaterThanOrEqual(revision(id), 1)
    }

    func testConcurrentSceneIsolation() throws {
        openBoth()
        let initialB = String(describing: app.textViews["draft-B"].value)
        append("A", " A-specific")
        XCTAssertTrue(String(describing: app.textViews["draft-A"].value).contains("A-specific"))
        XCTAssertEqual(String(describing: app.textViews["draft-B"].value), initialB,
                       "global-draft-leaked-across-scenes: A edit changed B")
        XCTAssertEqual(app.staticTexts["document-A"].label, "Document A")
        XCTAssertEqual(app.staticTexts["document-B"].label, "Document B")
        capture("two-real-ipad-windows")
    }

    func testAutosaveAndDocumentScopedUndo() throws {
        openBoth()
        append("A", " saved-A")
        waitForSavedRevision("A") // The native two-second autosave, not the Save button.
        let savedA = revision("A")
        append("B", " edited-B")
        app.buttons["save-B"].tap()
        XCTAssertGreaterThanOrEqual(revision("B"), 1)
        app.buttons["undo-B"].tap()
        XCTAssertTrue(String(describing: app.textViews["draft-A"].value).contains("saved-A"))
        XCTAssertFalse(String(describing: app.textViews["draft-B"].value).contains("edited-B"))
        XCTAssertEqual(revision("A"), savedA, "Undo in B mutated A's durable revision")
        XCTAssertGreaterThan(revision("B"), 1)
        capture("document-scoped-undo")
    }

    func testFailedDiskSaveAndRecovery() throws {
        openBoth()
        focusDocument("A")
        XCTAssertEqual(revision("A"), 0)
        // Inject before editing so the two-second native autosave cannot win a
        // race and persist the draft before the deliberate filesystem failure.
        app.buttons["inject-save-error-A"].tap()
        append("A", " intended")
        app.buttons["save-A"].tap()
        XCTAssertTrue(app.staticTexts["error-A"].waitForExistence(timeout: 5))
        XCTAssertEqual(revision("A"), 0, "Rejected write changed the durable revision")
        XCTAssertTrue(String(describing: app.textViews["draft-A"].value).contains("intended"))
        capture("disk-save-failed-and-dirty")
        app.buttons["retry-save-A"].tap()
        XCTAssertFalse(app.staticTexts["error-A"].exists)
        XCTAssertEqual(revision("A"), 1)
        XCTAssertTrue(String(describing: app.textViews["draft-A"].value).contains("intended"))
        capture("disk-save-recovered")
    }

    func testDiscardAndReopenScene() throws {
        openBoth()
        append("A", " persist-A")
        app.buttons["save-A"].tap()
        app.buttons["close-A"].tap()
        XCTAssertTrue(app.staticTexts["document-A"].waitForNonExistence(timeout: 10),
                      "The actual document A scene did not finish closing")
        XCTAssertTrue(app.staticTexts["document-B"].exists)
        XCTAssertEqual(app.windows.containing(.staticText, identifier: "document-A").count, 0)
        // Rebind XCTest interaction to the surviving foreground scene after
        // iPad has removed the previously key document window.
        app.activate()
        // Reopen through the launcher after the asynchronous dismissal, rather
        // than assuming which remaining scene iPad foregrounded after closing A.
        showLauncher().buttons["launch-doc-A"].tap()
        foregroundDocumentID = "A"
        XCTAssertTrue(app.staticTexts["document-A"].waitForExistence(timeout: 10))
        XCTAssertTrue(String(describing: app.textViews["draft-A"].value).contains("persist-A"))
        capture("scene-discard-reopened")
    }

    func testProcessDeathAndDiskRestoration() throws {
        openBoth()
        append("A", " process-A")
        app.buttons["save-A"].tap()
        append("B", " process-B")
        app.buttons["save-B"].tap()
        app.terminate()
        app.launchArguments = []
        app.launch()
        openBoth()
        XCTAssertTrue(String(describing: app.textViews["draft-A"].value).contains("process-A"))
        XCTAssertTrue(String(describing: app.textViews["draft-B"].value).contains("process-B"))
        capture("documents-reopened-after-process-death")
    }

    func testPerSceneFocusAndAccessibleLargeType() throws {
        openBoth()
        XCTAssertTrue(app.staticTexts["document-A"].exists)
        XCTAssertTrue(app.staticTexts["document-B"].exists)
        XCTAssertTrue(app.textViews["draft-A"].isEnabled)
        XCTAssertTrue(app.textViews["draft-B"].isEnabled)
        XCTAssertEqual(app.textViews["draft-A"].label, "Draft for document A")
        XCTAssertEqual(app.textViews["draft-B"].label, "Draft for document B")
        focusDocument("A")
        app.buttons["inject-save-error-A"].tap()
        let editorA = app.textViews["draft-A"]
        editorA.tap()
        // Physical-key events require actual editor focus. Inserting between
        // two characters checks the caret location, not just eventual text.
        moveCaretToEnd(editorA, "A")
        editorA.typeText(" 12")
        editorA.typeKey(.leftArrow, modifierFlags: [])
        editorA.typeText("!")
        XCTAssertEqual(draft("A"), "Seed A 1!2")
        XCTAssertTrue(app.staticTexts["error-A"].waitForExistence(timeout: 10))
        XCTAssertEqual(revision("A"), 0, "Unsaved A draft must not advance its disk revision")

        focusDocument("B")
        app.buttons["inject-save-error-B"].tap()
        let editorB = app.textViews["draft-B"]
        editorB.tap()
        moveCaretToEnd(editorB, "B")
        editorB.typeText(" 34")
        editorB.typeKey(.leftArrow, modifierFlags: [])
        editorB.typeText("?")
        XCTAssertEqual(draft("B"), "Seed B 3?4")
        XCTAssertTrue(app.staticTexts["error-B"].waitForExistence(timeout: 10))
        XCTAssertEqual(revision("B"), 0)

        focusDocument("A")
        XCTAssertEqual(draft("A"), "Seed A 1!2", "Switching windows lost A's unsaved editor state")
        XCTAssertEqual(revision("A"), 0)
        editorA.tap()
        moveCaretToEnd(editorA, "A")
        editorA.typeText("!")
        XCTAssertEqual(draft("A"), "Seed A 1!2!")
        focusDocument("B")
        XCTAssertEqual(draft("B"), "Seed B 3?4", "A's resumed focus must not rewrite B")
        XCTAssertEqual(revision("B"), 0)
        capture("ipad-keyboard-accessible-windows")
    }
}
