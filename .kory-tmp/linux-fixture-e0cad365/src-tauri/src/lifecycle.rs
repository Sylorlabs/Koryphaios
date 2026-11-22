//! Window and process lifecycle for a single-window desktop app.
//!
//! Desktop conventions differ from a browser tab: closing the window is not quitting
//! the app, and re-activating the app must bring the same window back rather than
//! starting a second copy. Keeping that decision in one pure function makes the two
//! behaviours testable without a window server.

/// The lifecycle observations the app reacts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    /// The person asked the only window to close.
    CloseRequested,
    /// The app was activated again (for example from the Dock).
    Reopened { window_present: bool },
}

/// What the process should do in response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Keep the process running and take the window off screen.
    HideWindow,
    /// Bring the existing window back to the front.
    ShowWindow,
    /// Nothing is left to reveal, so the window has to be created again.
    CreateWindow,
}

impl Action {
    /// Whether the process should stay alive for this action.
    ///
    /// Every answer to a close or a re-open keeps the process running: there is deliberately no
    /// "quit" action, because closing a window is not quitting on the desktop. Spelling the match
    /// out means adding such an action later has to face this question rather than inherit `true`.
    pub fn keeps_process_alive(&self) -> bool {
        match self {
            Action::HideWindow | Action::ShowWindow | Action::CreateWindow => true,
        }
    }
}

/// Decide what closing a window or re-activating the app means.
pub fn action_for(event: Lifecycle) -> Action {
    match event {
        // Closing the window hides it; the process (and its single window) stays alive.
        Lifecycle::CloseRequested => Action::HideWindow,
        Lifecycle::Reopened {
            window_present: true,
        } => Action::ShowWindow,
        Lifecycle::Reopened {
            window_present: false,
        } => Action::CreateWindow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_window_never_terminates_the_app() {
        let action = action_for(Lifecycle::CloseRequested);
        assert_eq!(action, Action::HideWindow);
        // The check the native driver makes: the process is still there after the close.
        assert!(action.keeps_process_alive());
    }

    #[test]
    fn reopening_brings_the_same_window_back() {
        assert_eq!(
            action_for(Lifecycle::Reopened { window_present: true }),
            Action::ShowWindow
        );
    }

    #[test]
    fn reopening_without_a_window_recreates_it_instead_of_quitting() {
        assert_eq!(
            action_for(Lifecycle::Reopened { window_present: false }),
            Action::CreateWindow
        );
    }
}
