import SwiftUI

// Independent positive control. Document bytes are disk-owned; drafts and
// keyboard state belong to each SwiftUI WindowGroup scene instance.
struct DocumentFeature: View {
    let documentID: String
    @State private var draft = ""
    @State private var revision = 0
    @State private var saveFailed = false
    @State private var autosave: Task<Void, Never>?
    @FocusState private var draftFocused: Bool
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        VStack {
            Text("Document \(documentID)").accessibilityIdentifier("document-\(documentID)")
            TextEditor(text: $draft)
                .focused($draftFocused)
                .accessibilityLabel("Draft for document \(documentID)")
                .accessibilityIdentifier("draft-\(documentID)")
            Text("Revision \(revision)").accessibilityIdentifier("revision-\(documentID)")
            if saveFailed {
                Text("Save failed; unsaved changes").accessibilityIdentifier("error-\(documentID)")
            }
            HStack {
                Button("Save") { persist() }.accessibilityIdentifier("save-\(documentID)")
                Button("Fail next save") { DocumentDiskStore.shared.failNext(documentID) }
                    .accessibilityIdentifier("inject-save-error-\(documentID)")
                Button("Retry save") {
                    DocumentDiskStore.shared.recover(documentID)
                    persist()
                }.accessibilityIdentifier("retry-save-\(documentID)")
                Button("Undo") {
                    autosave?.cancel()
                    if let restored = DocumentDiskStore.shared.undo(documentID) {
                        draft = restored
                        revision = DocumentDiskStore.shared.load(documentID).revision
                        saveFailed = false
                    }
                }.accessibilityIdentifier("undo-\(documentID)")
                Button("Close") {
                    autosave?.cancel()
                    dismissWindow(id: "documents", value: documentID)
                }.accessibilityIdentifier("close-\(documentID)")
            }
        }
        .padding()
        .onAppear {
            let stored = DocumentDiskStore.shared.load(documentID)
            draft = stored.text
            revision = stored.revision
        }
        .onChange(of: draft) { _, _ in
            autosave?.cancel()
            autosave = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if !Task.isCancelled { persist() }
            }
        }
        .onDisappear { autosave?.cancel() }
    }

    private func persist() {
        autosave?.cancel()
        saveFailed = !DocumentDiskStore.shared.save(documentID, text: draft)
        if !saveFailed { revision = DocumentDiskStore.shared.load(documentID).revision }
    }
}
