mod lifecycle;
mod workspace;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Manager, Emitter};
use tauri_plugin_dialog::DialogExt;
use workspace::{WorkspaceRoot, WorkspaceSelection};

// A verification channel the harness reads from outside the webview. It exists so the native
// driver can observe the same state the person sees, and ask the app to open its own dialog,
// without requiring Apple Events or Accessibility from inside a sandboxed run.
fn fixture_root() -> Option<&'static PathBuf> {
    static ROOT: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        // The harness names the fixture explicitly, which is the authority when it is present.
        if let Ok(root) = std::env::var("KORY_FIXTURE_ROOT") {
            let path = PathBuf::from(root);
            if path.is_dir() {
                return Some(path);
            }
        }
        // LaunchServices does not promise a launching shell's environment to the app, so a bundle
        // that reports nothing would be scored as refusing to answer. The bundle still sits at a
        // fixed place inside the fixture, and the directory holding `src-tauri` is the fixture.
        std::env::current_exe()
            .ok()?
            .ancestors()
            .find(|directory| directory.join("src-tauri").is_dir())
            .map(PathBuf::from)
    })
    .as_ref()
}

#[tauri::command]
fn kory_status(text: String) {
    if let Some(root) = fixture_root() {
        let _ = fs::write(root.join(".kory-status"), text);
    }
}

// A window that lands outside the only display cannot be captured, so the harness may ask for it
// again. The placement is the application's own window operation, not a window server trick.
#[tauri::command]
fn kory_place_window(window: tauri::WebviewWindow) {
    let _ = window.set_position(tauri::PhysicalPosition::new(160, 160));
    let _ = window.show();
    let _ = window.set_focus();
}

// The picker opens where the harness asks it to, so a person-shaped Return is enough to choose
// that folder. The dialog is still the system one and still returns its own answer.
#[tauri::command]
fn kory_picker_directory(state: tauri::State<'_, PickerDirectory>, path: String) {
    if let Ok(mut current) = state.0.lock() {
        *current = Some(path);
    }
}

struct PickerDirectory(std::sync::Mutex<Option<String>>);

fn spawn_control(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let Some(root) = fixture_root() else { return };
        let path = root.join(".kory-control.json");
        // Start from whatever the file already says, so a request left behind by an earlier
        // session is not replayed against this one as if the harness had just asked for it.
        let mut last = fs::read_to_string(&path).unwrap_or_default();
        loop {
            std::thread::sleep(Duration::from_millis(120));
            if let Ok(text) = fs::read_to_string(&path) {
                if text != last {
                    last = text.clone();
                    let _ = app.emit("kory-control", text);
                }
            }
        }
    });
}

// The webview asks for the selected folder's file and gets either its text or a typed refusal.
// It cannot name a path: the only root that exists is the one the picker returned, canonicalised
// when it was chosen, and re-validated here before anything is opened.
#[tauri::command]
fn read_workspace(workspace: tauri::State<'_, WorkspaceRoot>) -> Result<String, String> {
    workspace::read_confined(workspace.current())
}

// A real native folder picker. Dismissing it is a distinct answer, not an empty path: an empty
// string used to fall through to the user's home directory on read. The chosen folder is
// canonicalised before it becomes the root, so later link swaps can be detected at use time.
#[tauri::command]
async fn choose_workspace(
    window: tauri::WebviewWindow,
    workspace: tauri::State<'_, WorkspaceRoot>,
    picker: tauri::State<'_, PickerDirectory>,
) -> Result<WorkspaceSelection, String> {
    // The panel is parented to this window so it arrives as a sheet of the window the person is
    // looking at, not as a floating window they have to find.
    let mut dialog = window.dialog().file().set_parent(&window);
    let starting = picker
        .0
        .lock()
        .ok()
        .and_then(|current| current.clone())
        .or_else(|| {
            workspace
                .current()
                .map(|root| root.to_string_lossy().into_owned())
        });
    if let Some(directory) = starting {
        dialog = dialog.set_directory(&directory);
    }

    // The answer arrives through a channel instead of blocking the async worker that is running
    // this command: a person may take a long time to decide, and the rest of the app must keep
    // working while the sheet is up.
    let (sender, mut answer) = tauri::async_runtime::channel(1);
    dialog.pick_folder(move |selection| {
        let _ = sender.try_send(selection);
    });
    let selection = answer
        .recv()
        .await
        .ok_or_else(|| "The folder picker closed without an answer".to_string())?;

    match selection {
        Some(selection) => {
            let chosen = selection
                .into_path()
                .map_err(|err| format!("The picker returned no usable folder: {err}"))?;
            let root = workspace::canonical_root(&chosen)?;
            workspace.select(root.clone());
            Ok(WorkspaceSelection::Selected {
                root: root.to_string_lossy().into_owned(),
            })
        }
        None => {
            // Typed cancellation carries no path, and it also drops any earlier root so a
            // dismissed dialog can never leave a folder authoritative.
            workspace.clear();
            Ok(WorkspaceSelection::Cancelled)
        }
    }
}

/// Bring the single window back, re-creating it if it was ever destroyed. Used when the person
/// reopens the app from the Dock after closing its window.
fn reveal_main_window(app: &tauri::AppHandle) {
    match lifecycle::action_for(lifecycle::Lifecycle::Reopened {
        window_present: app.get_webview_window("main").is_some(),
    }) {
        lifecycle::Action::ShowWindow => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        lifecycle::Action::CreateWindow => {
            // The window was destroyed rather than hidden, so put the same single window back
            // instead of leaving a running app with no way to reach it.
            if let Ok(window) = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Native Workspace Fixture")
            .inner_size(640.0, 420.0)
            .position(160.0, 160.0)
            .build()
            {
                let _ = window.set_focus();
            }
        }
        lifecycle::Action::HideWindow => {}
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PickerDirectory(std::sync::Mutex::new(None)))
        .manage(WorkspaceRoot::default())
        .setup(|app| {
            spawn_control(app.handle().clone());
            // The driver needs a window that is on screen and capturable. A restored position
            // from an earlier session can leave it off the only display, so place it here.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_position(tauri::PhysicalPosition::new(160, 160));
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_workspace,
            choose_workspace,
            kory_status,
            kory_picker_directory,
            kory_place_window
        ])
        .build(tauri::generate_context!())
        .expect("Tauri native runtime failed");

    app.run(|handle, event| match event {
        // Closing the only window is not quitting the app on the desktop. The window is hidden
        // and stays alive, so the process keeps its identity until the person really quits.
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            let action = lifecycle::action_for(lifecycle::Lifecycle::CloseRequested);
            if action.keeps_process_alive() {
                // Hide instead of destroy, so the window this process owns is still there to
                // reveal when the person comes back.
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        }
        // Reopening the app reveals the window again. The in-memory selection survives this,
        // because it is the same process; only a relaunch starts from the empty state.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => reveal_main_window(handle),
        _ => {}
    });
}
