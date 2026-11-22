import SwiftUI

@main
struct KoryIOSFixtureApp: App {
    init() {
        if ProcessInfo.processInfo.arguments.contains("--kory-eval-reset-documents") {
            DocumentDiskStore.shared.resetFixtureDocuments()
        }
    }
    var body: some Scene {
        WindowGroup(id: "navigation") {
            NavigationFixture()
        }
        WindowGroup(id: "documents", for: String.self) { document in
            if let documentID = document.wrappedValue {
                DocumentWindowHost(documentID: documentID)
            } else {
                Text("No document selected")
            }
        }
    }
}
