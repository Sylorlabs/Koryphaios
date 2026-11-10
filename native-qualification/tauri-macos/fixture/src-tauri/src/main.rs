//! Packaged native Tauri fixture; intentionally independent from the Koryphaios app.
//! The external test driver operates the NSOpenPanel and WebView with OS input.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

struct Guard {
    approved_parent: PathBuf,
    state_file: PathBuf,
    log_file: PathBuf,
    selected: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickResult {
    outcome: &'static str,
    workspace_root: Option<String>,
}

impl Guard {
    fn from_environment() -> Result<Self, String> {
        let parent = env::var_os("KORY_V5_NATIVE_PARENT")
            .ok_or("KORY_V5_NATIVE_PARENT is required for the test fixture")?;
        let approved_parent =
            fs::canonicalize(parent).map_err(|e| format!("Invalid approved parent: {e}"))?;
        let state_file = PathBuf::from(
            env::var_os("KORY_V5_NATIVE_STATE").ok_or("KORY_V5_NATIVE_STATE missing")?,
        );
        let log_file =
            PathBuf::from(env::var_os("KORY_V5_NATIVE_LOG").ok_or("KORY_V5_NATIVE_LOG missing")?);
        let selected = fs::read_to_string(&state_file)
            .ok()
            .map(|content| PathBuf::from(content.trim()))
            .filter(|path| {
                fs::canonicalize(path)
                    .ok()
                    .is_some_and(|actual| actual == *path && actual.starts_with(&approved_parent))
            });
        Ok(Self {
            approved_parent,
            state_file,
            log_file,
            selected: Mutex::new(selected),
        })
    }

    fn log(&self, kind: &str, detail: Value) {
        let event = json!({
            "kind": kind,
            "pid": std::process::id(),
            "atMs": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            "detail": detail,
        });
        if let Ok(mut file) = OpenOptions::new().append(true).create(true).open(&self.log_file) {
            let _ = writeln!(file, "{}", event);
        }
    }

    fn snapshot(&self) -> Result<Option<PathBuf>, String> {
        let selected = self.selected.lock().map_err(|_| "Lock unavailable")?.clone();
        match selected {
            None => Ok(None),
            Some(root) => {
                let actual =
                    fs::canonicalize(&root).map_err(|_| "Previously selected root missing")?;
                if actual != root || !actual.starts_with(&self.approved_parent)
                    || actual == self.approved_parent
                {
                    return Err("Previously selected root no longer authorized".into());
                }
                Ok(Some(actual))
            }
        }
    }

    fn authorize_native_selection(&self, path: &Path) -> Result<PathBuf, String> {
        let root = fs::canonicalize(path).map_err(|_| "Chosen folder cannot be canonicalized")?;
        if root == self.approved_parent || !root.starts_with(&self.approved_parent) {
            return Err("Chosen folder is outside the test's sacrificial parent".into());
        }
        if !root.is_dir() {
            return Err("Chosen folder is not a directory".into());
        }
        // Persist before publishing the selection, for a genuine cold-start check.
        let tmp = self.state_file.with_extension("tmp");
        fs::write(&tmp, root.to_string_lossy().as_bytes())
            .map_err(|e| format!("Cannot persist selection: {e}"))?;
        fs::rename(&tmp, &self.state_file)
            .map_err(|e| format!("Cannot finish selection persistence: {e}"))?;
        *self.selected.lock().map_err(|_| "Lock unavailable")? = Some(root.clone());
        Ok(root)
    }

    fn read_relative(&self, candidate: &str) -> Result<String, String> {
        let relative = Path::new(candidate);
        if relative.as_os_str().is_empty() || relative.is_absolute()
            || relative.components().any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("Relative path invalid".into());
        }
        let root = self.snapshot()?.ok_or("No folder selected")?;
        let target =
            fs::canonicalize(root.join(relative)).map_err(|_| "Target path unavailable")?;
        if !target.starts_with(&root) || target == root {
            return Err("Target escapes the selected root".into());
        }
        // This exercises a symlink retarget *before* use. It is not a defense against
        // hostile concurrent renames between canonicalization and the actual open.
        fs::read_to_string(target).map_err(|e| format!("Read denied: {e}"))
    }
}

#[tauri::command]
async fn choose_workspace(
    app: tauri::AppHandle,
    state: State<'_, Arc<Guard>>,
) -> Result<PickResult, String> {
    let guard = Arc::clone(state.inner());
    guard.log("picker-open", json!({}));
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |selection| {
        let _ = tx.send(selection);
    });
    match rx.await.map_err(|_| "Native dialog unexpectedly disconnected")? {
        None => {
            guard.log("picker-cancel", json!({ "selection": null }));
            Ok(PickResult { outcome: "cancelled", workspace_root: None })
        }
        Some(selected) => {
            let path = selected.into_path().map_err(|e| format!("Native path unavailable: {e}"))?;
            match guard.authorize_native_selection(&path) {
                Ok(root) => {
                    guard.log("picker-select", json!({ "root": root }));
                    Ok(PickResult {
                        outcome: "selected",
                        workspace_root: Some(root.to_string_lossy().into_owned()),
                    })
                }
                Err(error) => {
                    guard.log("picker-denied", json!({ "error": error }));
                    Err(error)
                }
            }
        }
    }
}

#[tauri::command]
fn get_workspace(state: State<'_, Arc<Guard>>) -> Result<PickResult, String> {
    let selected = state.snapshot()?;
    state.log("state-query", json!({ "root": selected }));
    Ok(PickResult {
        outcome: if selected.is_some() { "restored" } else { "empty" },
        workspace_root: selected.map(|root| root.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
fn read_relative(relative: String, state: State<'_, Arc<Guard>>) -> Result<String, String> {
    let outcome = state.read_relative(&relative);
    state.log(
        "read",
        json!({
            "relative": relative,
            "outcome": if outcome.is_ok() { "allowed" } else { "denied" },
        }),
    );
    outcome
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let guard = Arc::new(Guard::from_environment().map_err(std::io::Error::other)?);
            guard.log(
                "startup",
                json!({ "selected": guard.snapshot().unwrap_or(None) }),
            );
            app.manage(guard);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![choose_workspace, get_workspace, read_relative])
        .run(tauri::generate_context!())
        .expect("Run packaged Tauri scenario");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_parent_and_symlink_escape() {
        let root = env::temp_dir().join(format!("kory-native-rust-{}", std::process::id()));
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(allowed.join("marker.txt"), "MARKER").unwrap();
        fs::write(outside.join("secret.txt"), "SECRET").unwrap();
        let guard = Guard {
            approved_parent: fs::canonicalize(&root).unwrap(),
            state_file: root.join("state"),
            log_file: root.join("log"),
            selected: Mutex::new(None),
        };
        assert!(guard.read_relative("marker.txt").is_err());
        guard.authorize_native_selection(&allowed).unwrap();
        assert_eq!(guard.read_relative("marker.txt").unwrap(), "MARKER");
        assert!(guard.read_relative("../outside/secret.txt").is_err());
        assert!(guard.read_relative(outside.to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, allowed.join("redirect")).unwrap();
            assert!(guard.read_relative("redirect/secret.txt").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
