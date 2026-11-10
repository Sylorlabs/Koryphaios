//! One confirmation flow for title-bar close, menus, tray quit and OS restart.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Reason {
    Close,
    Restart,
    Shutdown,
    Signout,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct Request {
    pub id: u64,
    pub reason: Reason,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Choice {
    Background,
    Proceed,
    Cancel,
}

static PENDING: Mutex<Option<Request>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static EXIT_APPROVED: AtomicBool = AtomicBool::new(false);

pub(crate) fn exit_approved() -> bool {
    EXIT_APPROVED.load(Ordering::SeqCst)
}
pub(crate) fn approve_exit(approved: bool) {
    EXIT_APPROVED.store(approved, Ordering::SeqCst);
}

pub(crate) fn starts_in_background() -> bool {
    std::env::args_os().any(|arg| arg == "--background")
}

pub(crate) fn request(app: &AppHandle, reason: Reason) {
    let request = {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        if let Some(current) = pending.as_ref() {
            // Repeated close events share a dialog. An OS request supersedes a
            // close dialog so it cannot accidentally offer background execution.
            if current.reason != Reason::Close || reason == Reason::Close {
                current.clone()
            } else {
                let request = Request {
                    id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
                    reason,
                };
                *pending = Some(request.clone());
                request
            }
        } else {
            let request = Request {
                id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
                reason,
            };
            *pending = Some(request.clone());
            request
        }
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit("desktop://exit-requested", request);
}

#[cfg(target_os = "linux")]
pub(crate) fn clear_os_request(app: &AppHandle) {
    if let Ok(mut pending) = PENDING.lock() {
        if pending
            .as_ref()
            .is_some_and(|request| request.reason != Reason::Close)
        {
            *pending = None;
            let _ = app.emit("desktop://exit-cancelled", ());
        }
    }
}

#[tauri::command]
pub(crate) fn get_desktop_exit_request() -> Option<Request> {
    PENDING.lock().ok().and_then(|pending| pending.clone())
}

fn valid_choice(reason: Reason, choice: Choice) -> Result<(), String> {
    if reason != Reason::Close && matches!(choice, Choice::Background) {
        return Err("Agents cannot run while the computer restarts or signs out.".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn resolve_desktop_exit(
    app: AppHandle,
    id: u64,
    choice: Choice,
) -> Result<(), String> {
    let request = get_desktop_exit_request()
        .filter(|request| request.id == id)
        .ok_or("This close request is no longer active.")?;
    valid_choice(request.reason, choice)?;
    match (request.reason, choice) {
        (Reason::Close, Choice::Background) => {
            if let Some(window) = app.get_webview_window("main") {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
        (Reason::Close, Choice::Proceed) => {
            // Unload the OS job, rather than killing its child (KeepAlive would
            // restart it immediately). Login startup remains registered.
            if crate::config::uses_background_service() {
                tauri::async_runtime::spawn_blocking(crate::background_service::stop)
                    .await
                    .map_err(|error| error.to_string())??;
            }
            crate::kill_backend();
            approve_exit(true);
            app.exit(0);
        }
        (Reason::Close, Choice::Cancel) => {}
        (_, Choice::Cancel) => crate::lifecycle_platform::reply_to_os(&app, false)?,
        (_, Choice::Proceed) => crate::lifecycle_platform::reply_to_os(&app, true)?,
        (_, Choice::Background) => unreachable!(),
    }
    let mut pending = PENDING.lock().map_err(|error| error.to_string())?;
    if pending.as_ref().is_some_and(|current| current.id == id) {
        *pending = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_is_only_valid_when_closing_the_app() {
        assert!(valid_choice(Reason::Close, Choice::Background).is_ok());
        for reason in [Reason::Restart, Reason::Shutdown, Reason::Signout] {
            assert!(valid_choice(reason, Choice::Background).is_err());
            assert!(valid_choice(reason, Choice::Proceed).is_ok());
            assert!(valid_choice(reason, Choice::Cancel).is_ok());
        }
    }
}
