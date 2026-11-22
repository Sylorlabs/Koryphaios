import SwiftUI

enum FixtureFailure: Error {
    case offline
}

@MainActor
final class ControlledLoader: ObservableObject {
    struct Pending {
        let id: String
        let sequence: Int
        let continuation: CheckedContinuation<String, Error>
    }

    @Published private(set) var waitingA = 0
    @Published private(set) var waitingB = 0
    @Published private(set) var cancellationCount = 0
    @Published var offline = false
    private var sequence = 0
    private var pending: [Pending] = []

    func fetch(_ id: String) async throws -> String {
        if offline { throw FixtureFailure.offline }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                sequence += 1
                pending.append(Pending(id: id, sequence: sequence, continuation: continuation))
                updateCounts()
            }
        } onCancel: {
            // Deliberately retain the outstanding transport response. Some real
            // transports deliver a callback even after task cancellation.
            Task { @MainActor in self.cancellationCount += 1 }
        }
    }

    func release(_ id: String, newest: Bool = false) {
        guard let index = newest ? pending.lastIndex(where: { $0.id == id }) :
                pending.firstIndex(where: { $0.id == id }) else { return }
        let current = pending.remove(at: index)
        updateCounts()
        current.continuation.resume(returning: "Response \(id) #\(current.sequence)")
    }

    private func updateCounts() {
        waitingA = pending.filter { $0.id == "A" }.count
        waitingB = pending.filter { $0.id == "B" }.count
    }
}

@MainActor
final class NavigationPresentation: ObservableObject {
    @Published var currentID = ""
    @Published var generation = 0
    @Published var retry = 0
    @Published var state = "idle"
    @Published var response = ""
    @Published var scenePhase = "unknown"

    func activate(_ id: String) {
        currentID = id
        generation += 1
        state = "loading"
        response = ""
    }
}

struct NavigationFixture: View {
    @StateObject private var model = NavigationPresentation()
    @StateObject private var loader = ControlledLoader()
    @State private var path: [String] = []
    @State private var filter = ""
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var filterFocused: Bool

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Button("Open A") { open("A") }.accessibilityIdentifier("open-A")
                Button("Open B") { open("B") }.accessibilityIdentifier("open-B")
                Button("List") { open("") }.accessibilityIdentifier("open-list")
            }
            .buttonStyle(.bordered)
            NavigationStack(path: $path) {
                Text("Navigation fixture")
                    .navigationTitle("Library")
                    .navigationDestination(for: String.self) { id in
                        DetailFeature(id: id, model: model, loader: loader)
                            .id(id)
                    }
            }
            .onChange(of: path) { _, newPath in
                let next = newPath.last ?? ""
                if next != model.currentID { model.activate(next) }
                UserDefaults.standard.set(next, forKey: "koryNavigationID")
            }
            .frame(minHeight: 130)
            HStack {
                Button("Resolve first A") { loader.release("A") }
                    .accessibilityIdentifier("release-first-A")
                Button("Resolve last A") { loader.release("A", newest: true) }
                    .accessibilityIdentifier("release-last-A")
                Button("Resolve B") { loader.release("B") }
                    .accessibilityIdentifier("release-B")
            }.buttonStyle(.bordered)
            HStack {
                Button("Offline") { loader.offline = true }
                    .accessibilityIdentifier("go-offline")
                Button("Online") { loader.offline = false }
                    .accessibilityIdentifier("go-online")
                Text("A: \(loader.waitingA) B: \(loader.waitingB)")
                    .accessibilityIdentifier("pending-counts")
            }.buttonStyle(.bordered)
            Text("Cancelled: \(loader.cancellationCount)")
                .accessibilityIdentifier("cancelled-count")
            Text("Scene: \(model.scenePhase)").accessibilityIdentifier("scene-phase")
            Text("Large type: \(dynamicTypeSize.isAccessibilitySize ? "yes" : "no")")
                .accessibilityIdentifier("dynamic-type")
            TextField("Keyboard focus", text: $filter)
                .focused($filterFocused)
                .accessibilityIdentifier("focus-input")
            DocumentLauncher()
        }
        .padding()
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--kory-eval-reset-navigation") {
                UserDefaults.standard.removeObject(forKey: "koryNavigationID")
            }
            let saved = UserDefaults.standard.string(forKey: "koryNavigationID") ?? ""
            if !saved.isEmpty && model.currentID.isEmpty { open(saved) }
            model.scenePhase = String(describing: scenePhase)
        }
        .onChange(of: scenePhase) { _, value in model.scenePhase = String(describing: value) }
    }

    private func open(_ id: String) {
        model.activate(id)
        path = id.isEmpty ? [] : [id]
        UserDefaults.standard.set(id, forKey: "koryNavigationID")
    }
}
