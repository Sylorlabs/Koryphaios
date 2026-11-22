import SwiftUI

// Candidate defect: an unowned onAppear task may complete after navigation.
struct DetailFeature: View {
    let id: String
    @ObservedObject var model: NavigationPresentation
    @ObservedObject var loader: ControlledLoader

    var body: some View {
        VStack {
            Text("Detail \(id)").accessibilityIdentifier("detail-title")
            Text("Status: \(model.state)").accessibilityIdentifier("detail-status")
            Text(model.response).accessibilityIdentifier("detail-response")
            Button("Retry") { model.retry += 1; begin() }
                .accessibilityIdentifier("retry-load")
        }
        .navigationTitle("Detail \(id)")
        .onAppear { begin() }
    }

    private func begin() {
        model.state = "loading"
        Task {
            do {
                let text = try await loader.fetch(id)
                model.response = text
                model.state = "loaded"
            } catch {
                model.state = "error"
            }
        }
    }
}
