//! The workspace authority: the one folder a person picked in the native dialog.
//!
//! The webview never sends a path back. The privileged side keeps the folder the
//! picker returned, canonicalised once, and re-checks that canonical root at every
//! use. Re-checking matters because the directory can be replaced by a link to
//! somewhere else between the moment it was chosen and the moment it is read.

use std::fs;
use std::path::{Path, PathBuf};

/// The file a workspace read exposes to the webview.
pub const WORKSPACE_FILE: &str = "workspace.txt";

/// What the status region shows when nothing has been chosen, and what a read
/// answers in that state. It is the canonical empty state, never a home directory.
pub const EMPTY_STATE: &str = "No folder selected";

const UNAVAILABLE: &str = "The selected folder is no longer available; choose it again";
const REPLACED: &str = "The selected folder was replaced after it was chosen; choose it again";

/// The typed answer to a folder pick.
///
/// A dismissal is `Cancelled`, which carries no path at all. That is deliberately
/// different from `Selected` with an empty string, so an empty value can never be
/// mistaken for "read the current user's home directory".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkspaceSelection {
    /// The person chose this folder. `root` is already canonical.
    Selected { root: String },
    /// The person dismissed the picker. Nothing is selected afterwards.
    Cancelled,
}

/// The folder the picker answered with, canonicalised at selection time.
#[derive(Debug, Default)]
pub struct WorkspaceRoot(std::sync::Mutex<Option<PathBuf>>);

