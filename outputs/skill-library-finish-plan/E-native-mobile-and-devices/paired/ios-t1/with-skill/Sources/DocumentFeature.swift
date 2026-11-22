import SwiftUI

/// Editor for one document scene.
///
/// The document id is the stable identity of its `WindowGroup` scene, so the
/// mutable draft and the actionable save error are owned by this view: one
/// instance per scene, loaded from the persisted document when the scene is
/// created. A process-wide singleton would let one window's typing, save, and
/// undo mutate the draft every other window is editing.
struct DocumentFeature: View {
    let documentID: String
    @State private var draft: String
    @State private var saveFailed = false
    @Environment(\.dismissWindow) private var dismissWindow

    init(documentID: String) {
        self.documentID = documentID
        _draft = State(initialValue: DocumentDiskStore.shared.load(documentID).text)
    }

    var body: some View {
        VStack {
            Text("Document \(documentID)")
                .accessibilityIdentifier("document-\(documentID)")
            TextEditor(text: $draft)
                .accessibilityIdentifier("draft-\(documentID)")
            Text("Revision \(DocumentDiskStore.shared.load(documentID).revision)")
                .accessibilityIdentifier("revision-\(documentID)")
            if saveFailed { Text("Save failed").accessibilityIdentifier("error-\(documentID)") }
            HStack {
                Button("Save") { saveFailed = !DocumentDiskStore.shared.save(documentID, text: draft) }
                    .accessibilityIdentifier("save-\(documentID)")
                Button("Fail next save") { DocumentDiskStore.shared.failNext(documentID) }
                    .accessibilityIdentifier("inject-save-error-\(documentID)")
                Button("Retry save") {
                    DocumentDiskStore.shared.recover(documentID)
                    saveFailed = !DocumentDiskStore.shared.save(documentID, text: draft)
                }
                    .accessibilityIdentifier("retry-save-\(documentID)")
                Button("Undo") {
                    if let previous = DocumentDiskStore.shared.undo(documentID) { draft = previous }
                }
                    .accessibilityIdentifier("undo-\(documentID)")
                Button("Close") { dismissWindow(id: "documents", value: documentID) }
                    .accessibilityIdentifier("close-\(documentID)")
            }
        }
        .padding()
    }
}
