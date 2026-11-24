//! One confirmation flow for title-bar close, menus, tray quit and OS restart.
//!
//! Quit decisions are made by the shell, never by the webview. Every quit entry
//! point (tray, app menu, Cmd+Q, Dock or Apple-event quit) asks the backend how
//! many agents are running, then either quits at once or shows a native
//! confirmation that works while the window is hidden. The title-bar close with
//! agents running is the one case that still presents the in-app dialog (it
//! offers "Run in background"); when the webview does not acknowledge it within
//! a short window, the same choices appear as a native dialog instead.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

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

/// Where a close or quit came from. Only the title-bar close can present the
/// in-app dialog; every quit entry point is answered natively.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuitEntry {
    Tray,
    Menu,
    AppleEvent,
    WindowClose,
}

impl QuitEntry {
    fn is_window_close(self) -> bool {
        self == QuitEntry::WindowClose
    }
}

/// Agents the backend reports as executing. `runs` is the number of active
/// session runs; `agents` counts the agents those runs have in flight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RunningWork {
    pub runs: u32,
    pub agents: u32,
}

/// What a close or quit request is waiting on. `Checking` is held while the
/// backend is being asked, so a burst of Quit clicks produces one decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PendingQuit {
    Idle,
    Checking,
    NativeConfirm,
    InAppClose,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuitAction {
    QuitNow,
    NativeConfirm,
    PresentInApp,
    Ignore,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloseChoice {
    Background,
    Quit,
    Cancel,
}

/// Owner's preference: confirm before quitting while agents are running. No
/// persisted switch exists yet, so the policy is on; wire the real setting here.
pub(crate) const CONFIRM_QUIT_WHEN_AGENTS_RUN: bool = true;
/// Upper bound on the backend round trip. Past it the shell assumes nothing is
/// running, so an unreachable backend never blocks Quit.
const RUNNING_WORK_TIMEOUT: Duration = Duration::from_millis(1_500);
/// How long the webview gets to acknowledge an in-app close before the same
/// choices are shown natively.
const WEBVIEW_ACK_TIMEOUT: Duration = Duration::from_millis(2_500);
const QUIT_ANYWAY: &str = "Quit anyway";
const RUN_IN_BACKGROUND: &str = "Run in background";
const CANCEL: &str = "Cancel";

static PENDING: Mutex<Option<Request>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static EXIT_APPROVED: AtomicBool = AtomicBool::new(false);
static QUIT_STATE: Mutex<PendingQuit> = Mutex::new(PendingQuit::Idle);
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Id of the most recent close request the webview has acknowledged.
static ACKNOWLEDGED: AtomicU64 = AtomicU64::new(0);

pub(crate) fn exit_approved() -> bool {
    EXIT_APPROVED.load(Ordering::SeqCst)
}
pub(crate) fn approve_exit(approved: bool) {
    EXIT_APPROVED.store(approved, Ordering::SeqCst);
}

pub(crate) fn starts_in_background() -> bool {
    std::env::args_os().any(|arg| arg == "--background")
}

/// Pure quit policy. `pending` is what the shell is already doing for an
/// earlier request; `work` is only consulted when nothing is pending.
///
/// - A second quit while a confirmation is up quits (the user asked twice).
/// - A title-bar close while a confirmation is up is absorbed.
/// - With nothing running, or the setting off, every entry quits at once.
/// - Otherwise quit entries confirm natively and the title-bar close presents
///   the in-app dialog.
pub(crate) fn decide_quit(
    entry: QuitEntry,
    work: RunningWork,
    confirm_setting: bool,
    pending: PendingQuit,
) -> QuitAction {
    match pending {
        PendingQuit::Checking => QuitAction::Ignore,
        PendingQuit::NativeConfirm | PendingQuit::InAppClose if entry.is_window_close() => {
            QuitAction::Ignore
        }
        PendingQuit::NativeConfirm | PendingQuit::InAppClose => QuitAction::QuitNow,
        PendingQuit::Idle if work.runs == 0 || !confirm_setting => QuitAction::QuitNow,
        PendingQuit::Idle if entry.is_window_close() => QuitAction::PresentInApp,
        PendingQuit::Idle => QuitAction::NativeConfirm,
    }
}

/// Whether the webview has failed to take ownership of an in-app close in time.
pub(crate) fn needs_native_fallback(
    request_id: u64,
    acknowledged: u64,
    pending: Option<u64>,
    state: PendingQuit,
) -> bool {
    acknowledged != request_id && pending == Some(request_id) && state == PendingQuit::InAppClose
}

/// Maps the native close dialog's answer. The labels come back as custom
/// buttons, but the ordinal Yes/No forms are accepted too.
pub(crate) fn close_fallback_choice(result: &MessageDialogResult) -> CloseChoice {
    match result {
        MessageDialogResult::Yes => CloseChoice::Background,
        MessageDialogResult::No => CloseChoice::Quit,
        MessageDialogResult::Custom(label) if label == RUN_IN_BACKGROUND => CloseChoice::Background,
        MessageDialogResult::Custom(label) if label == QUIT_ANYWAY => CloseChoice::Quit,
        _ => CloseChoice::Cancel,
    }
}

/// Parses `GET /api/runs/active-count`. Anything malformed is `None`, and the
/// caller treats that the same as an unreachable backend.
pub(crate) fn parse_running_work(body: &serde_json::Value) -> Option<RunningWork> {
    let data = body.get("data")?;
    let runs = u32::try_from(data.get("runs")?.as_u64()?).ok()?;
    let agents = u32::try_from(data.get("agents")?.as_u64()?).ok()?;
    Some(RunningWork { runs, agents })
}

pub(crate) fn quit_confirm_message(work: RunningWork) -> String {
    let agents = work.agents.max(work.runs);
    let noun = if agents == 1 { "agent is" } else { "agents are" };
    format!(
        "{agents} {noun} still running. Quitting stops {}.",
        if agents == 1 { "it" } else { "them" }
    )
}

fn close_confirm_message(work: RunningWork) -> String {
    format!(
        "{} This window can stay open in the background instead.",
        quit_confirm_message(work)
    )
}

pub(crate) fn request(app: &AppHandle, reason: Reason) -> Request {
    let request = {
        let Ok(mut pending) = PENDING.lock() else {
            return Request { id: 0, reason };
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
    let _ = app.emit("desktop://exit-requested", request.clone());
    request
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

/// The webview calls this as soon as it has taken ownership of a close request.
#[tauri::command]
pub(crate) fn acknowledge_desktop_exit(id: u64) {
    ACKNOWLEDGED.store(id, Ordering::SeqCst);
}

fn valid_choice(reason: Reason, choice: Choice) -> Result<(), String> {
    if reason != Reason::Close && matches!(choice, Choice::Background) {
        return Err("Agents cannot run while the computer restarts or signs out.".into());
    }
    Ok(())
}

fn set_quit_state(state: PendingQuit) {
    if let Ok(mut current) = QUIT_STATE.lock() {
        *current = state;
    }
}

fn quit_state() -> PendingQuit {
    QUIT_STATE.lock().map(|state| *state).unwrap_or(PendingQuit::Idle)
}

/// Ends a close that was cancelled or sent to the background, so the next
/// quit is decided afresh.
fn finish_close(app: &AppHandle, id: u64) {
    set_quit_state(PendingQuit::Idle);
    if let Ok(mut pending) = PENDING.lock() {
        if pending.as_ref().is_some_and(|current| current.id == id) {
            *pending = None;
        }
    }
    let _ = app.emit("desktop://exit-cancelled", ());
}

/// Stops the background service and backend, then exits. Idempotent while an
/// exit is already underway; a failed service stop leaves the app running.
pub(crate) async fn quit_now(app: &AppHandle) -> Result<(), String> {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let stopped = if crate::config::uses_background_service() {
        tauri::async_runtime::spawn_blocking(crate::background_service::stop)
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result)
    } else {
        Ok(())
    };
    if let Err(error) = stopped {
        QUITTING.store(false, Ordering::SeqCst);
        return Err(error);
    }
    // Unload the OS job, rather than killing its child (KeepAlive would restart
    // it immediately). Login startup remains registered.
    crate::kill_backend();
    approve_exit(true);
    app.exit(0);
    Ok(())
}

fn report_quit_failure(app: &AppHandle, error: &str) {
    set_quit_state(PendingQuit::Idle);
    app.dialog()
        .message(format!(
            "Koryphaios could not stop its background service, so it is still running.\n\n{error}"
        ))
        .title("Quit Koryphaios")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn spawn_quit(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = quit_now(&app).await {
            report_quit_failure(&app, &error);
        }
    });
}

/// Parses the backend's count. Failure of any kind, including the 1.5 s cap,
/// reports nothing running: an unreachable backend must never block Quit.
async fn fetch_running_work(base_url: &str) -> RunningWork {
    match tokio::time::timeout(RUNNING_WORK_TIMEOUT, query_running_work(base_url)).await {
        Ok(Ok(work)) => work,
        Ok(Err(error)) => {
            eprintln!("[Koryphaios] Active-run check failed, quitting without it: {error}");
            RunningWork::default()
        }
        Err(_) => {
            eprintln!("[Koryphaios] Active-run check timed out, quitting without it");
            RunningWork::default()
        }
    }
}

async fn query_running_work(base_url: &str) -> Result<RunningWork, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    // The shell has no token of its own. A local peer mints a short-lived
    // session, the same way the desktop UI does on startup.
    let session: serde_json::Value = client
        .post(format!("{base_url}/api/auth/session"))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let token = session
        .pointer("/data/bearerToken")
        .and_then(|value| value.as_str())
        .ok_or("session response has no bearer token")?
        .to_string();
    let body: serde_json::Value = client
        .get(format!("{base_url}/api/runs/active-count"))
        .header(reqwest::header::AUTHORIZATION, token.as_str())
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let work = parse_running_work(&body).ok_or("unexpected active-count payload")?;
    // Revoke without holding up the decision; the session expires on its own anyway.
    let revoke_url = format!("{base_url}/api/auth/session");
    tauri::async_runtime::spawn(async move {
        let _ = client
            .delete(revoke_url)
            .header(reqwest::header::AUTHORIZATION, token)
            .send()
            .await;
    });
    Ok(work)
}

/// Entry point for every quit or close. It never blocks: the decision runs on
/// the async runtime, so AppKit and menu callbacks return immediately.
pub(crate) fn quit_requested(app: &AppHandle, entry: QuitEntry) {
    let claimed = {
        let Ok(mut state) = QUIT_STATE.lock() else {
            return;
        };
        let current = *state;
        if current == PendingQuit::Idle {
            *state = PendingQuit::Checking;
        }
        current
    };
    if claimed != PendingQuit::Idle {
        // A confirmation is already up or a check is running.
        match decide_quit(entry, RunningWork::default(), CONFIRM_QUIT_WHEN_AGENTS_RUN, claimed) {
            QuitAction::QuitNow => spawn_quit(app.clone()),
            _ => focus_main_window(app),
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let base_url = crate::config::AppConfig::get().backend_url();
        let work = fetch_running_work(&base_url).await;
        let action = decide_quit(entry, work, CONFIRM_QUIT_WHEN_AGENTS_RUN, PendingQuit::Idle);
        act(&app, action, work);
    });
}

fn act(app: &AppHandle, action: QuitAction, work: RunningWork) {
    match action {
        QuitAction::QuitNow => {
            set_quit_state(PendingQuit::Idle);
            spawn_quit(app.clone());
        }
        QuitAction::NativeConfirm => {
            set_quit_state(PendingQuit::NativeConfirm);
            confirm_quit_natively(app, work);
        }
        QuitAction::PresentInApp => {
            set_quit_state(PendingQuit::InAppClose);
            present_in_app_close(app, work);
        }
        QuitAction::Ignore => {
            set_quit_state(PendingQuit::Idle);
            focus_main_window(app);
        }
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn confirm_quit_natively(app: &AppHandle, work: RunningWork) {
    let app_for_answer = app.clone();
    app.dialog()
        .message(quit_confirm_message(work))
        .title("Quit Koryphaios?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            QUIT_ANYWAY.into(),
            CANCEL.into(),
        ))
        .show(move |quit| {
            if quit {
                spawn_quit(app_for_answer);
            } else {
                set_quit_state(PendingQuit::Idle);
            }
        });
}

fn present_in_app_close(app: &AppHandle, work: RunningWork) {
    let request = request(app, Reason::Close);
    if request.reason != Reason::Close {
        // An OS session request already owns the dialog; keep it.
        set_quit_state(PendingQuit::Idle);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WEBVIEW_ACK_TIMEOUT).await;
        let pending = PENDING
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|current| current.id));
        let acknowledged = ACKNOWLEDGED.load(Ordering::SeqCst);
        if needs_native_fallback(request.id, acknowledged, pending, quit_state()) {
            show_native_close_fallback(&app, request.id, work);
        }
    });
}