impl WorkspaceRoot {
    /// Remember a canonical folder as the only readable root.
    pub fn select(&self, root: PathBuf) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(root);
        }
    }

    /// Forget the selection. Used for a typed cancellation, so a dismissed
    /// dialog cannot leave an earlier folder authoritative.
    pub fn clear(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }

    /// The recorded canonical root, if any.
    pub fn current(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

/// Resolve a folder the picker returned into the canonical root we will enforce.
pub fn canonical_root(path: &Path) -> Result<PathBuf, String> {
    let resolved =
        fs::canonicalize(path).map_err(|err| format!("Cannot open the chosen folder: {err}"))?;
    if !resolved.is_dir() {
        return Err("The chosen path is not a folder".to_string());
    }
    Ok(resolved)
}

/// Read `workspace.txt` under a previously recorded root, enforcing that root now.
///
/// The check has three parts, and all of them run at use time rather than at
/// selection time:
///
/// * the recorded root must still canonicalise to itself, so a directory swapped
///   for a link to another directory is refused instead of followed;
/// * the file must canonicalise to a direct child of that root, so a link placed
///   *inside* the folder cannot reach out of it;
/// * the file must be a regular file, so a named pipe or directory is not read.
pub fn read_confined(recorded: Option<PathBuf>) -> Result<String, String> {
    let recorded = recorded.ok_or_else(|| EMPTY_STATE.to_string())?;

    let resolved_root = fs::canonicalize(&recorded).map_err(|_| UNAVAILABLE.to_string())?;
    if resolved_root != recorded {
        return Err(REPLACED.to_string());
    }

    let resolved_file = fs::canonicalize(resolved_root.join(WORKSPACE_FILE))
        .map_err(|_| format!("{WORKSPACE_FILE} is missing from the selected folder"))?;
    if resolved_file.parent() != Some(resolved_root.as_path()) {
        return Err(format!("{WORKSPACE_FILE} resolves outside the selected folder"));
    }
    let is_file = fs::metadata(&resolved_file).map(|meta| meta.is_file()).unwrap_or(false);
    if !is_file {
        return Err(format!("{WORKSPACE_FILE} is not a regular file"));
    }

    let text = fs::read_to_string(&resolved_file)
        .map_err(|err| format!("Cannot read {}: {err}", resolved_file.display()))?;
    Ok(text.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("kory-workspace-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("scratch directory");
        root
    }

    fn write_workspace(directory: &Path, contents: &str) {
        fs::create_dir_all(directory).expect("workspace directory");
        fs::write(directory.join(WORKSPACE_FILE), contents).expect("workspace file");
    }

    #[test]
    fn cancellation_is_typed_and_leaves_no_root() {
        let sandbox = scratch("cancel");
        let inside = sandbox.join("inside");
        write_workspace(&inside, "contained workspace fixture\n");

        let state = WorkspaceRoot::default();
        state.select(canonical_root(&inside).expect("canonical root"));
        assert_eq!(
            read_confined(state.current()),
            Ok("contained workspace fixture".to_string())
        );

        // A dismissal is a distinct value, and it carries no path to misinterpret.
        assert_eq!(
            serde_json::to_value(WorkspaceSelection::Cancelled).unwrap(),
            serde_json::json!({ "status": "cancelled" })
        );
        assert_eq!(
            serde_json::to_value(WorkspaceSelection::Selected { root: "/tmp/example".into() })
                .unwrap(),
            serde_json::json!({ "status": "selected", "root": "/tmp/example" })
        );

        // Cancelling clears the authority instead of storing "".
        state.clear();
        assert_eq!(state.current(), None);
        assert_eq!(read_confined(state.current()), Err(EMPTY_STATE.to_string()));
        // The empty state is never a home directory, so nothing was read.
        assert!(!read_confined(None).unwrap_or_default().contains("workspace fixture"));

        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn selected_folder_replaced_by_a_link_is_refused() {
        let sandbox = scratch("swap");
        let inside = sandbox.join("inside");
        let outside = sandbox.join("outside");
        let parked = sandbox.join("inside-parked");
        write_workspace(&inside, "contained workspace fixture\n");
        write_workspace(&outside, "ESCAPED WORKSPACE: MUST NEVER READ\n");

        let state = WorkspaceRoot::default();
        state.select(canonical_root(&inside).expect("canonical root"));
        assert_eq!(
            read_confined(state.current()),
            Ok("contained workspace fixture".to_string())
        );

        // The exact swap the native driver performs: the chosen directory is moved
        // aside and a link to another directory takes its place.
        fs::rename(&inside, &parked).expect("park the chosen folder");
        symlink(&outside, &inside).expect("retarget the chosen folder");

        let refused = read_confined(state.current());
        assert!(refused.is_err(), "a replaced root must not be followed: {refused:?}");
        assert!(!refused.unwrap_or_default().contains("ESCAPED WORKSPACE"));

        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn link_inside_the_folder_cannot_reach_out_of_it() {
        let sandbox = scratch("file-link");
        let inside = sandbox.join("inside");
        let outside = sandbox.join("outside");
        write_workspace(&inside, "contained workspace fixture\n");
        write_workspace(&outside, "ESCAPED WORKSPACE: MUST NEVER READ\n");

        let state = WorkspaceRoot::default();
        state.select(canonical_root(&inside).expect("canonical root"));

        fs::remove_file(inside.join(WORKSPACE_FILE)).expect("drop the contained file");
        symlink(outside.join(WORKSPACE_FILE), inside.join(WORKSPACE_FILE)).expect("file link");

        let refused = read_confined(state.current());
        assert!(refused.is_err(), "a linked file must not escape the root: {refused:?}");
        assert!(refused.unwrap_or_default().is_empty());

        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn restart_starts_from_the_canonical_empty_state() {
        let first = WorkspaceRoot::default();
        first.select(PathBuf::from("/tmp/whatever-was-chosen"));
        assert!(first.current().is_some());

        // A relaunch builds fresh state. Nothing about the selection is persisted
        // between processes, so the window comes back empty.
        let relaunched = WorkspaceRoot::default();
        assert_eq!(relaunched.current(), None);
        assert_eq!(read_confined(relaunched.current()), Err(EMPTY_STATE.to_string()));

        // And the same is true of a cleared root within one process.
        first.clear();
        assert_eq!(read_confined(first.current()), Err(EMPTY_STATE.to_string()));
    }
}
