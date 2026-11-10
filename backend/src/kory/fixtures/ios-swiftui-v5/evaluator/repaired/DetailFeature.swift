import SwiftUI

// Independent positive control. Never included in candidate snapshots.
struct DetailFeature: View {
    let id: String
    @ObservedObject var model: NavigationPresentation
    @ObservedObject var loader: ControlledLoader

    var body: some View {
        VStack {
            Text("Detail \(id)").accessibilityIdentifier("detail-title")
            Text("Status: \(model.state)").accessibilityIdentifier("detail-status")
            Text(model.response).accessibilityIdentifier("detail-response")
            Button("Retry") { model.retry += 1 }
                .accessibilityIdentifier("retry-load")
        }
        .navigationTitle("Detail \(id)")
        .task(id: "\(model.generation)-\(model.retry)") {
            // SwiftUI can keep an outgoing destination alive through the
            // navigation transition. Its task must not restart a request after
            // another destination becomes current.
            guard model.currentID == id else { return }
            let generation = model.generation
            model.state = "loading"
            model.response = ""
            do {
                let value = try await loader.fetch(id)
                guard !Task.isCancelled, model.generation == generation,
                      model.currentID == id else { return }
                model.response = value
                model.state = "loaded"
            } catch {
                guard !Task.isCancelled, model.generation == generation,
                      model.currentID == id else { return }
                model.state = "error"
            }
        }
    }
}
