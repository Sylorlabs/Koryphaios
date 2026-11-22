import SwiftUI

/// Detail screen for one stable navigation identity.
///
/// Ownership model:
/// - The request is owned by the view's lifetime through `.task(id:)`, so
///   popping the screen, replacing it with another id, or tapping Retry cancels
///   the in-flight request instead of leaking it into the next screen. A
///   detached `Task` started in `onAppear` has none of those lifetimes, which
///   is how a late "A" response used to overwrite the "B" screen.
/// - The fixture transport is deliberately sloppy: `ControlledLoader` can still
///   deliver a response *after* its task was cancelled, so cancellation alone
///   is not enough. Every result is validated, on the main actor, against the
///   identity it was requested with (navigation id + request generation) before
///   it is allowed to publish into the shared presentation state.
struct DetailFeature: View {
    let id: String
    @ObservedObject var model: NavigationPresentation
    @ObservedObject var loader: ControlledLoader

    /// Identity of the load that may publish on this screen: the navigation id
    /// plus the retry counter, so a retry issues a fresh generation of the load
    /// instead of joining an abandoned request.
    private var loadKey: String { "\(id)|\(model.retry)" }

    var body: some View {
        // The navigation area around this screen is height-constrained, so the
        // detail keeps its own footprint bounded and scrollable: at an
        // accessibility Dynamic Type size the four rows still exist, are
        // labelled, and stay reachable instead of pushing the surrounding
        // controls off screen.
        VStack {
            ScrollView {
                VStack {
                    Text("Detail \(id)")
                        .accessibilityIdentifier("detail-title")
                        .accessibilityAddTraits(.isHeader)
                    Text("Status: \(model.state)")
                        .accessibilityIdentifier("detail-status")
                    Text(model.response)
                        .accessibilityIdentifier("detail-response")
                    Button("Retry") { model.retry += 1 }
                        .accessibilityIdentifier("retry-load")
                        .accessibilityHint("Loads this item again")
                }
            }
            .frame(height: 130)
        }
        .navigationTitle("Detail \(id)")
        // Bound to view identity: leaving the screen or changing id cancels the
        // previous request; Retry changes the key and starts a new generation.
        .task(id: loadKey) { await load() }
    }

    /// Issues exactly one request generation. Bumping the generation first means
    /// any older in-flight request for this screen (revisit, previous id, or an
    /// earlier retry) can no longer own the loading/loaded/error transition.
    @MainActor
    private func load() async {
        model.generation += 1
        let generation = model.generation
        let requestedID = id
        model.state = "loading"
        do {
            let text = try await loader.fetch(requestedID)
            guard ownsDisplayedState(requestedID, generation) else { return }
            model.response = text
            model.state = "loaded"
        } catch {
            // A cancelled or superseded failure must never clear the loading
            // state of the screen that replaced this one.
            guard ownsDisplayedState(requestedID, generation) else { return }
            model.state = "error"
        }
    }

    /// A result may publish only while its request is uncancelled and is still
    /// the newest identity in the shared presentation state.
    @MainActor
    private func ownsDisplayedState(_ requestedID: String, _ generation: Int) -> Bool {
        !Task.isCancelled
            && model.currentID == requestedID
            && model.generation == generation
    }
}
