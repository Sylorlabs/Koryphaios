import SwiftUI

// Candidate defect: one mutable draft is shared across every document window.
@MainActor
final class GlobalDraft: ObservableObject {
    static let shared = GlobalDraft()
    @Published var text = ""
}

struct DocumentFeature: View {
    let documentID: String
    @ObservedObject private var shared = GlobalDraft.shared
    @State private var saveFailed = false
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        VStack {
            Text("Document \(documentID)").accessibilityIdentifier("document-\(documentID)")
            TextEditor(text: $shared.text).accessibilityIdentifier("draft-\(documentID)")
            Text("Revision \(DocumentDiskStore.shared.load(documentID).revision)")
                .accessibilityIdentifier("revision-\(documentID)")
            if saveFailed { Text("Save failed").accessibilityIdentifier("error-\(documentID)") }
            HStack {
                Button("Save") { saveFailed = !DocumentDiskStore.shared.save(documentID, text: shared.text) }
                    .accessibilityIdentifier("save-\(documentID)")
                Button("Fail next save") { DocumentDiskStore.shared.failNext(documentID) }
                    .accessibilityIdentifier("inject-save-error-\(documentID)")
                Button("Retry save") { DocumentDiskStore.shared.recover(documentID); saveFailed = !DocumentDiskStore.shared.save(documentID, text: shared.text) }
                    .accessibilityIdentifier("retry-save-\(documentID)")
                Button("Undo") { shared.text = DocumentDiskStore.shared.undo(documentID) ?? shared.text }
                    .accessibilityIdentifier("undo-\(documentID)")
                Button("Close") { dismissWindow(id: "documents", value: documentID) }
                    .accessibilityIdentifier("close-\(documentID)")
            }
        }
        .padding()
        .onAppear { shared.text = DocumentDiskStore.shared.load(documentID).text }
    }
}
