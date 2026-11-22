import Foundation
import SwiftUI

struct StoredDocument: Codable {
    var text: String
    var revision: Int
    var undoHistory: [String]
}

@MainActor
final class DocumentDiskStore {
    static let shared = DocumentDiskStore()
    private var rejected: Set<String> = []

    func resetFixtureDocuments() {
        for id in ["A", "B"] { try? FileManager.default.removeItem(at: file(id)) }
        rejected.removeAll()
    }

    private func file(_ id: String) -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("kory-doc-\(id).json")
    }

    func load(_ id: String) -> StoredDocument {
        if let data = try? Data(contentsOf: file(id)),
           let value = try? JSONDecoder().decode(StoredDocument.self, from: data) { return value }
        return StoredDocument(text: "Seed \(id)", revision: 0, undoHistory: [])
    }

    func failNext(_ id: String) { rejected.insert(id) }
    func recover(_ id: String) { rejected.remove(id) }

    @discardableResult func save(_ id: String, text: String) -> Bool {
        if rejected.contains(id) { return false }
        var current = load(id)
        if current.text != text {
            current.undoHistory.append(current.text)
            current.text = text
            current.revision += 1
        }
        do {
            let bytes = try JSONEncoder().encode(current)
            try bytes.write(to: file(id), options: .atomic)
            return true
        } catch { return false }
    }

    func undo(_ id: String) -> String? {
        var current = load(id)
        guard let previous = current.undoHistory.popLast() else { return nil }
        current.text = previous
        current.revision += 1
        guard let bytes = try? JSONEncoder().encode(current),
              (try? bytes.write(to: file(id), options: .atomic)) != nil else { return nil }
        return previous
    }
}

struct DocumentLauncher: View {
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack {
            Text("Document launcher").accessibilityIdentifier("document-launcher")
            Button("Open document A") { openWindow(id: "documents", value: "A") }
                .accessibilityIdentifier("launch-doc-A")
            Button("Open document B") { openWindow(id: "documents", value: "B") }
                .accessibilityIdentifier("launch-doc-B")
            Button("Open both documents") {
                // Request both real WindowGroup scenes from the launcher before
                // either document scene takes foreground focus.
                openWindow(id: "documents", value: "A")
                openWindow(id: "documents", value: "B")
            }
                .accessibilityIdentifier("launch-doc-both")
        }.padding()
    }
}

/// Fixed native test navigation: moving focus to an already-open document
/// activates that WindowGroup scene. It never shares or changes draft state.
struct DocumentWindowHost: View {
    let documentID: String
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Show document A") { openWindow(id: "documents", value: "A") }
                    .accessibilityIdentifier("activate-A-from-\(documentID)")
                Button("Show document B") { openWindow(id: "documents", value: "B") }
                    .accessibilityIdentifier("activate-B-from-\(documentID)")
                Button("Show launcher") { openWindow(id: "navigation") }
                    .accessibilityIdentifier("activate-launcher-from-\(documentID)")
            }.buttonStyle(.bordered)
            DocumentFeature(documentID: documentID)
        }
    }
}
