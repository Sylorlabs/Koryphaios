# Desktop background agents

The installed desktop backend runs as a background service for the signed-in
OS user. Open the updated Koryphaios installation once to register it. After
that, signing in starts the backend and a hidden desktop/tray session guard
automatically. Reopening the app reveals the existing window and connects to
the same backend, chats, credentials, and device identity.

## Closing and restarting

Closing the window, choosing Quit from the menu, or quitting from the tray
opens **Close Koryphaios?** with three choices:

- **Run in background** — hides the window; agents and linked devices remain
  available. The tray/session guard stays present for computer restart requests.
- **Quit anyway** — stops the backend for this user session and exits the app.
  Opening Koryphaios or signing in again starts it again.
- **Cancel** — keeps the app and agents running.

A computer restart request offers **Restart anyway** and **Cancel**, with the
message “This will interrupt running agents. Continue anyway?” There is no
background option during restart. macOS also uses matching short labels for
shutdown and sign-out. Dialogs initially focus Cancel, trap keyboard focus,
and use Escape to cancel. Failed actions stay open with a retryable error.

macOS defers the original AppKit session-ending request until the user replies.
Windows uses a native two-button task dialog because `WM_QUERYENDSESSION`
requires a synchronous response. Windows does not distinguish restart from
shutdown in that message; confirmation allows the **original** OS operation,
never substitutes a new reboot command. Linux integrates with the
`org.gnome.SessionManager` client protocol used by compatible desktop sessions;
the desktop's own session-end UI handles the inhibitor response. Other Linux
session managers and forced OS shutdowns may bypass this confirmation.

The session guard starts hidden at login and a manual launch focuses the
existing instance. The agent backend continues to be independently supervised
by the OS. Source development does not register login startup.

The computer must be **on, awake, signed in, and connected to the network** for
linked-device requests. Locking the screen is fine. Sleep, shutdown, and signing
out make it unavailable. Provider logins and incoming-agent grants still apply.

## OS integration

| OS      | Login service                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------- |
| macOS   | User LaunchAgent `com.sylorlabs.koryphaios.backend`                                                 |
| Linux   | systemd user unit `com.sylorlabs.koryphaios.backend.service`; requires a systemd user session       |
| Windows | Interactive-user scheduled task `com.sylorlabs.koryphaios.backend`, running a windowless supervisor |

The OS restarts the backend if it exits. This restores availability; it does
not guarantee an interrupted agent turn resumes after a crash.

Backend binaries, frontend resources, and logs are retained in the app's user
data directory, including after an AppImage mount disappears. Opening the same
build leaves running agent turns in place. Opening an updated build replaces
the service configuration and restarts the backend. Windows temporarily stops
the supervisor during installation so the installer can replace the executable.
Source development through `bun run dev` uses the development launcher.

## Stop background availability

Use the OS service manager to stop the backend explicitly:

```bash
# macOS
launchctl disable gui/$(id -u)/com.sylorlabs.koryphaios.backend
launchctl bootout gui/$(id -u)/com.sylorlabs.koryphaios.backend

# Linux
systemctl --user disable --now com.sylorlabs.koryphaios.backend.service
```

On Windows, disable and end `com.sylorlabs.koryphaios.backend` in Task Scheduler.
For a normal one-session stop, choose **Quit anyway**. To disable automatic
startup completely, also disable the Koryphaios desktop login item (the hidden
session guard). Opening Koryphaios registers and starts background availability
again.

## Verification

Automated tests check literal paths containing spaces, restart policies,
private manifest permissions, Windows login-task settings, and persistent port
discovery. Live macOS tests exercise a real LaunchAgent surviving its launcher
and restarting after termination, then start the compiled backend without Tauri
and verify its health endpoint before and after a forced process exit:

```bash
cargo test --lib background_service::tests::live_ -- --ignored --nocapture
```

Run from `desktop/src-tauri` after building the embedded backend. Set
`KORY_TEST_BACKEND` to test a different compiled backend. These tests create
temporary isolated jobs and data directories and remove them afterward.
Frontend tests cover close/restart options, native command delivery, duplicate
clicks, request replacement, focus trapping, cancellation and errors. Rust tests
cover allowed choices and macOS restart-vs-quit reason codes. Real OS restart
and Windows/Linux session-ending integration require native-host verification.
