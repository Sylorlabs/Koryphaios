//! Native session-ending requests live here; a normal app quit is never
//! interpreted as permission to restart the computer.
use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::desktop_lifecycle::{self, Reason};
    use objc2::runtime::{AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use objc2_app_kit::NSApplication;
    use objc2_foundation::{MainThreadMarker, NSAppleEventManager};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static OS_PENDING: AtomicBool = AtomicBool::new(false);

    fn quit_reason(code: u32) -> Reason {
        match code {
            value if value == u32::from_be_bytes(*b"rest") => Reason::Restart,
            value if value == u32::from_be_bytes(*b"shut") => Reason::Shutdown,
            value if value == u32::from_be_bytes(*b"logo") => Reason::Signout,
            value if value == u32::from_be_bytes(*b"rlgo") => Reason::Signout,
            _ => Reason::Close,
        }
    }

    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: &NSApplication) -> usize {
        if desktop_lifecycle::exit_approved() {
            return 1;
        } // NSTerminateNow
        let reason = NSAppleEventManager::sharedAppleEventManager()
            .currentAppleEvent()
            .and_then(|event| unsafe {
                let descriptor: Option<
                    objc2::rc::Retained<objc2_foundation::NSAppleEventDescriptor>,
                > = msg_send![&event, paramDescriptorForKeyword: u32::from_be_bytes(*b"why?")];
                descriptor
            })
            .map(|descriptor| quit_reason(descriptor.enumCodeValue()))
            .unwrap_or(Reason::Close);
        if let Some(app) = APP.get() {
            OS_PENDING.store(reason != Reason::Close, Ordering::SeqCst);
            desktop_lifecycle::request(app, reason);
        }
        // AppKit waits for our reply without cancelling the original restart.
        // A normal quit is cancelled immediately and handled by our close UI.
        if reason == Reason::Close {
            0
        } else {
            2
        } // Cancel / Later
    }

    pub(super) fn install(app: &AppHandle) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("Session guard must install on the main thread")?;
        let application = NSApplication::sharedApplication(mtm);
        let delegate: Option<objc2::rc::Retained<AnyObject>> =
            unsafe { msg_send![&application, delegate] };
        let delegate = delegate.ok_or("Missing native application delegate")?;
        let mut class = ClassBuilder::new(c"KoryphaiosSessionDelegate", delegate.class())
            .ok_or("Cannot register the session delegate")?;
        unsafe {
            class.add_method(
                sel!(applicationShouldTerminate:),
                should_terminate as extern "C-unwind" fn(_, _, _) -> _,
            );
            // Same instance layout, no added ivars; existing Tauri delegate
            // methods and state remain inherited and untouched.
            AnyObject::set_class(&delegate, class.register());
        }
        let _ = APP.set(app.clone());
        Ok(())
    }

    pub(super) fn reply(app: &AppHandle, proceed: bool) -> Result<(), String> {
        if !OS_PENDING.load(Ordering::SeqCst) {
            return Err("No OS restart is pending.".into());
        }
        app.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                OS_PENDING.store(false, Ordering::SeqCst);
                if proceed {
                    desktop_lifecycle::approve_exit(true);
                }
                NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(proceed);
            }
        })
        .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn apple_event_quit_reason_distinguishes_restart_from_regular_quit() {
            assert_eq!(quit_reason(u32::from_be_bytes(*b"rest")), Reason::Restart);
            assert_eq!(quit_reason(u32::from_be_bytes(*b"shut")), Reason::Shutdown);
            assert_eq!(quit_reason(u32::from_be_bytes(*b"logo")), Reason::Signout);
            assert_eq!(quit_reason(u32::from_be_bytes(*b"quit")), Reason::Close);
        }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::UI::Controls::*;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    static SHOWING: AtomicBool = AtomicBool::new(false);

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    unsafe fn confirm_session_end(hwnd: HWND, signout: bool) -> bool {
        // QUERYENDSESSION provides no restart-vs-shutdown discriminator. Reply
        // to the original request; never cancel it and run shutdown.exe /r,
        // which could turn a user's shutdown into an unwanted reboot.
        let title = wide("Koryphaios");
        let heading = wide(if signout {
            "Sign out?"
        } else {
            "Restart or shut down computer?"
        });
        let content = wide("This will interrupt running agents. Continue anyway?");
        let proceed = wide(if signout {
            "Sign out anyway"
        } else {
            "Restart anyway"
        });
        let cancel = wide("Cancel");
        let buttons = [
            TASKDIALOG_BUTTON {
                nButtonID: 100,
                pszButtonText: proceed.as_ptr(),
            },
            TASKDIALOG_BUTTON {
                nButtonID: IDCANCEL,
                pszButtonText: cancel.as_ptr(),
            },
        ];
        let mut config: TASKDIALOGCONFIG = std::mem::zeroed();
        config.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
        config.hwndParent = hwnd;
        config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
        config.pszWindowTitle = title.as_ptr();
        config.pszMainInstruction = heading.as_ptr();
        config.pszContent = content.as_ptr();
        config.cButtons = buttons.len() as u32;
        config.pButtons = buttons.as_ptr();
        config.nDefaultButton = IDCANCEL;
        let mut selected = IDCANCEL;
        let result = TaskDialogIndirect(
            &config,
            &mut selected,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        result >= 0 && selected == 100
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        if message == WM_QUERYENDSESSION {
            if (lparam as u32 & ENDSESSION_CRITICAL) != 0 {
                return 1;
            }
            if SHOWING.swap(true, Ordering::SeqCst) {
                return 0;
            }
            // Windows needs a synchronous reply, so use its modal task dialog
            // with the same concise copy. The OS resumes/cancels its original
            // operation according to this result.
            let proceed = confirm_session_end(hwnd, lparam as u32 & ENDSESSION_LOGOFF != 0);
            SHOWING.store(false, Ordering::SeqCst);
            crate::desktop_lifecycle::approve_exit(proceed);
            return if proceed { 1 } else { 0 };
        }
        if message == WM_ENDSESSION && wparam == 0 {
            crate::desktop_lifecycle::approve_exit(false);
        }
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(window_proc), 1);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub(super) fn install(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or("Missing main window")?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        if unsafe { SetWindowSubclass(hwnd, Some(window_proc), 1, 0) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    pub(super) fn reply(_: &AppHandle, _: bool) -> Result<(), String> {
        Err("Windows session requests are answered by the native confirmation dialog.".into())
    }
}

#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use crate::desktop_lifecycle::{self, Reason};
    use glib::variant::ToVariant;
    use std::sync::Mutex;

    static CLIENT: Mutex<Option<(gio::DBusConnection, String)>> = Mutex::new(None);
    const MANAGER: &str = "org.gnome.SessionManager";
    const INTERFACE: &str = "org.gnome.SessionManager.ClientPrivate";

    pub(super) fn install(app: &AppHandle) -> Result<(), String> {
        let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
            .map_err(|e| e.to_string())?;
        let result = connection
            .call_sync(
                Some(MANAGER),
                "/org/gnome/SessionManager",
                MANAGER,
                "RegisterClient",
                Some(&("com.sylorlabs.koryphaios", "").to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                2_000,
                gio::Cancellable::NONE,
            )
            .map_err(|e| e.to_string())?;
        let path = result
            .child_value(0)
            .str()
            .ok_or("Missing session client path")?
            .to_string();
        let handle = app.clone();
        connection.signal_subscribe(
            Some(MANAGER),
            Some(INTERFACE),
            None,
            Some(&path),
            None,
            gio::DBusSignalFlags::NONE,
            move |connection, _, path, _, signal, _| {
                match signal {
                    "QueryEndSession" => {
                        desktop_lifecycle::request(&handle, Reason::Restart);
                        // A negative response creates an inhibitor in the desktop
                        // session's own restart flow while our user chooses.
                        let _ = connection.call_sync(
                            Some(MANAGER),
                            path,
                            INTERFACE,
                            "EndSessionResponse",
                            Some(&(false, "Koryphaios agents are running").to_variant()),
                            None,
                            gio::DBusCallFlags::NONE,
                            2_000,
                            gio::Cancellable::NONE,
                        );
                    }
                    "EndSession" => {
                        desktop_lifecycle::approve_exit(true);
                        let _ = connection.call_sync(
                            Some(MANAGER),
                            path,
                            INTERFACE,
                            "EndSessionResponse",
                            Some(&(true, "").to_variant()),
                            None,
                            gio::DBusCallFlags::NONE,
                            2_000,
                            gio::Cancellable::NONE,
                        );
                    }
                    "CancelEndSession" => {
                        desktop_lifecycle::approve_exit(false);
                        desktop_lifecycle::clear_os_request(&handle);
                    }
                    "Stop" => {
                        desktop_lifecycle::approve_exit(true);
                        handle.exit(0);
                    }
                    _ => {}
                }
            },
        );
        *CLIENT.lock().map_err(|e| e.to_string())? = Some((connection, path));
        Ok(())
    }

    pub(super) fn reply(_: &AppHandle, proceed: bool) -> Result<(), String> {
        let client = CLIENT.lock().map_err(|e| e.to_string())?;
        let (connection, path) = client
            .as_ref()
            .ok_or("No desktop session client is available.")?;
        connection
            .call_sync(
                Some(MANAGER),
                path,
                INTERFACE,
                "EndSessionResponse",
                Some(
                    &(
                        proceed,
                        if proceed {
                            ""
                        } else {
                            "Restart cancelled in Koryphaios"
                        },
                    )
                        .to_variant(),
                ),
                None,
                gio::DBusCallFlags::NONE,
                2_000,
                gio::Cancellable::NONE,
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub(crate) fn install(app: &AppHandle) -> Result<(), String> {
    native::install(app)
}
pub(crate) fn reply_to_os(app: &AppHandle, proceed: bool) -> Result<(), String> {
    native::reply(app, proceed)
}

/// Register the hidden desktop/tray session guard alongside the independent
/// backend. It is present after login even when no window has been opened.
pub(crate) fn enable_login_guard(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name("Koryphaios")
            .args(["--background"])
            .build(),
    )
    .map_err(|error| error.to_string())?;
    if !app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?
    {
        app.autolaunch()
            .enable()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
