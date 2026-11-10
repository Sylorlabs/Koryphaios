//! Scenario 2 host-boundary contract model, using only the Rust standard library.
//! These are host filesystem tests; this file is NOT a Tauri app or a device driver.
//! A production command must also secure opens against concurrent directory swaps
//! (for example using handle-relative OS APIs) and enforce window capabilities.

use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogChoice {
    Cancelled,
    Selected(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChoiceOutcome {
    Cancelled,
    Selected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundaryError {
    NoWorkspace,
    InvalidSelection,
    RootChanged,
    InvalidRelativePath,
    OutsideWorkspace,
    MissingOrUnreadablePath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedWorkspace {
    // Both fields belong to the privileged host. The renderer cannot set the pin.
    selected_path: PathBuf,
    canonical_root: PathBuf,
}

#[derive(Debug, Default)]
pub struct WorkspaceGuard {
    pinned: Option<PinnedWorkspace>,
}

impl WorkspaceGuard {
    pub fn choose(&mut self, choice: DialogChoice) -> Result<ChoiceOutcome, BoundaryError> {
        match choice {
            DialogChoice::Cancelled => Ok(ChoiceOutcome::Cancelled),
            DialogChoice::Selected(selected_path) => {
                if !selected_path.is_absolute() || selected_path.as_os_str().is_empty() {
                    return Err(BoundaryError::InvalidSelection);
                }
                let canonical_root = fs::canonicalize(&selected_path)
                    .map_err(|_| BoundaryError::InvalidSelection)?;
                if !canonical_root.is_dir() {
                    return Err(BoundaryError::InvalidSelection);
                }
                self.pinned = Some(PinnedWorkspace {
                    selected_path,
                    canonical_root,
                });
                Ok(ChoiceOutcome::Selected)
            }
        }
    }

    pub fn snapshot_for_persistence(&self) -> Option<PinnedWorkspace> {
        self.pinned.clone()
    }

    // Called after a cold start with host-owned persisted state, before any read.
    pub fn restore(&mut self, snapshot: PinnedWorkspace) -> Result<(), BoundaryError> {
        let current =
            fs::canonicalize(&snapshot.selected_path).map_err(|_| BoundaryError::RootChanged)?;
        if current != snapshot.canonical_root || !current.is_dir() {
            return Err(BoundaryError::RootChanged);
        }
        self.pinned = Some(snapshot);
        Ok(())
    }

    pub fn read_relative(&self, requested: &Path) -> Result<Vec<u8>, BoundaryError> {
        let pinned = self.pinned.as_ref().ok_or(BoundaryError::NoWorkspace)?;

        // The selected root itself could be a symlink retargeted after selection.
        let current_root =
            fs::canonicalize(&pinned.selected_path).map_err(|_| BoundaryError::RootChanged)?;
        if current_root != pinned.canonical_root || !current_root.is_dir() {
            return Err(BoundaryError::RootChanged);
        }

        // Never accept an absolute path, '..', '.', or an empty path from a webview.
        if requested.as_os_str().is_empty()
            || !requested
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err(BoundaryError::InvalidRelativePath);
        }

        // Resolve at *use time*; do not cache a selected child symlink's target.
        let candidate = fs::canonicalize(current_root.join(requested))
            .map_err(|_| BoundaryError::MissingOrUnreadablePath)?;
        if candidate == pinned.canonical_root || !candidate.starts_with(&pinned.canonical_root) {
            return Err(BoundaryError::OutsideWorkspace);
        }

        // Use the resolved path, never the unchecked renderer path or symlink alias.
        // This contract model still cannot prove safety against a simultaneous rename
        // of a canonical ancestor during open; native integration must pin handles.
        fs::read(candidate).map_err(|_| BoundaryError::MissingOrUnreadablePath)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDirs(PathBuf);

    impl TestDirs {
        fn new() -> Self {
            let tick = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "kory-tauri-boundary-{}-{}-{}",
                std::process::id(),
                tick,
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }

        fn dir(&self, name: &str) -> PathBuf {
            let dir = self.0.join(name);
            fs::create_dir(&dir).unwrap();
            dir
        }
    }

    impl Drop for TestDirs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn chosen(path: PathBuf) -> WorkspaceGuard {
        let mut guard = WorkspaceGuard::default();
        assert_eq!(
            guard.choose(DialogChoice::Selected(path)),
            Ok(ChoiceOutcome::Selected)
        );
        guard
    }

    #[test]
    fn cancelled_initial_dialog_never_selects_home() {
        let guard = {
            let mut guard = WorkspaceGuard::default();
            assert_eq!(
                guard.choose(DialogChoice::Cancelled),
                Ok(ChoiceOutcome::Cancelled)
            );
            guard
        };
        assert_eq!(guard.snapshot_for_persistence(), None);
        assert_eq!(
            guard.read_relative(Path::new("private.txt")),
            Err(BoundaryError::NoWorkspace)
        );
    }

    #[test]
    fn reopening_and_cancelling_retains_only_explicit_selection() {
        let dirs = TestDirs::new();
        let first = dirs.dir("first");
        let second = dirs.dir("second");
        fs::write(first.join("data.txt"), b"first").unwrap();
        fs::write(second.join("data.txt"), b"second").unwrap();
        let mut guard = chosen(first);
        assert_eq!(
            guard.choose(DialogChoice::Cancelled),
            Ok(ChoiceOutcome::Cancelled)
        );
        assert_eq!(
            guard.read_relative(Path::new("data.txt")),
            Ok(b"first".to_vec())
        );
        assert_eq!(
            guard.choose(DialogChoice::Selected(second)),
            Ok(ChoiceOutcome::Selected)
        );
        assert_eq!(
            guard.read_relative(Path::new("data.txt")),
            Ok(b"second".to_vec())
        );
    }

    #[test]
    fn invalid_dialog_selection_never_changes_authority() {
        let dirs = TestDirs::new();
        let root = dirs.dir("root");
        let mut guard = chosen(root);
        let original = guard.snapshot_for_persistence();
        assert_eq!(
            guard.choose(DialogChoice::Selected(PathBuf::from(""))),
            Err(BoundaryError::InvalidSelection)
        );
        assert_eq!(
            guard.choose(DialogChoice::Selected(PathBuf::from("relative"))),
            Err(BoundaryError::InvalidSelection)
        );
        assert_eq!(guard.snapshot_for_persistence(), original);
    }

    #[test]
    fn rejects_absolute_paths_and_parent_traversal() {
        let dirs = TestDirs::new();
        let root = dirs.dir("root");
        let outside = dirs.dir("outside");
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        let guard = chosen(root);
        for path in [
            outside.join("secret.txt"),
            PathBuf::from("../outside/secret.txt"),
            PathBuf::from("./safe.txt"),
            PathBuf::new(),
        ] {
            assert_eq!(
                guard.read_relative(&path),
                Err(BoundaryError::InvalidRelativePath)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn retargeted_child_symlink_is_denied_at_use_time() {
        use std::os::unix::fs::symlink;
        let dirs = TestDirs::new();
        let root = dirs.dir("root");
        let inside = dirs.dir("inside");
        let outside = dirs.dir("outside");
        fs::write(inside.join("document.txt"), b"inside").unwrap();
        fs::write(outside.join("document.txt"), b"secret").unwrap();
        // Keep the initially authorized target beneath the chosen root.
        fs::rename(&inside, root.join("inside")).unwrap();
        let link = root.join("alias");
        symlink(root.join("inside"), &link).unwrap();
        let guard = chosen(root);
        assert_eq!(
            guard.read_relative(Path::new("alias/document.txt")),
            Ok(b"inside".to_vec())
        );

        fs::remove_file(&link).unwrap();
        symlink(&outside, &link).unwrap();
        assert_eq!(
            guard.read_relative(Path::new("alias/document.txt")),
            Err(BoundaryError::OutsideWorkspace)
        );
    }

    #[cfg(unix)]
    #[test]
    fn retargeted_selected_root_is_denied_before_read() {
        use std::os::unix::fs::symlink;
        let dirs = TestDirs::new();
        let first = dirs.dir("first");
        let outside = dirs.dir("outside");
        fs::write(first.join("readme.txt"), b"safe").unwrap();
        fs::write(outside.join("readme.txt"), b"secret").unwrap();
        let alias = dirs.0.join("choice");
        symlink(&first, &alias).unwrap();
        let guard = chosen(alias.clone());
        assert_eq!(
            guard.read_relative(Path::new("readme.txt")),
            Ok(b"safe".to_vec())
        );

        fs::remove_file(&alias).unwrap();
        symlink(&outside, &alias).unwrap();
        assert_eq!(
            guard.read_relative(Path::new("readme.txt")),
            Err(BoundaryError::RootChanged)
        );
    }

    #[cfg(unix)]
    #[test]
    fn simulated_cold_start_requires_revalidation_of_persisted_pin() {
        use std::os::unix::fs::symlink;
        let dirs = TestDirs::new();
        let root = dirs.dir("root");
        let outside = dirs.dir("outside");
        fs::write(root.join("data.txt"), b"safe").unwrap();
        fs::write(outside.join("data.txt"), b"secret").unwrap();
        let alias = dirs.0.join("selection");
        symlink(&root, &alias).unwrap();

        // This tests state reconstruction only; no native app was restarted.
        let before_restart = chosen(alias.clone());
        let saved_host_state = before_restart.snapshot_for_persistence().unwrap();
        let mut after_restart = WorkspaceGuard::default();
        assert_eq!(
            after_restart.read_relative(Path::new("data.txt")),
            Err(BoundaryError::NoWorkspace)
        );
        assert_eq!(after_restart.restore(saved_host_state.clone()), Ok(()));
        assert_eq!(
            after_restart.read_relative(Path::new("data.txt")),
            Ok(b"safe".to_vec())
        );

        fs::remove_file(&alias).unwrap();
        symlink(&outside, &alias).unwrap();
        let mut next_restart = WorkspaceGuard::default();
        assert_eq!(
            next_restart.restore(saved_host_state),
            Err(BoundaryError::RootChanged)
        );
        assert_eq!(
            next_restart.read_relative(Path::new("data.txt")),
            Err(BoundaryError::NoWorkspace)
        );
    }
}
