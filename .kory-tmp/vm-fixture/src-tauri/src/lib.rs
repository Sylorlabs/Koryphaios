
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

// A verification channel the harness reads from outside the webview. It exists so the native
// driver can observe the same state the person sees, and ask the app to open its own dialog,
// without requiring Apple Events or Accessibility from inside a sandboxed run.
#[tauri::command]
fn kory_status(text: String) {
    if let Ok(root) = std::env::var("KORY_FIXTURE_ROOT") {
        let _ = fs::write(PathBuf::from(root).join(".kory-status"), text);
    }
}

// The harness may evaluate on a display with no physical output, so the window is placed where it
// is asked to go. A window on the operator's screen is not acceptable for an automated pass: the
// placement travels with the launch, which keeps the first frame off that screen too.
fn fixture_position() -> (i32, i32) {
    if let Ok(raw) = std::env::var("KORY_FIXTURE_POSITION") {
        let parts: Vec<i32> = raw.split(',').filter_map(|part| part.trim().parse().ok()).collect();
        if parts.len() == 2 {
            return (parts[0], parts[1]);
        }
    }
    (160, 160)
}

#[tauri::command]
fn kory_place_window(window: tauri::WebviewWindow) {
    let (x, y) = fixture_position();
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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
        let Ok(root) = std::env::var("KORY_FIXTURE_ROOT") else { return };
        let path = PathBuf::from(root).join(".kory-control.json");
        let mut last = String::new();
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

// Intentional defect: the command trusts a path chosen earlier by the webview.
#[tauri::command]
fn read_workspace(path: String) -> Result<String, String> {
    let root = if path.is_empty() {
        std::env::var("HOME").unwrap_or_default() // Cancel becomes privileged home.
    } else { path };
    std::fs::read_to_string(PathBuf::from(root).join("workspace.txt"))
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn choose_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, PickerDirectory>,
) -> Result<String, String> {
    // This is a REAL native folder picker; it must return a typed cancellation.
    let mut dialog = app.dialog().file();
    if let Some(directory) = state.0.lock().ok().and_then(|current| current.clone()) {
        dialog = dialog.set_directory(&directory);
    }
    Ok(dialog.blocking_pick_folder()
        .map(|selection| selection.to_string()).unwrap_or_default())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PickerDirectory(std::sync::Mutex::new(None)))
        .setup(|app| {
            spawn_control(app.handle().clone());
            // The driver needs a window that is on screen and capturable. A restored position
            // from an earlier session can leave it off the only display, so place it here.
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let (x, y) = fixture_position();
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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
        .run(tauri::generate_context!())
        .expect("Tauri native runtime failed");
}
