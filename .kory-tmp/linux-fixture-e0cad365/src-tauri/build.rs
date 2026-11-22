fn main() {
    // Declare the exact set of commands the window may invoke. Tauri generates
    // `allow-<command>` permissions from this list, and the capability file grants only those
    // that the renderer actually needs. A command that is not listed here has no permission to
    // grant it, so the unregistered probe stays unanswerable rather than being reachable through
    // a catch-all.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "choose_workspace",
                "read_workspace",
                "kory_status",
                "kory_picker_directory",
                "kory_place_window",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
