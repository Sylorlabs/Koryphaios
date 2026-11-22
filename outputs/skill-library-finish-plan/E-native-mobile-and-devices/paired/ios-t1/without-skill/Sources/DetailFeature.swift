import SwiftUI

// MARK: - Request identity

/// Identity of a single detail request.
///
/// `NavigationPresentation` is the shared owner of the detail area: `activate()`
/// advances `generation` and `currentID` for every navigation, so a captured
/// `(id, generation)` pair is a stable "who owns the displayed state" token. It
/// lives on the shared model rather than in view state because view state is
/// discarded with the view, and the request that must be recognised as stale is
/// issued by a view that has already been replaced.
private struct DetailRequest: Equatable {
    let id: String
    let generation: Int
}

/// Key that `.task(id:)` is bound to: the identity the load belongs to.
///
/// Navigating to another id produces a new destination view, and tapping Retry
/// bumps `epoch`. Either change cancels the outstanding request before the
/// replacement request is issued, which is what keeps task lifetime equal to
/// view/id lifetime.
private struct DetailRequestKey: Hashable {
    let id: String
    let epoch: Int
}

struct DetailFeature: View {
    let id: String
    @ObservedObject var model: NavigationPresentation
    @ObservedObject var loader: ControlledLoader

    /// Retry epoch. A retry is a *new* request, never a mutation of the
    /// in-flight one, so it has to invalidate the previous request.
    @State private var retryEpoch = 0

    private var requestKey: DetailRequestKey {
        DetailRequestKey(id: id, epoch: retryEpoch)
    }

    var body: some View {
        // A scroll view keeps the detail readable at accessibility Dynamic Type
        // sizes, where the vertical stack no longer fits the pushed view.
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Detail \(id)")
                    .accessibilityIdentifier("detail-title")
                Text("Status: \(model.state)")
                    .accessibilityIdentifier("detail-status")
                Text(model.response)
                    .accessibilityIdentifier("detail-response")
                Button("Retry") {
                    // Keep the shared retry counter in step with issued
                    // requests; the epoch is what cancels the in-flight request.
                    model.retry += 1
                    retryEpoch += 1
                }
                .accessibilityIdentifier("retry-load")
                .accessibilityHint("Requests the detail for \(id) again")
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Detail \(id)")
        // Task lifetime is bound to the displayed identity: leaving the screen,
        // navigating to another id, or retrying cancels the request in flight.
        // No detached `Task {}` escapes the view, so cancellation is real and
        // the transport's cancellation handler runs.
        .task(id: requestKey) { await loadDetail() }
    }

    /// Loads the detail for `id`. Runs on the main actor (SwiftUI's `.task` is
    /// main-actor isolated) so every state transition stays ordering-safe.
    @MainActor
    private func loadDetail() async {
        // Enter loading for the newly issued request. The previously displayed
        // response is deliberately kept until a newer one replaces it, so a
        // retry never blanks the screen and only a navigation clears it.
        if model.currentID == id {
            model.state = "loading"
        }

        // Record the generation this request was issued under. It is read from
        // the shared presentation, so a request started by a view that has since
        // been replaced can still be recognised as no longer owning the screen.
        let request = DetailRequest(id: id, generation: model.generation)

        do {
            let response = try await loader.fetch(request.id)
            // Cancellation is cooperative: the fake transport, like a real
            // client, can still deliver a callback after cancellation. Both
            // checks are required — the cancellation flag stops a request the
            // identity change already invalidated, and the owner check stops a
            // late response from a superseded id/generation from overwriting
            // the screen that is actually on top.
            guard !Task.isCancelled, ownsScreen(request) else { return }
            model.response = response
            model.state = "loaded"
        } catch {
            // An old failure must not clear the loading state of a newer
            // request, and must not replace a successful response either.
            guard !Task.isCancelled, ownsScreen(request) else { return }
            model.state = "error"
        }
    }

    /// True while the request that captured `request` still owns the detail
    /// area that this view displays.
    @MainActor
    private func ownsScreen(_ request: DetailRequest) -> Bool {
        model.currentID == request.id && model.generation == request.generation
    }
}