fn show_native_close_fallback(app: &AppHandle, request_id: u64, work: RunningWork) {
    set_quit_state(PendingQuit::NativeConfirm);
    let app_for_answer = app.clone();
    app.dialog()
        .message(close_confirm_message(work))
        .title("Close Koryphaios?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            RUN_IN_BACKGROUND.into(),
            QUIT_ANYWAY.into(),
            CANCEL.into(),
        ))
        .show_with_result(move |result| match close_fallback_choice(&result) {
            CloseChoice::Background => {
                finish_close(&app_for_answer, request_id);
                if let Some(window) = app_for_answer.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            CloseChoice::Quit => spawn_quit(app_for_answer),
            CloseChoice::Cancel => finish_close(&app_for_answer, request_id),
        });
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
            quit_now(&app).await?;
        }
        (Reason::Close, Choice::Cancel) => {}
        (_, Choice::Cancel) => crate::lifecycle_platform::reply_to_os(&app, false)?,
        (_, Choice::Proceed) => crate::lifecycle_platform::reply_to_os(&app, true)?,
        (_, Choice::Background) => unreachable!(),
    }
    if request.reason == Reason::Close {
        set_quit_state(PendingQuit::Idle);
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

    const ENTRIES: [QuitEntry; 4] = [
        QuitEntry::Tray,
        QuitEntry::Menu,
        QuitEntry::AppleEvent,
        QuitEntry::WindowClose,
    ];
    const PENDINGS: [PendingQuit; 4] = [
        PendingQuit::Idle,
        PendingQuit::Checking,
        PendingQuit::NativeConfirm,
        PendingQuit::InAppClose,
    ];
    fn busy() -> RunningWork {
        RunningWork { runs: 2, agents: 3 }
    }
    fn idle() -> RunningWork {
        RunningWork::default()
    }

    #[test]
    fn background_is_only_valid_when_closing_the_app() {
        assert!(valid_choice(Reason::Close, Choice::Background).is_ok());
        for reason in [Reason::Restart, Reason::Shutdown, Reason::Signout] {
            assert!(valid_choice(reason, Choice::Background).is_err());
            assert!(valid_choice(reason, Choice::Proceed).is_ok());
            assert!(valid_choice(reason, Choice::Cancel).is_ok());
        }
    }

    #[test]
    fn idle_or_disabled_quit_is_immediate_from_every_entry() {
        for entry in ENTRIES {
            for setting in [true, false] {
                assert_eq!(
                    decide_quit(entry, idle(), setting, PendingQuit::Idle),
                    QuitAction::QuitNow,
                    "{entry:?} with nothing running",
                );
            }
            assert_eq!(
                decide_quit(entry, busy(), false, PendingQuit::Idle),
                QuitAction::QuitNow,
                "{entry:?} with the setting off",
            );
        }
    }

    #[test]
    fn running_agents_confirm_natively_for_quit_and_in_app_for_close() {
        for entry in [QuitEntry::Tray, QuitEntry::Menu, QuitEntry::AppleEvent] {
            assert_eq!(
                decide_quit(entry, busy(), true, PendingQuit::Idle),
                QuitAction::NativeConfirm,
                "{entry:?}",
            );
        }
        assert_eq!(
            decide_quit(QuitEntry::WindowClose, busy(), true, PendingQuit::Idle),
            QuitAction::PresentInApp,
        );
    }

    #[test]
    fn a_second_quit_while_confirming_quits_and_a_second_close_is_absorbed() {
        for pending in [PendingQuit::NativeConfirm, PendingQuit::InAppClose] {
            for entry in [QuitEntry::Tray, QuitEntry::Menu, QuitEntry::AppleEvent] {
                assert_eq!(
                    decide_quit(entry, busy(), true, pending),
                    QuitAction::QuitNow,
                    "{entry:?} while {pending:?}",
                );
            }
            assert_eq!(
                decide_quit(QuitEntry::WindowClose, busy(), true, pending),
                QuitAction::Ignore,
            );
        }
    }

    #[test]
    fn a_burst_of_quits_during_the_backend_check_produces_one_decision() {
        for entry in ENTRIES {
            assert_eq!(
                decide_quit(entry, busy(), true, PendingQuit::Checking),
                QuitAction::Ignore,
                "{entry:?} while checking",
            );
        }
    }

    #[test]
    fn decision_table_covers_every_combination() {
        let mut seen = 0;
        for entry in ENTRIES {
            for work in [idle(), busy()] {
                for setting in [true, false] {
                    for pending in PENDINGS {
                        let action = decide_quit(entry, work, setting, pending);
                        let expected = match pending {
                            PendingQuit::Checking => QuitAction::Ignore,
                            PendingQuit::NativeConfirm | PendingQuit::InAppClose
                                if entry.is_window_close() =>
                            {
                                QuitAction::Ignore
                            }
                            PendingQuit::NativeConfirm | PendingQuit::InAppClose => {
                                QuitAction::QuitNow
                            }
                            PendingQuit::Idle if work.runs == 0 || !setting => QuitAction::QuitNow,
                            PendingQuit::Idle if entry.is_window_close() => {
                                QuitAction::PresentInApp
                            }
                            PendingQuit::Idle => QuitAction::NativeConfirm,
                        };
                        assert_eq!(action, expected, "{entry:?} {work:?} {setting} {pending:?}");
                        seen += 1;
                    }
                }
            }
        }
        assert_eq!(seen, 4 * 2 * 2 * 4);
    }

    #[test]
    fn running_work_parses_the_backend_payload_strictly() {
        let ok = serde_json::json!({ "ok": true, "data": { "runs": 2, "agents": 5 } });
        assert_eq!(
            parse_running_work(&ok),
            Some(RunningWork { runs: 2, agents: 5 })
        );
        assert_eq!(
            parse_running_work(&serde_json::json!({ "ok": false, "error": "Unauthorized" })),
            None,
        );
        assert_eq!(
            parse_running_work(&serde_json::json!({ "data": { "runs": "2", "agents": 1 } })),
            None,
        );
        assert_eq!(
            parse_running_work(&serde_json::json!({ "data": { "runs": -1, "agents": 1 } })),
            None,
        );
        assert_eq!(
            parse_running_work(&serde_json::json!({ "data": { "runs": 1 } })),
            None,
        );
    }

    #[test]
    fn confirmation_text_counts_agents_and_pluralizes() {
        assert_eq!(
            quit_confirm_message(RunningWork { runs: 1, agents: 1 }),
            "1 agent is still running. Quitting stops it."
        );
        assert_eq!(
            quit_confirm_message(RunningWork { runs: 2, agents: 4 }),
            "4 agents are still running. Quitting stops them."
        );
        // A run with no recorded agents still reports one.
        assert_eq!(
            quit_confirm_message(RunningWork { runs: 1, agents: 0 }),
            "1 agent is still running. Quitting stops it."
        );
    }

    #[test]
    fn native_close_fallback_maps_ordinal_and_custom_answers() {
        assert_eq!(
            close_fallback_choice(&MessageDialogResult::Custom(RUN_IN_BACKGROUND.into())),
            CloseChoice::Background,
        );
        assert_eq!(
            close_fallback_choice(&MessageDialogResult::Custom(QUIT_ANYWAY.into())),
            CloseChoice::Quit,
        );
        assert_eq!(close_fallback_choice(&MessageDialogResult::Yes), CloseChoice::Background);
        assert_eq!(close_fallback_choice(&MessageDialogResult::No), CloseChoice::Quit);
        assert_eq!(close_fallback_choice(&MessageDialogResult::Cancel), CloseChoice::Cancel);
        assert_eq!(
            close_fallback_choice(&MessageDialogResult::Custom("Something else".into())),
            CloseChoice::Cancel,
        );
    }

    #[test]
    fn native_fallback_only_when_the_webview_never_acknowledged_this_close() {
        let open = PendingQuit::InAppClose;
        // Not acknowledged, still ours, still in-app: fall back to native.
        assert!(needs_native_fallback(7, 0, Some(7), open));
        // The webview took it: no native dialog.
        assert!(!needs_native_fallback(7, 7, Some(7), open));
        // Resolved, replaced, or never ours: nothing to do.
        assert!(!needs_native_fallback(7, 0, None, open));
        assert!(!needs_native_fallback(7, 0, Some(8), open));
        assert!(!needs_native_fallback(7, 0, Some(7), PendingQuit::Idle));
        assert!(!needs_native_fallback(7, 0, Some(7), PendingQuit::NativeConfirm));
    }
}
