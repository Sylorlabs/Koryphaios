use std::io::Read;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSScreen, NSWindow, NSWindowStyleMask};
#[cfg(target_os = "macos")]
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

// Cached updater so install_update doesn't re-fetch the manifest every click.
// tauri_plugin_updater::Update is not Clone, so we hold it behind a Mutex.
static CACHED_UPDATE: Mutex<Option<tauri_plugin_updater::Update>> = Mutex::new(None);

// Download timeout: 137 MB at 1 Mbps takes roughly 18 minutes; allow 30
// minutes while still preventing a stalled download from hanging forever
// (tauri-plugin-updater hardcodes Update.timeout = None on check()).
const UPDATE_DOWNLOAD_TIMEOUT_SECS: u64 = 30 * 60;

// Tauri's production WebView origin is application-owned rather than the
// dev server's loopback HTTP origin. Different WebView implementations use
// one of these exact origins, so the bundled backend gets all known forms
// explicitly. Never replace this with a wildcard: the backend may be bound
// beyond loopback by an operator configuration.
const PACKAGED_TAURI_CORS_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

// Global backend process handle
static BACKEND_PROCESS: Mutex<Option<Arc<std::sync::Mutex<std::process::Child>>>> =
    Mutex::new(None);

/// Merge the exact Tauri application origins into a packaged backend's CORS
/// environment without widening it to a wildcard. Config-file origins are
/// still loaded by the backend itself; this only covers origins that are
/// inherent to the native shell.
fn merge_packaged_cors_origins(existing: Option<&str>) -> Result<String, String> {
    let mut origins = Vec::new();
    if let Some(value) = existing {
        for origin in value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if origin == "*" {
                return Err(
                    "Refusing to launch bundled backend with wildcard CORS_ORIGINS".to_string(),
                );
            }
            if !origins.iter().any(|known| known == origin) {
                origins.push(origin.to_string());
            }
        }
    }
    for origin in PACKAGED_TAURI_CORS_ORIGINS {
        if !origins.iter().any(|known| known == origin) {
            origins.push((*origin).to_string());
        }
    }
    Ok(origins.join(","))
}

include!(concat!(env!("OUT_DIR"), "/embedded_backend.rs"));

mod config;
mod error;
mod indexer;
mod local_voice;
mod voice_python;

// ONNX speech-to-text needs ONNX Runtime, which is not linked on Windows (see
// Cargo.toml). Everywhere else it is the real runtime.
#[cfg(not(target_os = "windows"))]
mod whisper_onnx;
#[cfg(target_os = "windows")]
mod whisper_onnx {
    //! Windows stand-in for the ONNX speech-to-text runtime.
    //!
    //! ONNX Runtime ships only execution-provider builds for Windows, and none of
    //! them has been verified here, so this build says so plainly instead of
    //! failing mid-recording. ggml and PyTorch voice models are unaffected.

    use std::path::{Path, PathBuf};

    use crate::local_voice::InstalledVoiceModel;

    const UNAVAILABLE: &str =
        "ONNX voice models are not available in the Windows build of Koryphaios. Use a ggml or PyTorch voice model instead.";

    pub fn validate_onnx_model(_primary: &Path, _tokenizer: Option<PathBuf>) -> Result<(), String> {
        Err(UNAVAILABLE.to_string())
    }

    pub fn transcribe(
        _model: &InstalledVoiceModel,
        _samples: &[f32],
        _language: &str,
    ) -> Result<String, String> {
        Err(UNAVAILABLE.to_string())
    }
}
use config::{browser_host, AppConfig};
use error::{log_error, AppError, AppResult};

/// Resolve the bundled backend binary from the app's resource directory.
///
/// The backend ships as a Tauri resource (`bundle.resources` → `backend/`)
/// rather than being embedded in the Rust binary via `include_bytes!`.
/// This decouples Rust compilation from backend builds: most releases
/// swap the backend binary in the resources directory without recompiling
/// the Tauri shell.
///
/// In dev mode (no resource directory), returns None so the launcher
/// owns the backend separately.
fn resolve_bundled_backend(
    app_handle: &tauri::AppHandle,
) -> Result<Option<std::path::PathBuf>, String> {
    // Dev mode: the launch-desktop.ts script sets KORYPHAIOS_PORT before
    // spawning Tauri, meaning the dev backend is already running on that
    // port. Skip the bundled backend entirely to avoid a port conflict.
    if std::env::var("KORYPHAIOS_PORT").is_ok() {
        println!("[Koryphaios] Dev mode: launcher owns the backend (KORYPHAIOS_PORT set)");
        return Ok(None);
    }

    // Look for `backend/` in the resource directory.
    let backend_dir = app_handle
        .path()
        .resolve("backend", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve backend resource directory: {e}"))?;

    if !backend_dir.exists() {
        // Dev mode: no bundled backend, launcher owns the process.
        return Ok(None);
    }

    // The backend binary is named `koryphaios-backend-{target_triple}{suffix}`.
    // Fall back to any executable in the directory if the exact name isn't found.
    let target = std::env::consts::ARCH;
    let os_suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };

    // Try exact target match first (e.g. koryphaios-backend-x86_64-pc-windows-msvc.exe)
    let target_triple = if cfg!(target_os = "windows") {
        format!("{}-pc-windows-msvc", target)
    } else if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", target)
    } else {
        format!("{}-unknown-linux-gnu", target)
    };

    let exact_name = format!("koryphaios-backend-{}{}", target_triple, os_suffix);
    let exact_paths = [
        backend_dir.join(&exact_name),
        backend_dir.join(format!("{exact_name}.gz")),
    ];
    for exact_path in exact_paths {
        if exact_path.is_file() {
            return copy_backend_to_cache(app_handle, &exact_path);
        }
    }

    // Fall back: look for any koryphaios-backend-* executable in the directory
    if let Ok(entries) = std::fs::read_dir(&backend_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with("koryphaios-backend-") {
                if cfg!(target_os = "windows")
                    && !name.ends_with(".exe")
                    && !name.ends_with(".exe.gz")
                {
                    continue;
                }
                return copy_backend_to_cache(app_handle, &path);
            }
        }
    }

    // No backend found in resources — dev mode.
    Ok(None)
}

/// Copy the backend binary from the resource directory to the cache/runtime
/// directory with executable permissions. This avoids permission issues on
/// macOS where the .app bundle's Resources directory may be read-only after
/// signing, and ensures a consistent executable path across platforms.
fn copy_backend_to_cache(
    app_handle: &tauri::AppHandle,
    source: &std::path::Path,
) -> Result<Option<std::path::PathBuf>, String> {
    let runtime_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache directory: {e}"))?
        .join("runtime");
    std::fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Failed to create backend runtime directory: {e}"))?;

    const MAX_BACKEND_BYTES: u64 = 512 * 1024 * 1024;
    let source_metadata =
        std::fs::metadata(source).map_err(|e| format!("Failed to inspect bundled backend: {e}"))?;
    let source_size = source_metadata.len();

    let destination = runtime_dir.join(format!(
        "koryphaios-service-{}-{}{}",
        env!("CARGO_PKG_VERSION"),
        EMBEDDED_BACKEND_ID,
        if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        }
    ));

    let source_marker = destination.with_extension("source");
    let source_stamp = format!(
        "{}:{}",
        source_size,
        source_metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    let source_is_compressed = source.extension().and_then(|ext| ext.to_str()) == Some("gz");

    // Raw resources retain the old size fast-path. Compressed resources use a
    // sidecar stamp because their source size is intentionally different from
    // the decompressed executable size.
    let current_size = std::fs::metadata(&destination).map(|m| m.len()).ok();
    let needs_copy = if source_is_compressed {
        std::fs::read_to_string(&source_marker).ok().as_deref() != Some(source_stamp.as_str())
    } else {
        current_size != Some(source_size)
    };
    if needs_copy {
        let temporary = destination.with_extension("new");
        if let Err(error) = copy_backend_resource(source, &temporary, MAX_BACKEND_BYTES) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("Failed to make backend executable: {e}"))?;
        }
        std::fs::rename(&temporary, &destination)
            .map_err(|e| format!("Failed to activate backend: {e}"))?;
        if source_is_compressed {
            let marker_temporary = source_marker.with_extension("new");
            std::fs::write(&marker_temporary, &source_stamp)
                .map_err(|e| format!("Failed to stage backend source stamp: {e}"))?;
            std::fs::rename(&marker_temporary, &source_marker)
                .map_err(|e| format!("Failed to activate backend source stamp: {e}"))?;
        } else {
            let _ = std::fs::remove_file(&source_marker);
        }
    }
    Ok(Some(destination))
}

/// Materialize a bundled backend resource while keeping the resource opaque
/// to ELF scanners. Both raw and gzip resources are streamed through the same
/// hard ceiling so a corrupted or hostile bundle cannot exhaust memory/disk.
fn copy_backend_resource(
    source: &std::path::Path,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<u64, String> {
    let input =
        std::fs::File::open(source).map_err(|e| format!("Failed to open bundled backend: {e}"))?;
    let source_is_compressed = source.extension().and_then(|ext| ext.to_str()) == Some("gz");
    let reader: Box<dyn Read> = if source_is_compressed {
        Box::new(flate2::read::GzDecoder::new(input))
    } else {
        Box::new(input)
    };
    let mut limited = reader.take(max_bytes.saturating_add(1));
    let mut output = std::fs::File::create(destination)
        .map_err(|e| format!("Failed to stage bundled backend: {e}"))?;
    let bytes = std::io::copy(&mut limited, &mut output)
        .map_err(|e| format!("Failed to materialize bundled backend: {e}"))?;
    if bytes == 0 || bytes > max_bytes {
        return Err(format!(
            "Bundled backend decompressed size {bytes} is outside the safe limit"
        ));
    }
    Ok(bytes)
}

// ─── Supervisor events (consumed by the frontend backend-health sentinel) ────
// These give the UI a sub-second signal alongside its own /api/health polling.
// `backend://down` flips the frontend to its halted "Backend unavailable"
// overlay; `backend://ready` triggers an immediate health re-check that, if
// healthy + contract-matched, lifts the overlay.

#[derive(serde::Serialize, Clone)]
struct BackendDownEvent {
    reason: &'static str,
    pid: Option<u32>,
    message: String,
}

#[derive(serde::Serialize, Clone)]
struct BackendReadyEvent {
    pid: Option<u32>,
    host: String,
    port: u16,
}

fn emit_backend_down(
    app: &tauri::AppHandle,
    reason: &'static str,
    message: String,
    pid: Option<u32>,
) {
    let _ = app.emit(
        "backend://down",
        BackendDownEvent {
            reason,
            pid,
            message,
        },
    );
}

fn emit_backend_ready(app: &tauri::AppHandle, pid: Option<u32>, host: String, port: u16) {
    let _ = app.emit("backend://ready", BackendReadyEvent { pid, host, port });
}

fn validate_log_file_name(name: &str) -> std::io::Result<()> {
    let mut components = std::path::Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(()),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "backend log names must be a single path component",
        )),
    }
}

/// Open the backend's append-only logs without allowing either filename to
/// escape (or symlink out of) the private log directory. Existing logs are
/// retained and their permissions are healed on every launch.
#[cfg(unix)]
fn open_private_backend_logs(
    log_dir: &std::path::Path,
    stdout_name: &str,
    stderr_name: &str,
) -> std::io::Result<(std::fs::File, std::fs::File)> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    validate_log_file_name(stdout_name)?;
    validate_log_file_name(stderr_name)?;

    let mut directory_builder = std::fs::DirBuilder::new();
    directory_builder.recursive(true).mode(0o700);
    directory_builder.create(log_dir)?;

    let directory_path = CString::new(log_dir.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "backend log directory contains a NUL byte",
        )
    })?;
    // Keep a descriptor for the verified directory while opening both files.
    // O_NOFOLLOW rejects a final `logs` symlink, and openat below remains bound
    // to this exact directory even if its pathname is concurrently replaced.
    let directory_fd = unsafe {
        libc::open(
            directory_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if directory_fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful libc::open returned an owned descriptor.
    let directory = unsafe { std::fs::File::from_raw_fd(directory_fd) };
    if !directory.metadata()?.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "backend log path is not a directory",
        ));
    }
    directory.set_permissions(std::fs::Permissions::from_mode(0o700))?;

    let open_log = |name: &str| -> std::io::Result<std::fs::File> {
        let name = CString::new(name).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "backend log name contains a NUL byte",
            )
        })?;
        let file_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_APPEND
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if file_fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: a successful libc::openat returned an owned descriptor.
        let file = unsafe { std::fs::File::from_raw_fd(file_fd) };
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "backend log path is not a regular file",
            ));
        }
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        Ok(file)
    };

    Ok((open_log(stdout_name)?, open_log(stderr_name)?))
}

#[cfg(not(unix))]
fn open_private_backend_logs(
    log_dir: &std::path::Path,
    stdout_name: &str,
    stderr_name: &str,
) -> std::io::Result<(std::fs::File, std::fs::File)> {
    validate_log_file_name(stdout_name)?;
    validate_log_file_name(stderr_name)?;
    std::fs::create_dir_all(log_dir)?;

    let metadata = std::fs::symlink_metadata(log_dir)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "backend log path is not a real directory",
        ));
    }

    let open_log = |name: &str| -> std::io::Result<std::fs::File> {
        let path = log_dir.join(name);
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "backend log path is a symlink",
                ));
            }
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "backend log path is not a regular file",
            ));
        }
        Ok(file)
    };

    Ok((open_log(stdout_name)?, open_log(stderr_name)?))
}

/// Start the bundled backend service.
fn spawn_bundled_backend(
    app_handle: &tauri::AppHandle,
) -> Result<Option<Arc<std::sync::Mutex<std::process::Child>>>, String> {
    let backend_path = match resolve_bundled_backend(app_handle)? {
        Some(path) => path,
        None => {
            println!("[Koryphaios] Dev mode: launcher owns the backend");
            return Ok(None);
        }
    };

    println!("[Koryphaios] Starting bundled backend service");

    let mut cmd = std::process::Command::new(&backend_path);
    // The backend is a console-subsystem .exe on Windows; without CREATE_NO_WINDOW
    // a Tauri GUI app pops an (empty) console window on every spawn — and the
    // supervisor respawns on exit, so it would flash repeatedly. stdout/stderr are
    // already redirected to log files below, so nothing is lost by hiding it.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // NEVER pipe without a reader: the backend logs heavily and a full 64KB
    // pipe buffer blocks its writes — the whole backend freezes mid-session.
    // Log to files in the data dir instead (also gives users a crash log).
    let log_dir = app_handle
        .path()
        .app_data_dir()
        .map(|d| d.join("logs"))
        .ok();
    if let Some(dir) = &log_dir {
        match open_private_backend_logs(dir, "backend.log", "backend.err.log") {
            Ok((out, err)) => {
                cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
            }
            Err(error) => {
                eprintln!("[Koryphaios] Refusing unsafe backend log path: {error}");
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }

    // Set environment variables for the backend
    let config = AppConfig::get();
    cmd.env("KORYPHAIOS_PORT", config.server.port.to_string());
    cmd.env("KORYPHAIOS_HOST", &config.server.host);
    cmd.env("NODE_ENV", "production");
    let packaged_cors_origins =
        merge_packaged_cors_origins(std::env::var("CORS_ORIGINS").ok().as_deref())?;
    cmd.env("CORS_ORIGINS", packaged_cors_origins);

    // Collaboration relay config. RELAY_URL is baked into the backend at build
    // time (so shipped clients can join out of the box), but the host secret and
    // TURN creds are runtime-only — forward them from this process's environment
    // when present so a host can enable hosting from an installed build without
    // editing files. Never logged.
    for key in [
        "RELAY_URL",
        "RELAY_HOST_SECRET",
        "TURN_URL",
        "TURN_USERNAME",
        "TURN_CREDENTIAL",
    ] {
        if let Ok(val) = std::env::var(key) {
            if !val.is_empty() {
                cmd.env(key, val);
            }
        }
    }

    // Pin the build-coherent bundle hash so the bundled backend reports it on
    // /api/health (compat.bundleHash). The frontend sentinel compares this to
    // its own compile-time hash and halts if they differ — production builds
    // cannot run a stale frontend against a fresh backend (or vice versa).
    // In dev this resolves to "dev" on both sides, which skips the check.
    cmd.env("KORYPHAIOS_FRONTEND_BUNDLE_HASH", EMBEDDED_BUNDLE_HASH);

    // Set data directory — also the service's cwd so relative paths (SQLite
    // dbs, koryphaios.json) never land in whatever dir launched the AppImage.
    if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&app_data_dir);
        cmd.env("KORYPHAIOS_DATA_DIR", &app_data_dir);
        cmd.current_dir(&app_data_dir);
    }

    // One app: the backend serves the bundled frontend, the window loads it
    // from the backend origin — frontend and backend are never separate.
    if let Ok(frontend_dir) = app_handle
        .path()
        .resolve("frontend", tauri::path::BaseDirectory::Resource)
    {
        if frontend_dir.exists() {
            cmd.env("KORYPHAIOS_FRONTEND_DIST", &frontend_dir);
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn backend: {}", e))?;

    println!(
        "[Koryphaios] Bundled backend started with PID {}",
        child.id()
    );

    Ok(Some(Arc::new(std::sync::Mutex::new(child))))
}

/// Wait for backend to be ready by polling health endpoint.
///
/// The backend may bind to a different port than `port` if the requested
/// port was already in use (EADDRINUSE fallback). In that case it writes
/// the actual port to `.koryphaios/.active-port.json`. We check that file
/// on every poll iteration and switch to the discovered port if it differs.
async fn wait_for_backend_ready(
    host: &str,
    port: u16,
    max_wait_ms: u64,
    expected_pid: Option<u32>,
    process: Option<Arc<std::sync::Mutex<std::process::Child>>>,
) -> Result<u16, String> {
    let start = std::time::Instant::now();
    let mut current_port = port;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to create backend health client: {e}"))?;

    while (start.elapsed().as_millis() as u64) < max_wait_ms {
        if let Some(process) = &process {
            if let Ok(mut child) = process.lock() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!(
                        "Bundled backend exited before becoming ready ({status})"
                    ));
                }
            }
        }

        // Check if the backend wrote a different port to .active-port.json
        // (EADDRINUSE fallback). The function is in config.rs.
        if let Some((_, discovered_port)) = crate::config::read_active_port_public() {
            if discovered_port != current_port {
                eprintln!(
                    "[Koryphaios] Backend fell back from port {} to {}",
                    current_port, discovered_port
                );
                current_port = discovered_port;
            }
        }

        let health_url = format!("http://{}:{}/api/health", host, current_port);
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    let healthy = body.get("ok").and_then(|value| value.as_bool()) == Some(true);
                    let responding_pid = body
                        .get("data")
                        .and_then(|data| data.get("pid"))
                        .and_then(|value| value.as_u64())
                        .and_then(|value| u32::try_from(value).ok());
                    let correct_process = expected_pid.is_none() || responding_pid == expected_pid;
                    if healthy && correct_process {
                        println!("[Koryphaios] Backend is ready on port {}!", current_port);
                        return Ok(current_port);
                    }
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    Err(format!(
        "Backend failed to become ready within {}ms (last port: {})",
        max_wait_ms, current_port
    ))
}

/// Kill the backend process
fn kill_backend() {
    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
        if let Some(process_arc) = guard.take() {
            if let Ok(mut process) = process_arc.lock() {
                println!("[Koryphaios] Stopping bundled backend...");
                let _ = process.kill();
            }
        }
    }
}

// ─── Dev-mode backend supervisor ─────────────────────────────────────────────
//
// In dev mode the launcher (scripts/launch-desktop.ts) owns the backend: it
// spawns `bun run src/server.ts` and sets KORYPHAIOS_PORT before launching
// `tauri dev`. The Tauri app therefore skips spawn_bundled_backend (returns
// Ok(None)) and starts no supervisor.
//
// The problem: the Tauri app process detaches from the launcher (it reparents
// to init/systemd when the terminal that ran `bun run dev` closes). When the
// launcher dies its cleanup SIGTERMs the backend, but the orphaned Tauri app
// keeps running — with KORYPHAIOS_PORT set, no backend, and no way to start
// one. The UI is left polling a dead port indefinitely.
//
// This supervisor closes that gap. It polls /api/health; if the backend stays
// unreachable (the launcher's backend is gone) it spawns `bun run src/server.ts`
// from the source tree and supervises it with restart-on-exit, mirroring the
// bundled-backend supervisor. While the launcher's backend is healthy it does
// nothing, so there is no conflict with a live launcher.

/// Locate the backend source directory in dev mode so the app can spawn
/// `bun run src/server.ts` itself. Returns None in release builds or when the
/// source tree isn't reachable.
fn resolve_dev_backend_dir() -> Option<std::path::PathBuf> {
    // CARGO_MANIFEST_DIR is present in debug builds run via `tauri dev` and
    // points at desktop/src-tauri; the backend lives at <project>/backend.
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let candidate = std::path::Path::new(&manifest_dir)
            .join("..")
            .join("..")
            .join("backend");
        if candidate.join("src").join("server.ts").is_file() {
            return Some(candidate);
        }
    }
    // Fall back: walk up from the current working directory looking for a
    // `backend/src/server.ts` tree (covers running the binary from the
    // project root after a `cargo build`).
    let mut cwd = std::env::current_dir().ok()?;
    for _ in 0..6 {
        let candidate = cwd.join("backend");
        if candidate.join("src").join("server.ts").is_file() {
            return Some(candidate);
        }
        cwd = cwd.parent()?.to_path_buf();
    }
    None
}

/// Spawn the dev backend (`bun run src/server.ts`) from the source tree.
/// Used only when the app is running in dev mode without a bundled backend
/// and the launcher's backend has disappeared. The resulting child is stored
/// in BACKEND_PROCESS so kill_backend()/window-destroy cleans it up.
fn dev_backend_binding(host: &str, port: u16) -> (String, String) {
    (host.to_string(), port.to_string())
}

fn spawn_dev_backend(
    app_handle: &tauri::AppHandle,
    backend_dir: &std::path::Path,
    host: &str,
    port: u16,
) -> Result<Arc<std::sync::Mutex<std::process::Child>>, String> {
    let mut cmd = std::process::Command::new("bun");
    cmd.args(["run", "src/server.ts"]);
    cmd.current_dir(backend_dir);

    // The dev environment (KORYPHAIOS_* vars) was inherited from the launcher
    // that originally spawned `tauri dev`. Pin the host/port explicitly so the
    // child binds where the UI expects it.
    let (binding_host, binding_port) = dev_backend_binding(host, port);
    cmd.env("KORYPHAIOS_HOST", binding_host);
    cmd.env("KORYPHAIOS_PORT", binding_port);
    if let Ok(v) = std::env::var("KORYPHAIOS_FRONTEND_HOST") {
        cmd.env("KORYPHAIOS_FRONTEND_HOST", v);
    }
    if let Ok(v) = std::env::var("KORYPHAIOS_FRONTEND_PORT") {
        cmd.env("KORYPHAIOS_FRONTEND_PORT", v);
    }
    cmd.env("KORYPHAIOS_DESKTOP_DEV", "1");
    if let Ok(hash) = std::env::var("KORYPHAIOS_FRONTEND_BUNDLE_HASH") {
        cmd.env("KORYPHAIOS_FRONTEND_BUNDLE_HASH", hash);
    }

    // NEVER pipe without a reader: the backend logs heavily and a full 64KB
    // pipe buffer blocks its writes (same rationale as spawn_bundled_backend).
    // Log to the app data dir so a crash leaves a trail.
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        let logs = data_dir.join("logs");
        match open_private_backend_logs(
            &logs,
            "backend-dev-supervised.log",
            "backend-dev-supervised.err.log",
        ) {
            Ok((out, err)) => {
                cmd.stdout(Stdio::from(out));
                cmd.stderr(Stdio::from(err));
            }
            Err(error) => {
                eprintln!("[Koryphaios] Refusing unsafe dev backend log path: {error}");
                cmd.stdout(Stdio::null());
                cmd.stderr(Stdio::null());
            }
        }
    } else {
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn dev backend: {e}"))?;
    println!("[Koryphaios] Dev backend started with PID {}", child.id());
    Ok(Arc::new(std::sync::Mutex::new(child)))
}

fn is_port_listening(host: &str, port: u16) -> bool {
    std::net::TcpStream::connect((host, port)).is_ok()
}

async fn check_health(client: &reqwest::Client, url: &str) -> bool {
    match client.get(url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Spawn the dev backend, store it in BACKEND_PROCESS, and wait for readiness.
/// On failure the killed child is dropped and BACKEND_PROCESS is left None so
/// the supervisor loop retries.
async fn spawn_and_wait_dev_backend(
    app_handle: &tauri::AppHandle,
    backend_dir: &std::path::Path,
    host: &str,
    port: u16,
) {
    match spawn_dev_backend(app_handle, backend_dir, host, port) {
        Ok(proc) => {
            let pid = proc.lock().ok().map(|c| c.id());
            if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                *guard = Some(proc.clone());
            }
            match wait_for_backend_ready(host, port, 60_000, pid, Some(proc.clone())).await {
                Ok(actual_port) => {
                    emit_backend_ready(app_handle, pid, host.to_string(), actual_port);
                }
                Err(e) => {
                    eprintln!("[Koryphaios] Dev supervisor: backend did not become ready: {e}");
                    emit_backend_down(
                        app_handle,
                        "restart-timeout",
                        format!("Dev backend did not become ready: {e}"),
                        pid,
                    );
                    if let Ok(mut child) = proc.lock() {
                        let _ = child.kill();
                    }
                    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                        *guard = None;
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("[Koryphaios] Dev supervisor: spawn failed: {e}");
            emit_backend_down(
                app_handle,
                "restart-failed",
                format!("Could not spawn dev backend: {e}"),
                None,
            );
        }
    }
}

/// Dev-mode backend supervisor. Polls the health endpoint; if the backend
/// stays unreachable (the launcher's backend died) it spawns
/// `bun run src/server.ts` and supervises it with restart-on-exit.
async fn dev_backend_supervisor(
    app_handle: tauri::AppHandle,
    backend_dir: std::path::PathBuf,
    host: String,
    port: u16,
) {
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Koryphaios] Dev supervisor: failed to build HTTP client: {e}");
            return;
        }
    };
    let health_url = format!("http://{host}:{port}/api/health");

    const POLL_SECS: u64 = 3;
    // ~15s of sustained unresponsiveness before taking over. This gives a live
    // launcher time to restart its own backend (its watchdog tears down at ~15s
    // too), so we only step in once the launcher is genuinely gone.
    const FAIL_THRESHOLD: u32 = 5;

    let mut consecutive_failures = 0u32;
    println!("[Koryphaios] Dev backend supervisor active (health URL {health_url})");

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(POLL_SECS)).await;

        // If we own a backend, supervise it by exit status (restart-on-exit),
        // mirroring the bundled-backend supervisor.
        let owned_exited = {
            let guard = BACKEND_PROCESS.lock().ok();
            match guard.as_ref().and_then(|g| g.as_ref()) {
                Some(proc_arc) => match proc_arc.lock() {
                    Ok(mut child) => child.try_wait().ok().flatten().is_some(),
                    Err(_) => false,
                },
                None => false,
            }
        };
        if owned_exited {
            let dead_pid = BACKEND_PROCESS
                .lock()
                .ok()
                .and_then(|g| g.as_ref().and_then(|p| p.lock().ok().map(|c| c.id())));
            eprintln!("[Koryphaios] Dev backend died — restarting...");
            emit_backend_down(
                &app_handle,
                "exited",
                "Dev backend process exited; supervisor is restarting it.".to_string(),
                dead_pid,
            );
            if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                *guard = None;
            }
            spawn_and_wait_dev_backend(&app_handle, &backend_dir, &host, port).await;
            consecutive_failures = 0;
            continue;
        }

        // If we own a live backend, the exit check above handles restarts; no
        // need to health-poll our own process.
        let we_own = BACKEND_PROCESS
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|_| true))
            .unwrap_or(false);
        if we_own {
            continue;
        }

        // We don't own a backend — poll the launcher's.
        if check_health(&client, &health_url).await {
            if consecutive_failures > 0 {
                eprintln!(
                    "[Koryphaios] Dev supervisor: launcher backend recovered after {consecutive_failures} failures"
                );
            }
            consecutive_failures = 0;
            continue;
        }

        consecutive_failures += 1;
        if consecutive_failures < FAIL_THRESHOLD {
            continue;
        }

        // Something is still bound to the port but not answering health. Don't
        // spawn a conflicting backend (it would EADDRINUSE-fallback and split
        // traffic); keep waiting for the port to free up.
        if is_port_listening(&host, port) {
            consecutive_failures = 0;
            continue;
        }

        eprintln!(
            "[Koryphaios] Dev supervisor: backend unreachable for ~{}s — spawning dev backend",
            consecutive_failures * POLL_SECS as u32
        );
        emit_backend_down(
            &app_handle,
            "launcher-gone",
            "Launcher backend is unreachable; the app is starting its own dev backend.".to_string(),
            None,
        );
        spawn_and_wait_dev_backend(&app_handle, &backend_dir, &host, port).await;
        consecutive_failures = 0;
    }
}

// Window state for persistence
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
}

// File drop payload
#[derive(serde::Serialize, Clone)]
struct FileDropPayload {
    paths: Vec<String>,
    position: Option<(f64, f64)>,
}

#[derive(serde::Serialize)]
struct UpdateCheckResult {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    if cfg!(debug_assertions) {
        return Err("updates are disabled in development builds".to_string());
    }
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater_builder()
        .on_before_exit(kill_backend)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = update {
        // Cache the Update so install_update can use it without re-fetching
        // the manifest (saves ~0.5–2s and a network round-trip per install click).
        if let Ok(mut cache) = CACHED_UPDATE.lock() {
            *cache = Some(update);
        }
        // Re-acquire to read version/notes/date for the response.
        let cache = CACHED_UPDATE.lock().map_err(|e| e.to_string())?;
        let cached = cache.as_ref().ok_or("update vanished from cache")?;
        Ok(UpdateCheckResult {
            available: true,
            version: Some(cached.version.clone()),
            notes: cached.body.clone(),
            pub_date: cached.date.as_ref().map(|d| d.to_string()),
        })
    } else {
        // No update — clear any stale cache.
        if let Ok(mut cache) = CACHED_UPDATE.lock() {
            *cache = None;
        }
        Ok(UpdateCheckResult {
            available: false,
            version: None,
            notes: None,
            pub_date: None,
        })
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("updates are disabled in development builds".to_string());
    }
    use tauri_plugin_updater::UpdaterExt;

    // Try the cached Update from check_for_updates first; only re-fetch if the
    // cache is empty (e.g. the user clicked Install without a prior check, or
    // the app was restarted and the static was cleared).
    let update_opt = CACHED_UPDATE.lock().ok().and_then(|mut c| c.take());
    let mut update = match update_opt {
        Some(u) => u,
        None => {
            let updater = app
                .updater_builder()
                .on_before_exit(kill_backend)
                .build()
                .map_err(|e| e.to_string())?;
            updater
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or("no update available")?
        }
    };

    // tauri-plugin-updater 2.10.1 hardcodes `Update.timeout = None` when it
    // builds the Update in check(). The field is pub, so we set it here to
    // prevent a stalled download from blocking forever (the root cause of
    // "updates take a decade").
    update.timeout = Some(std::time::Duration::from_secs(UPDATE_DOWNLOAD_TIMEOUT_SECS));

    // Wire the on_chunk callback to emit real progress events to the frontend.
    // The plugin does NOT auto-emit these from download_and_install — without
    // this, the UI shows a spinner with no progress bar for the whole download.
    let app_handle = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = app_handle.emit(
                    "tauri://update-download-progress",
                    serde_json::json!({
                        "chunkLength": chunk_length,
                        "contentLength": content_length,
                    }),
                );
            },
            || {
                // on_download_finish: the plugin verifies the signature and
                // installs the bytes. On Linux it replaces the AppImage file
                // in place; on macOS it swaps the .app bundle; on Windows it
                // shells out to the NSIS/MSI installer.
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // download_and_install has already installed the update. On Windows the
    // NSIS/MSI installer relaunches the app itself (we must NOT call restart
    // there or we race the installer). On Linux/macOS the file is replaced
    // and we need to restart into the new binary. request_restart() triggers
    // a clean ExitRequested → Exit → restart cycle via the event loop, which
    // is the safe path (app.restart() can skip cleanup when called off the
    // main thread).
    #[cfg(not(target_os = "windows"))]
    app.request_restart();

    Ok(())
}

#[tauri::command]
fn get_backend_url() -> String {
    AppConfig::get().backend_url()
}

#[tauri::command]
fn get_websocket_url() -> String {
    AppConfig::get().websocket_url()
}

#[tauri::command]
fn get_app_version() -> String {
    AppConfig::get().app.version.clone()
}

/// Best-effort zoom for the frameless main window: macOS `zoom:` (which backs
/// `maximize()`) is a silent no-op without a native title bar, so on macOS the
/// window frame is enforced directly with a synchronous AppKit
/// `setFrame:display:` to the screen's `visibleFrame`. That yields the full
/// work-area frame — full width and height, unmagnified, never fullscreen —
/// below the menu bar and above the Dock, like the native green-button zoom.
fn zoom_to_work_area(window: &WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let apply = move || {
            capture_pre_zoom_frame(&w);
            set_visible_frame(&w);
        };
        if MainThreadMarker::new().is_some() {
            apply();
        } else {
            let _ = window.run_on_main_thread(apply);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // `current_monitor()` can briefly return nothing right after show; the
        // primary monitor is a good enough fallback so the zoom never silently
        // no-ops and leaves the window at its short config size.
        let monitor = match window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten())
        {
            Some(monitor) => monitor,
            None => {
                println!("[Koryphaios] Zoom skipped: no monitor information available");
                return;
            }
        };
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let target_height = area.size.to_logical::<f64>(scale).height;
        let before_size = window.inner_size().ok();
        let before_pos = window.outer_position().ok();
        println!(
            "[Koryphaios] Zoom check (monitor={}x{}@{}, work_area={}x{}@{},{} window={:?}@{:?})",
            monitor.size().width,
            monitor.size().height,
            scale,
            area.size.width,
            area.size.height,
            area.position.x,
            area.position.y,
            before_size,
            before_pos
        );
        let current_height = window
            .inner_size()
            .map(|size| size.to_logical::<f64>(scale).height)
            .unwrap_or(0.0);
        let current_y = window.outer_position().map(|pos| pos.y).unwrap_or(i32::MAX);
        let target_y = area.position.y;
        // Already flush with the work area (top edge and height): nothing to do.
        // Otherwise take control and enforce the exact frame — growing or
        // shrinking — so the window sits flush below the menu bar and above the
        // Dock like every native zoomed Mac app.
        if (current_height - target_height).abs() <= 1.0 && (current_y - target_y).abs() <= 2 {
            return;
        }
        let width = match window.inner_size() {
            Ok(size) => size.to_logical::<f64>(scale).width,
            Err(_) => return,
        };
        if width <= 0.0 || target_height <= 0.0 {
            return;
        }
        let target_x = window
            .outer_position()
            .map(|pos| pos.x)
            .unwrap_or(area.position.x);
        // AppKit applies resizes asynchronously (and the dev watcher can briefly
        // relaunch under us), so verify on a worker thread and re-apply while
        // the window is still short or sitting low.
        let worker = window.clone();
        std::thread::spawn(move || {
            if worker.is_fullscreen().unwrap_or(false) {
                return;
            }
            // Distance from the target work-area geometry, as (height_gap_px,
            // y_gap_px, x_gap_px). Used to tell "AppKit still hasn't applied our
            // request" (gap shrinks or stays put — keep retrying) from "someone
            // else is dragging the window" (gap grows — stop fighting them).
            let gap = |h: f64, x: i32, y: i32| -> (f64, u32, u32) {
                ((target_height - h).abs(), y.abs_diff(target_y), x.abs_diff(target_x))
            };
            let mut prev_gap: Option<(f64, u32, u32)> = None;
            for attempt in 0..6u32 {
                // Re-read the width every attempt so an east/west drag by the
                // user during the retry window is preserved instead of snapped
                // back to the width captured before the zoom started.
                let width = worker
                    .inner_size()
                    .map(|size| size.to_logical::<f64>(scale).width)
                    .unwrap_or(width);
                let _ = worker.set_size(tauri::LogicalSize::new(width, target_height));
                let _ = worker.set_position(tauri::PhysicalPosition::new(target_x, target_y));
                std::thread::sleep(std::time::Duration::from_millis(400));
                let size = worker
                    .inner_size()
                    .map(|size| size.to_logical::<f64>(scale))
                    .unwrap_or_default();
                let pos = worker.outer_position().unwrap_or_default();
                let height = size.height;
                let y = pos.y;
                if (height - target_height).abs() <= 1.0 && (y - target_y).abs() <= 2 {
                    println!(
                        "[Koryphaios] Work-area height settled at {}x{} y={} (attempt {})",
                        width as u32, height as u32, y, attempt + 1
                    );
                    return;
                }
                let current_gap = gap(height, pos.x, y);
                if let Some((prev_h, prev_y, prev_x)) = prev_gap {
                    let drifted = current_gap.0 > prev_h + 2.0
                        || current_gap.1 > prev_y + 2
                        || current_gap.2 > prev_x + 2;
                    if drifted {
                        println!(
                            "[Koryphaios] Work-area zoom aborted: window is being resized or moved externally ({}x{} y={})",
                            width as u32, height as u32, y
                        );
                        return;
                    }
                }
                prev_gap = Some(current_gap);
            }
            println!("[Koryphaios] Work-area height fallback did not stick; leaving window as-is");
        });
    }
}

#[cfg(target_os = "macos")]
static PRE_ZOOM_FRAME: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

/// Retain the window's NSWindow as a strong reference. Must be on the main
/// thread; the raw pointer stays valid because Tauri keeps the window alive.
#[cfg(target_os = "macos")]
fn retain_ns_window(window: &WebviewWindow) -> Option<Retained<NSWindow>> {
    let ptr = window.ns_window().ok()?;
    unsafe { Retained::retain(ptr as *mut NSWindow) }
}

/// Record the window's current AppKit frame so the zoom can be undone to the
/// exact pre-zoom geometry (native un-zoom semantics).
#[cfg(target_os = "macos")]
fn capture_pre_zoom_frame(window: &WebviewWindow) {
    let Some(ns_window) = retain_ns_window(window) else {
        return;
    };
    let frame = ns_window.frame();
    if let Ok(mut slot) = PRE_ZOOM_FRAME.lock() {
        *slot = Some((
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height,
        ));
    }
}

/// Synchronously set the window frame to the screen's `visibleFrame` — the
/// work area between the menu bar and the Dock. `setFrame:display:` is
/// applied immediately (no animation, no async race), and AppKit clamps it
/// to `constrainFrameRect`, so the frame can never cover the menu bar.
#[cfg(target_os = "macos")]
fn set_visible_frame(window: &WebviewWindow) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(ns_window) = retain_ns_window(window) else {
        return;
    };
    let screen = ns_window.screen().or_else(|| NSScreen::mainScreen(mtm));
    let Some(screen) = screen else {
        println!("[Koryphaios] Work-area zoom skipped: no screen available");
        return;
    };
    let frame = screen.visibleFrame();
    println!(
        "[Koryphaios] Work-area zoom: setFrame origin=({},{}) size={}x{}",
        frame.origin.x, frame.origin.y, frame.size.width, frame.size.height
    );
    ns_window.setFrame_display(frame, false);
    // Record it so a later display change can tell a zoomed window apart from
    // one the user sized by hand and re-fill only the former.
    record_fitted_frame(frame_values(frame));
}

/// Undo the work-area zoom by restoring the exact pre-zoom frame.
#[cfg(target_os = "macos")]
fn restore_pre_zoom_frame(window: &WebviewWindow) {
    let saved = PRE_ZOOM_FRAME.lock().ok().and_then(|slot| *slot);
    let Some((x, y, width, height)) = saved else {
        // Nothing captured (e.g. first run after an external resize): fall
        // back to tao's un-zoom path.
        let _ = window.unmaximize();
        return;
    };
    let Some(ns_window) = retain_ns_window(window) else {
        return;
    };
    let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
    println!(
        "[Koryphaios] Work-area un-zoom: setFrame origin=({},{}) size={}x{}",
        x, y, width, height
    );
    ns_window.setFrame_display(frame, false);
    if let Ok(mut slot) = PRE_ZOOM_FRAME.lock() {
        *slot = None;
    }
    // The window is no longer filled to a work area, so a display change must
    // not treat it as zoomed and snap it back out to full size.
    if let Ok(mut slot) = FITTED_FRAME.lock() {
        *slot = None;
    }
}

/// The work-area frame the window was last fitted to, as
/// `(x, y, width, height)` in logical points. A display change has to tell
/// "the user had this filled the work area" apart from "the user sized this
/// themselves", and this is the only place the former is recorded.
static FITTED_FRAME: Mutex<Option<[f64; 4]>> = Mutex::new(None);

fn fitted_frame() -> Option<[f64; 4]> {
    FITTED_FRAME.lock().ok().and_then(|slot| *slot)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn record_fitted_frame(frame: [f64; 4]) {
    if let Ok(mut slot) = FITTED_FRAME.lock() {
        *slot = Some(frame);
    }
}

#[cfg(target_os = "macos")]
fn frame_values(rect: NSRect) -> [f64; 4] {
    [
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    ]
}

/// Whether two frames describe the same rectangle. The one-pixel slack keeps
/// floating-point scaling noise from reading as a change.
fn frames_match(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(l, r)| (l - r).abs() < 1.0)
}

/// Pick the frame the window should take now that the display it sits on
/// changed, or `None` when it is already correctly placed inside `work`.
///
/// `work` is the new display's work area and `frame` the window's current
/// frame, both `(x, y, width, height)` in logical points with a bottom-left
/// origin. A window that had been filled to a work area (`fitted`) is
/// re-filled to the new one, which is what a natively zoomed window does when
/// the display it was on is unplugged. Otherwise an over-sized window is
/// shrunk back inside the work area, never grown, so a size the user picked is
/// never overridden.
fn frame_for_display_change(
    work: &[f64; 4],
    frame: &[f64; 4],
    fitted: Option<[f64; 4]>,
) -> Option<[f64; 4]> {
    let [wx, wy, ww, wh] = *work;
    let [fx, fy, fw, fh] = *frame;
    if ww <= 0.0 || wh <= 0.0 || fw <= 0.0 || fh <= 0.0 {
        return None;
    }
    if fitted.is_some_and(|previous| frames_match(&previous, frame)) {
        let target = [wx, wy, ww, wh];
        return (!frames_match(&target, frame)).then_some(target);
    }
    let width = fw.min(ww);
    let height = fh.min(wh);
    if width == fw && height == fh {
        // The window already fits, so its position is the user's business:
        // dragging a window partly off-screen to see what is behind it is
        // normal, and yanking it back would be hostile. An over-sized frame is
        // a different matter, because AppKit never lets a user make a window
        // larger than the display — so an over-sized one is always a leftover
        // from a bigger display, never a deliberate choice.
        return None;
    }
    let target = [
        fx.clamp(wx, wx + ww - width),
        fy.clamp(wy, wy + wh - height),
        width,
        height,
    ];
    (!frames_match(&target, frame)).then_some(target)
}

/// A normal (un-zoomed) frame on `work`: 85% of it, centered. Used after a
/// display change so un-zoom lands on a sensible window on the new display
/// instead of the stale frame captured on the display that went away.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn restore_frame_for_work_area(work: &[f64; 4]) -> [f64; 4] {
    let [wx, wy, ww, wh] = *work;
    let width = (ww * 0.85).round();
    let height = (wh * 0.85).round();
    [
        wx + (ww - width) / 2.0,
        wy + (wh - height) / 2.0,
        width,
        height,
    ]
}

/// Re-fit the main window to the display it currently lives on.
///
/// macOS moves a window onto the built-in panel when an external display is
/// unplugged but keeps the window's old size, so a window that was 2560px
/// wide on the external monitor lands with its right third past the edge of a
/// 1512px screen and — unlike every native app — it never shrinks back. A
/// frameless window makes this worse, because the shell enforces its own frame
/// instead of letting AppKit keep a per-display zoom rectangle.
#[cfg(target_os = "macos")]
fn refit_window_to_display(window: &WebviewWindow) {
    let target_window = window.clone();
    let apply = move || {
        // Built here rather than captured: MainThreadMarker is not Send, and
        // this closure has to cross to the main thread from the watcher.
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(ns_window) = retain_ns_window(&target_window) else {
            return;
        };
        // Read fullscreen from the style mask rather than Tauri so this whole
        // repair runs inside a single main-thread hop.
        if (ns_window.styleMask().0 & NSWindowStyleMask::FullScreen.0) != 0 {
            return;
        }
        let Some(screen) = ns_window.screen().or_else(|| NSScreen::mainScreen(mtm)) else {
            return;
        };
        let work = frame_values(screen.visibleFrame());
        let frame = frame_values(ns_window.frame());
        let Some(target) = frame_for_display_change(&work, &frame, fitted_frame()) else {
            return;
        };
        println!(
            "[Koryphaios] Display changed: refitting window to ({},{}) {}x{}",
            target[0], target[1], target[2], target[3]
        );
        ns_window.setFrame_display(
            NSRect::new(
                NSPoint::new(target[0], target[1]),
                NSSize::new(target[2], target[3]),
            ),
            false,
        );
        if frames_match(&target, &work) {
            record_fitted_frame(target);
            // The captured un-zoom frame points at the display that just went
            // away, so replace it with a normal frame on the new work area.
            if let Ok(mut slot) = PRE_ZOOM_FRAME.lock() {
                let restore = restore_frame_for_work_area(&work);
                *slot = Some((restore[0], restore[1], restore[2], restore[3]));
            }
        }
    };
    if MainThreadMarker::new().is_some() {
        apply();
    } else {
        let _ = window.run_on_main_thread(apply);
    }
}

/// Non-macOS counterpart of [`refit_window_to_display`]. There is no frameless
/// zoom rectangle to restore, so a display change only has to stop the window
/// from hanging off the edge of a smaller display.
#[cfg(not(target_os = "macos"))]
fn refit_window_to_display(window: &WebviewWindow) {
    // A maximized window belongs to the window manager, which re-zooms it
    // itself when the display layout changes.
    if window.is_fullscreen().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return;
    }
    let area = monitor.work_area();
    let work = [
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    ];
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let frame = [
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ];
    let Some(target) = frame_for_display_change(&work, &frame, fitted_frame()) else {
        return;
    };
    println!(
        "[Koryphaios] Display changed: refitting window to ({},{}) {}x{}",
        target[0], target[1], target[2], target[3]
    );
    let _ = window.set_size(tauri::LogicalSize::new(target[2], target[3]));
    let _ = window.set_position(tauri::PhysicalPosition::new(
        (target[0] * scale).round() as i32,
        (target[1] * scale).round() as i32,
    ));
}

/// Repair the main window whenever the display layout changes under it.
///
/// Polling rather than subscribing to AppKit's screen notifications keeps the
/// platform-specific code down to the one frame read/write above, and covers
/// monitor unplug, resolution changes, and scale-factor changes the same way.
/// 800ms is far below the time it takes to notice a window hanging off the
/// edge of a screen, and the read is two float compares when nothing moved.
fn watch_display_changes(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(800));
        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        refit_window_to_display(&window);
    });
}

#[tauri::command]
fn show_main_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.unminimize();
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    let enter_fullscreen = !is_fullscreen;
    window
        .set_fullscreen(enter_fullscreen)
        .map_err(|error| error.to_string())?;
    Ok(enter_fullscreen)
}

#[tauri::command]
fn minimize_to_tray(window: WebviewWindow, app_handle: tauri::AppHandle) {
    // Save window state before hiding
    if let Ok(state) = window_state(&window) {
        let _ = save_window_state(&app_handle, state);
    }
    let _ = window.hide();
}

#[tauri::command]
async fn minimize_window_cmd(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
async fn toggle_maximize(window: WebviewWindow) {
    let is_maximized = window.is_maximized().unwrap_or(false);
    if is_maximized {
        #[cfg(target_os = "macos")]
        {
            // tao's unmaximize falls back to a hardcoded 800x600 frame for
            // borderless windows; restore the real pre-zoom geometry instead.
            let w = window.clone();
            let restore = move || restore_pre_zoom_frame(&w);
            if MainThreadMarker::new().is_some() {
                restore();
            } else {
                let _ = window.run_on_main_thread(restore);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window.unmaximize();
    } else {
        #[cfg(target_os = "macos")]
        zoom_to_work_area(&window);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.maximize();
            zoom_to_work_area(&window);
        }
    }
}

#[tauri::command]
async fn close_window_cmd(window: WebviewWindow) {
    let _ = window.close();
}

// Open folder dialog to select a directory for new project
#[tauri::command]
async fn select_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_title("Select Folder Location")
        .blocking_pick_folder();

    Ok(result.map(|p| p.to_string()))
}

// Pick one or more files to reference in the composer (@path)
#[tauri::command]
async fn select_files_dialog(app: tauri::AppHandle) -> Result<Option<Vec<String>>, String> {
    let result = app
        .dialog()
        .file()
        .set_title("Select files to reference")
        .blocking_pick_files();

    Ok(result.map(|paths| paths.into_iter().map(|p| p.to_string()).collect()))
}

// Pick a voice model. The filter names the formats the local runtimes can load
// rather than one vendor's layout, and the picker stays open on rejection so a
// wrong file can be replaced without starting over.
#[tauri::command]
async fn select_voice_model_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Select a voice model")
        .add_filter(
            "Voice models",
            &[
                "bin", "onnx", "pt", "pth", "ckpt", "safetensors", "gguf", "npz",
            ],
        )
        .blocking_pick_file();
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = std::path::PathBuf::from(path.to_string());
    let format = local_voice::detect_format(&path);
    if format == local_voice::VoiceModelFormat::Unknown {
        return Err(local_voice::unknown_format_message(&path));
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

// Create a new project folder at the specified path
#[tauri::command]
fn create_project_folder(parent_path: String, project_name: String) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;

    let parent = PathBuf::from(&parent_path);
    if !parent.exists() {
        return Err("Parent directory does not exist".to_string());
    }

    if !parent.is_dir() {
        return Err("Parent path is not a directory".to_string());
    }

    // Sanitize project name for filesystem
    let sanitized_name: String = project_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect::<String>()
        .trim()
        .replace(' ', "_");

    if sanitized_name.is_empty() {
        return Err("Invalid project name".to_string());
    }

    let project_path = parent.join(&sanitized_name);

    if project_path.exists() {
        return Err("A folder with this name already exists".to_string());
    }

    fs::create_dir_all(&project_path).map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(project_path.to_string_lossy().to_string())
}

// Read folder contents for project import
#[derive(serde::Serialize)]
struct FileEntry {
    path: String,
    content: Option<String>,
}

#[derive(serde::Serialize)]
struct FolderContents {
    folder_name: String,
    files: Vec<FileEntry>,
}

#[tauri::command]
fn read_folder_contents(folder_path: String) -> Result<FolderContents, String> {
    use std::fs;
    use std::path::Path;

    let path = Path::new(&folder_path);
    if !path.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let folder_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Project")
        .to_string();

    // Key files to read content from
    let key_files: &[&str] = &[
        "README.md",
        "readme.md",
        "Readme.md",
        "README.txt",
        "readme.txt",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        ".env.example",
        "main.py",
        "main.js",
        "index.js",
    ];

    let mut files = Vec::new();

    fn visit_dir(
        dir: &Path,
        base: &Path,
        files: &mut Vec<FileEntry>,
        key_files: &[&str],
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();
            let relative_path = path.strip_prefix(base).unwrap_or(&path);
            let relative_str = relative_path.to_string_lossy().to_string();

            if path.is_dir() {
                // Recursively visit subdirectories (limit depth by checking path components)
                if relative_path.components().count() < 3 {
                    visit_dir(&path, base, files, key_files)?;
                }
            } else {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

                // Check if this is a key file we want to read
                let is_key_file = key_files.iter().any(|k| file_name.eq_ignore_ascii_case(k));

                let content = if is_key_file {
                    // Read content for key files (limit size)
                    match fs::read_to_string(&path) {
                        Ok(text) => {
                            let max_len = 8000;
                            if text.len() > max_len {
                                // Truncate by CHAR boundary, not byte boundary —
                                // slicing at an arbitrary byte index panics if
                                // it lands inside a multi-byte UTF-8 sequence.
                                let truncated: String = text.chars().take(max_len).collect();
                                Some(truncated + "\n... (truncated)")
                            } else {
                                Some(text)
                            }
                        }
                        Err(_) => None,
                    }
                } else {
                    None
                };

                files.push(FileEntry {
                    path: relative_str,
                    content,
                });
            }
        }

        Ok(())
    }

    visit_dir(path, path, &mut files, key_files)?;

    // Limit total files to prevent overwhelming the UI
    if files.len() > 1000 {
        files.truncate(1000);
    }

    Ok(FolderContents { folder_name, files })
}

/// Check whether a filesystem path exists (file or directory). Used by the
/// frontend to prune recent-project entries whose folder has been moved or
/// deleted outside Koryphaios.
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

fn window_state(window: &WebviewWindow) -> AppResult<WindowState> {
    let scale_factor = window
        .scale_factor()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let size = window
        .inner_size()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let position = window
        .outer_position()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let maximized = window
        .is_maximized()
        .map_err(|e| AppError::Window(e.to_string()))?;

    Ok(WindowState {
        width: (size.width as f64 / scale_factor) as u32,
        height: (size.height as f64 / scale_factor) as u32,
        x: position.x,
        y: position.y,
        maximized,
    })
}

fn save_window_state(app: &tauri::AppHandle, state: WindowState) -> AppResult<()> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;

    std::fs::create_dir_all(&app_config_dir).map_err(|e| AppError::Io(e.to_string()))?;

    let state_path = app_config_dir.join("window-state.json");
    let json = serde_json::to_string(&state).map_err(|e| AppError::Serialization(e.to_string()))?;

    std::fs::write(&state_path, json).map_err(|e| AppError::Io(e.to_string()))?;

    Ok(())
}

// Kept for potential per-window restore; startup now always maximizes.
#[allow(dead_code)]
fn load_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let app_config_dir = app.path().app_config_dir().ok()?;
    let state_path = app_config_dir.join("window-state.json");

    let json = std::fs::read_to_string(&state_path).ok()?;
    serde_json::from_str(&json).ok()
}

#[cfg(target_os = "macos")]
fn create_native_menu(app: &tauri::AppHandle) -> AppResult<Menu<tauri::Wry>> {
    let config = AppConfig::get();
    // File menu
    let new_session =
        MenuItem::with_id(app, "new_session", "New Session", true, Some("CmdOrCtrl+N"))
            .map_err(|e| AppError::Menu(e.to_string()))?;
    let close_window = MenuItem::with_id(
        app,
        "close_window",
        "Close Window",
        true,
        Some("CmdOrCtrl+W"),
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))
        .map_err(|e| AppError::Menu(e.to_string()))?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_session,
            &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
            &close_window,
            &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
            &quit,
        ],
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    // Edit menu
    let undo = PredefinedMenuItem::undo(app, Some("Undo"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let redo = PredefinedMenuItem::redo(app, Some("Redo"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let cut = PredefinedMenuItem::cut(app, Some("Cut"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let copy = PredefinedMenuItem::copy(app, Some("Copy"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let paste = PredefinedMenuItem::paste(app, Some("Paste"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("Select All"))
        .map_err(|e| AppError::Menu(e.to_string()))?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
            &cut,
            &copy,
            &paste,
            &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
            &select_all,
        ],
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    // View menu
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let toggle_fullscreen = MenuItem::with_id(
        app,
        "toggle_fullscreen",
        "Toggle Fullscreen",
        true,
        Some("F11"),
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;
    let toggle_devtools = MenuItem::with_id(
        app,
        "toggle_devtools",
        "Toggle Developer Tools",
        true,
        Some("F12"),
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &reload,
            &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
            &toggle_fullscreen,
            &toggle_devtools,
        ],
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    // Window menu
    let minimize = MenuItem::with_id(app, "minimize", "Minimize", true, Some("CmdOrCtrl+M"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let zoom = MenuItem::with_id(app, "zoom", "Zoom", true, None::<&str>)
        .map_err(|e| AppError::Menu(e.to_string()))?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &minimize,
            &zoom,
            &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
            &PredefinedMenuItem::close_window(app, Some("Close"))
                .map_err(|e| AppError::Menu(e.to_string()))?,
        ],
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    // Help menu
    let about = MenuItem::with_id(
        app,
        "about",
        format!("About {}", config.app.name),
        true,
        None::<&str>,
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    let help_menu = Submenu::with_items(app, "Help", true, &[&about])
        .map_err(|e| AppError::Menu(e.to_string()))?;

    // Main menu bar
    let menu = Menu::with_items(
        app,
        &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
    .map_err(|e| AppError::Menu(e.to_string()))?;

    Ok(menu)
}

fn setup_system_tray(app: &tauri::AppHandle) -> AppResult<()> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)
        .map_err(|e| AppError::Tray(e.to_string()))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| AppError::Tray(e.to_string()))?;
    let separator =
        PredefinedMenuItem::separator(app).map_err(|e| AppError::Tray(e.to_string()))?;

    let menu = Menu::with_items(app, &[&show, &separator, &quit])
        .map_err(|e| AppError::Tray(e.to_string()))?;

    let tray_icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::Tray("No default icon found".to_string()))?;

    TrayIconBuilder::with_id("main-tray")
        .tooltip("Koryphaios")
        .icon(tray_icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)
        .map_err(|e| AppError::Tray(e.to_string()))?;

    Ok(())
}

fn setup_file_drop_handler(window: &WebviewWindow) {
    let window_clone = window.clone();

    // Handle file drop events
    window.listen("tauri://drag-drop", move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if let Some(paths) = payload.get("paths").and_then(|p| p.as_array()) {
                let file_paths: Vec<String> = paths
                    .iter()
                    .filter_map(|p| p.as_str().map(|s| s.to_string()))
                    .collect();

                if !file_paths.is_empty() {
                    let drop_payload = FileDropPayload {
                        paths: file_paths,
                        position: payload.get("position").and_then(|p| {
                            let x = p.get("x")?.as_f64()?;
                            let y = p.get("y")?.as_f64()?;
                            Some((x, y))
                        }),
                    };

                    let _ = window_clone.emit("file-drop", drop_payload);
                }
            }
        }
    });
}

/// A downloaded AppImage is a portable executable, not a system package, so a
/// browser download alone cannot add it to GNOME/KDE search. Register a user
/// launcher on every AppImage launch; if the user later moves the AppImage and
/// runs it again, the launcher follows the new location.
#[cfg(target_os = "linux")]
fn register_appimage_launcher() -> Result<(), String> {
    let appimage = match std::env::var("APPIMAGE") {
        Ok(path) if !path.is_empty() => std::path::PathBuf::from(path),
        _ => return Ok(()),
    };

    if !appimage.is_file() {
        return Ok(());
    }

    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .ok_or_else(|| {
            "Could not determine the user data directory for the app launcher".to_string()
        })?;
    let applications_dir = data_home.join("applications");
    std::fs::create_dir_all(&applications_dir)
        .map_err(|error| format!("Could not create the app launcher directory: {error}"))?;

    let executable = appimage
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    let desktop_entry = format!(
        "[Desktop Entry]\nType=Application\nName=Koryphaios\nGenericName=AI workspace\nComment=Coordinate AI agents and providers in a local desktop workspace\nExec=\"{executable}\"\nTerminal=false\nCategories=Development;Utility;\nStartupNotify=true\n"
    );
    std::fs::write(
        applications_dir.join("com.sylorlabs.koryphaios.desktop"),
        desktop_entry,
    )
    .map_err(|error| format!("Could not write the Koryphaios app launcher: {error}"))?;

    Ok(())
}

pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Force X11 backend on Linux to ensure custom titlebar dragging works correctly
        // This is a known workaround for Tauri v2 / GTK issues on certain window managers
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if let Err(error) = register_appimage_launcher() {
            eprintln!("[Koryphaios] Could not register AppImage launcher: {error}");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Start the bundled backend service (resource-based, not embedded).
            let config = AppConfig::get();
            let app_handle = app.handle().clone();

            match spawn_bundled_backend(&app_handle) {
                Ok(Some(process)) => {
                    let process_pid = process.lock().ok().map(|child| child.id());
                    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                        *guard = Some(process.clone());
                    }

                    let host = browser_host(&config.server.host).to_string();
                    let port = config.server.port;
                    let nav_handle = app_handle.clone();
                    let nav_host = host.clone();
                    let nav_process = process.clone();
                    let ready_handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let ready_result = wait_for_backend_ready(
                            &nav_host,
                            port,
                            120_000,
                            process_pid,
                            Some(nav_process.clone()),
                        )
                        .await;
                        match ready_result {
                            Err(e) => {
                                eprintln!("[Koryphaios] Warning: {}", e);
                                // Surface the initial readiness failure to the UI so
                                // the user sees the BackendDownOverlay instead of a
                                // blank WebView waiting for a navigation that never
                                // arrives.
                                emit_backend_down(
                                    &nav_handle,
                                    "initial-timeout",
                                    format!("Backend did not become ready: {e}"),
                                    process_pid,
                                );
                                // A live-but-unhealthy process would otherwise sit
                                // outside the exit-only watchdog forever. Killing
                                // it hands recovery to the normal restart loop.
                                if let Ok(mut child) = nav_process.lock() {
                                    let _ = child.kill();
                                }
                            }
                            Ok(actual_port) => {
                                // Keep the packaged UI on Tauri's local app origin.
                                // Navigating a native app to localhost makes macOS
                                // Screen Time treat it as a web site, so web limits
                                // can block Koryphaios rather than the app appearing
                                // under its own name. The frontend already obtains the
                                // local API/WS URLs through Tauri commands.
                                emit_backend_ready(&ready_handle, process_pid, nav_host.clone(), actual_port);
                            }
                        }
                    });

                    // Supervise: if the backend ever dies, restart it and
                    // reload the window. The app and backend live and die
                    // together — never a dead UI over a dead server.
                    let watch_handle = app_handle.clone();
                    let watch_host = host.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                            let exited = {
                                let guard = BACKEND_PROCESS.lock().ok();
                                match guard.as_ref().and_then(|g| g.as_ref()) {
                                    Some(proc_arc) => match proc_arc.lock() {
                                        Ok(mut child) => child.try_wait().ok().flatten().is_some(),
                                        Err(_) => false,
                                    },
                                    None => break, // intentionally stopped (app quit)
                                }
                            };
                            if !exited {
                                continue;
                            }
                            let dead_pid = BACKEND_PROCESS
                                .lock()
                                .ok()
                                .and_then(|g| g.as_ref().and_then(|p| p.lock().ok().map(|c| c.id())));
                            eprintln!("[Koryphaios] Backend died — restarting...");
                            emit_backend_down(
                                &watch_handle,
                                "exited",
                                "Backend process exited; supervisor is restarting it.".to_string(),
                                dead_pid,
                            );
                            match spawn_bundled_backend(&watch_handle) {
                                Ok(Some(new_proc)) => {
                                    let new_pid = new_proc.lock().ok().map(|child| child.id());
                                    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                                        *guard = Some(new_proc.clone());
                                    }
                                    let ready = wait_for_backend_ready(
                                        &watch_host,
                                        port,
                                        60_000,
                                        new_pid,
                                        Some(new_proc.clone()),
                                    )
                                    .await;
                                    match ready {
                                        Ok(actual_port) => {
                                            // Do not navigate the packaged WebView
                                            // to localhost on backend recovery; its
                                            // health sentinel resumes API traffic.
                                            emit_backend_ready(
                                                &watch_handle,
                                                new_pid,
                                                watch_host.clone(),
                                                actual_port,
                                            );
                                        }
                                        Err(_) => {
                                            emit_backend_down(
                                                &watch_handle,
                                                "restart-timeout",
                                                "Restarted backend did not become ready; retrying.".to_string(),
                                                new_pid,
                                            );
                                            if let Ok(mut child) = new_proc.lock() {
                                                let _ = child.kill();
                                            }
                                        }
                                    }
                                }
                                _ => {
                                    eprintln!(
                                        "[Koryphaios] Backend restart failed; retrying in 5s"
                                    );
                                    emit_backend_down(
                                        &watch_handle,
                                        "restart-failed",
                                        "Supervisor could not spawn a new backend process; retrying.".to_string(),
                                        None,
                                    );
                                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                                }
                            }
                        }
                    });
                }
                Ok(None) => {
                    // Dev mode: the launcher owns the backend. But the Tauri
                    // app can outlive the launcher — when the terminal that ran
                    // `bun run dev` closes, the launcher dies and SIGTERMs its
                    // backend, while this process (detached, reparented to
                    // init/systemd) survives. Without a supervisor the app is
                    // left showing a dead UI over a dead port with no recovery.
                    //
                    // Start a dev-mode supervisor that polls /api/health and
                    // spawns `bun run src/server.ts` itself if the backend stays
                    // unreachable. While the launcher's backend is healthy it
                    // does nothing, so there's no conflict with a live launcher.
                    if let Some(backend_dir) = resolve_dev_backend_dir() {
                        let sup_handle = app_handle.clone();
                        let sup_host = browser_host(&config.server.host).to_string();
                        let sup_port = config.server.port;
                        tauri::async_runtime::spawn(async move {
                            dev_backend_supervisor(sup_handle, backend_dir, sup_host, sup_port)
                                .await;
                        });
                    } else {
                        println!(
                            "[Koryphaios] Dev mode: no bundled backend and no source tree found — launcher owns the backend"
                        );
                    }
                }
                Err(e) => {
                    // A release without its backend is not a functioning app.
                    // Fail startup instead of showing a frontend that can
                    // never authenticate, load data, or recover.
                    return Err(std::io::Error::other(format!(
                        "Failed to start bundled backend: {e}"
                    ))
                    .into());
                }
            }

            // NOTE: Native menu bar is disabled for frameless window mode.
            // Koryphaios provides its own custom menu bar in the frontend.
            // The native menu is only created on macOS where it's expected,
            // but hidden on Linux/Windows for a cleaner frameless experience.
            #[cfg(target_os = "macos")]
            {
                match create_native_menu(app.handle()) {
                    Ok(menu) => {
                        if let Err(e) = app.set_menu(menu) {
                            log_error("menu setup", &e);
                        }
                    }
                    Err(e) => {
                        log_error("menu creation", &e);
                        eprintln!("[Koryphaios] Warning: Failed to create native menu: {}", e);
                    }
                }
            }

            // Set up menu event handler (macOS only)
            #[cfg(target_os = "macos")]
            app.on_menu_event(|app, event| {
                match event.id.as_ref() {
                    "new_session" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu-action", "new_session");
                        }
                    }
                    "close_window" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.close();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.location.reload()");
                        }
                    }
                    "toggle_fullscreen" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_fullscreen = window.is_fullscreen().unwrap_or(false);
                            let _ = window.set_fullscreen(!is_fullscreen);
                        }
                    }
                    "toggle_devtools" => {
                        if let Some(window) = app.get_webview_window("main") {
                            // Enable devtools in all builds for debugging
                            window.open_devtools();
                        }
                    }
                    "minimize" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.minimize();
                        }
                    }
                    "about" => {
                        // Use a simple message dialog via tauri-plugin-dialog
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("show-about", ());
                        }
                    }
                    _ => {}
                }
            });

            // Set up system tray
            if let Err(e) = setup_system_tray(app.handle()) {
                log_error("system tray setup", &e);
                eprintln!("[Koryphaios] Warning: Failed to create system tray: {}", e);
                eprintln!("[Koryphaios] The app will continue without system tray support.");
            }

            // Get main window and ensure visibility
            if let Some(window) = app.get_webview_window("main") {
                // Start filling the work area while keeping normal window
                // resizing available. Fullscreen is user-controlled. On macOS
                // the frameless window's maximize() is unreliable and leaves
                // tao state that fights later resizes, so zoom_to_work_area
                // enforces the frame synchronously after show instead.
                #[cfg(not(target_os = "macos"))]
                let _ = window.maximize();

                // CRITICAL: Always force show, focus, and unminimize to ensure window is visible on launch
                println!("[Koryphaios] Main window initialized, forcing visibility...");
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();

                // Frameless windows ignore zoom on macOS, so grow to the work
                // area instead (after show, so AppKit constrains the final
                // frame rather than a half-applied one).
                zoom_to_work_area(&window);

                // Unplugging or re-arranging a display moves the window but
                // never resizes it, so the frame has to be repaired whenever
                // the layout changes underneath it.
                watch_display_changes(app.handle().clone());

                // Set up file drop handler
                setup_file_drop_handler(&window);

                // On Linux/WebKitGTK, getUserMedia (microphone) is denied by
                // default unless the app handles the webview's permission-request
                // signal. Tauri 2.10 does not yet expose the wry permission
                // handler API, so connect directly to the WebKitGTK signal and
                // allow media permission requests. This unblocks the composer
                // microphone / voice input feature on Linux.
                #[cfg(target_os = "linux")]
                {
                    let webview_window = window.clone();
                    let _ = webview_window.with_webview(|webview| {
                        use webkit2gtk::{PermissionRequestExt, WebViewExt};
                        let webkit_webview = webview.inner();
                        webkit_webview.connect_permission_request(
                            |_wv, request: &webkit2gtk::PermissionRequest| {
                                // Allow all permission requests (microphone, camera,
                                // notifications, clipboard, etc.). The frontend
                                // already gates sensitive features behind explicit
                                // user toggles (e.g. Voice settings), so granting at
                                // the platform level only lifts the WebKitGTK
                                // default denial.
                                request.allow();
                                // Returning true means we handled the request.
                                true
                            },
                        );
                    });
                }

                // Persisting geometry on macOS queries `is_maximized()` from a
                // resize callback. On current macOS releases that query can
                // itself trigger another resize/style update, creating a tight
                // AppKit event loop before the WebView gets a chance to load.
                // Keep persistence on the other platforms; macOS can safely
                // use its normal initial window geometry until this is fixed
                // upstream in tao/wry.
                #[cfg(not(target_os = "macos"))]
                {
                    let app_handle = app.handle().clone();
                    window.on_window_event(move |event| {
                        match event {
                            WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    // Don't save state if maximized
                                    if let Ok(false) = window.is_maximized() {
                                        if let Ok(state) = window_state(&window) {
                                            let _ = save_window_state(&app_handle, state);
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    });
                }
            }

            // Set up exit handler to kill backend
            let app_handle_clone = app.handle().clone();
            app_handle_clone
                .run_on_main_thread(|| {
                    // Cleanup happens automatically via Drop, but we ensure it here
                })
                .ok();

            Ok(())
        })
        .on_window_event(|_app, event| {
            if let WindowEvent::Destroyed = event {
                kill_backend();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_url,
            get_websocket_url,
            get_app_version,
            show_main_window,
            toggle_fullscreen,
            minimize_to_tray,
            minimize_window_cmd,
            toggle_maximize,
            close_window_cmd,
            select_folder_dialog,
            select_files_dialog,
            select_voice_model_dialog,
            local_voice::local_voice_model_status,
            local_voice::download_local_voice_model,
            local_voice::attach_local_voice_model,
            local_voice::transcribe_local_voice,
            create_project_folder,
            read_folder_contents,
            path_exists,
            indexer::search_codebase,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koryphaios desktop app");
}

#[cfg(test)]
mod tests {
    use super::{
        copy_backend_resource, dev_backend_binding, frame_for_display_change,
        merge_packaged_cors_origins, open_private_backend_logs, restore_frame_for_work_area,
        validate_log_file_name,
    };
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A 2560x1410 window on an external display, unplugged onto a 1512x945
    /// built-in panel: the exact case where macOS relocates the window but
    /// leaves it wider than the screen it moved to.
    const EXTERNAL_WORK_AREA: [f64; 4] = [0.0, 0.0, 2560.0, 1410.0];
    const BUILT_IN_WORK_AREA: [f64; 4] = [0.0, 25.0, 1512.0, 945.0];

    #[test]
    fn unplugging_a_display_refills_a_work_area_window() {
        let target = frame_for_display_change(
            &BUILT_IN_WORK_AREA,
            &EXTERNAL_WORK_AREA,
            Some(EXTERNAL_WORK_AREA),
        );
        assert_eq!(target, Some(BUILT_IN_WORK_AREA));
    }

    #[test]
    fn unplugging_a_display_shrinks_a_user_sized_window_without_growing_it() {
        let user_sized = [200.0, 100.0, 1200.0, 800.0];
        assert_eq!(
            frame_for_display_change(&BUILT_IN_WORK_AREA, &user_sized, Some(EXTERNAL_WORK_AREA)),
            None,
            "a window the user sized must be left alone when it still fits"
        );
    }

    #[test]
    fn an_oversized_user_sized_window_is_shrunk_and_slid_inside_the_work_area() {
        let oversized = [900.0, 100.0, 2200.0, 1200.0];
        let target =
            frame_for_display_change(&BUILT_IN_WORK_AREA, &oversized, Some(EXTERNAL_WORK_AREA))
                .expect("a window wider than the new display must be repaired");
        assert_eq!(target[2], 1512.0, "shrunk to the new display width");
        assert_eq!(target[3], 945.0, "shrunk to the new display height");
        assert_eq!(target[0], 0.0, "flush with the left of the work area");
        assert_eq!(target[1], 25.0, "flush with the bottom of the work area");
    }

    #[test]
    fn a_window_hanging_off_the_new_display_is_left_where_the_user_put_it() {
        // Dragging a window partly off-screen to see what is behind it is a
        // normal thing to do. The window fits, so only its size could ever be
        // a bug.
        let dragged = [1600.0, 400.0, 800.0, 600.0];
        assert_eq!(frame_for_display_change(&BUILT_IN_WORK_AREA, &dragged, None), None);
    }

    #[test]
    fn an_oversized_window_off_the_edge_of_the_new_display_is_shrunk_and_pulled_back() {
        // The external display sat to the right of the built-in one, so
        // unplugging it leaves an over-sized window's origin past the new
        // display's right edge.
        let offscreen = [1600.0, 400.0, 2200.0, 1200.0];
        let target =
            frame_for_display_change(&BUILT_IN_WORK_AREA, &offscreen, None).expect("must repair");
        assert_eq!(target[2], 1512.0);
        assert_eq!(target[3], 945.0);
        assert!(target[0] + target[2] <= BUILT_IN_WORK_AREA[0] + BUILT_IN_WORK_AREA[2]);
        assert!(target[1] + target[3] <= BUILT_IN_WORK_AREA[1] + BUILT_IN_WORK_AREA[3]);
    }

    #[test]
    fn a_window_already_inside_the_new_display_is_left_untouched() {
        let settled = [100.0, 100.0, 1200.0, 800.0];
        assert_eq!(frame_for_display_change(&BUILT_IN_WORK_AREA, &settled, None), None);
    }

    #[test]
    fn degenerate_geometry_is_rejected_rather_than_applied() {
        assert_eq!(
            frame_for_display_change(&[0.0, 0.0, 0.0, 0.0], &EXTERNAL_WORK_AREA, None),
            None
        );
        assert_eq!(
            frame_for_display_change(&BUILT_IN_WORK_AREA, &[0.0, 0.0, 0.0, 0.0], None),
            None
        );
    }

    #[test]
    fn a_restored_frame_stays_inside_the_new_work_area() {
        let restore = restore_frame_for_work_area(&BUILT_IN_WORK_AREA);
        assert!(restore[0] >= BUILT_IN_WORK_AREA[0]);
        assert!(restore[1] >= BUILT_IN_WORK_AREA[1]);
        assert!(restore[0] + restore[2] <= BUILT_IN_WORK_AREA[0] + BUILT_IN_WORK_AREA[2] + 1.0);
        assert!(restore[1] + restore[3] <= BUILT_IN_WORK_AREA[1] + BUILT_IN_WORK_AREA[3] + 1.0);
    }

    #[test]
    fn packaged_cors_origins_include_exact_tauri_application_origins() {
        let origins = merge_packaged_cors_origins(Some(
            "https://app.example.test,http://tauri.localhost,https://app.example.test",
        ))
        .expect("explicit origins should be accepted");
        assert_eq!(
            origins,
            "https://app.example.test,http://tauri.localhost,https://tauri.localhost,tauri://localhost"
        );
        assert!(!origins.split(',').any(|origin| origin == "*"));
    }

    #[test]
    fn packaged_cors_origins_reject_wildcard_configuration() {
        let error = merge_packaged_cors_origins(Some("*,http://tauri.localhost"))
            .expect_err("wildcard configuration must fail closed");
        assert!(error.contains("wildcard CORS_ORIGINS"));
    }

    #[test]
    fn dev_supervisor_replacement_uses_the_supervised_launcher_binding() {
        // The app config may have a different default port (for example 3002),
        // but a replacement for a launcher-owned backend must bind the exact
        // host/port that the supervisor is polling (normally 3001).
        assert_eq!(
            dev_backend_binding("127.0.0.1", 3001),
            ("127.0.0.1".into(), "3001".into())
        );
        assert_eq!(
            dev_backend_binding("127.0.0.1", 3017),
            ("127.0.0.1".into(), "3017".into())
        );
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "koryphaios-log-permissions-{label}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&path).expect("unique test directory should be creatable");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn compressed_backend_resource_is_materialized_with_a_hard_limit() {
        let directory = TestDirectory::new("backend-resource");
        let source = directory.path().join("backend.gz");
        let destination = directory.path().join("backend");
        let payload = b"opaque backend payload";
        let file = std::fs::File::create(&source).expect("compressed source should be writable");
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder.write_all(payload).expect("payload should compress");
        encoder.finish().expect("gzip stream should finish");

        let bytes = copy_backend_resource(&source, &destination, 1024)
            .expect("compressed resource should materialize");
        assert_eq!(bytes, payload.len() as u64);
        assert_eq!(
            std::fs::read(&destination).expect("destination should be readable"),
            payload
        );
    }

    #[test]
    fn backend_resource_limit_rejects_oversized_raw_and_compressed_payloads() {
        let directory = TestDirectory::new("backend-resource-limit");
        let raw = directory.path().join("backend");
        let compressed = directory.path().join("backend.gz");
        let raw_destination = directory.path().join("raw-out");
        let compressed_destination = directory.path().join("compressed-out");
        let payload = vec![b'x'; 65];
        std::fs::write(&raw, &payload).expect("raw source should be writable");
        let file =
            std::fs::File::create(&compressed).expect("compressed source should be writable");
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder
            .write_all(&payload)
            .expect("payload should compress");
        encoder.finish().expect("gzip stream should finish");

        assert!(copy_backend_resource(&raw, &raw_destination, 64).is_err());
        assert!(copy_backend_resource(&compressed, &compressed_destination, 64).is_err());
    }

    #[test]
    fn private_backend_logs_reject_path_components() {
        for invalid in ["", ".", "..", "../escape", "nested/backend.log"] {
            assert!(
                validate_log_file_name(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
        assert!(validate_log_file_name("backend.log").is_ok());
    }

    #[test]
    fn private_backend_logs_preserve_existing_content() {
        let root = TestDirectory::new("preserve");
        let logs = root.path().join("logs");
        std::fs::create_dir(&logs).expect("logs directory should be creatable");
        std::fs::write(logs.join("backend.log"), b"existing\n")
            .expect("existing log should be writable");
        std::fs::write(logs.join("backend.err.log"), b"existing error\n")
            .expect("existing error log should be writable");

        let (mut stdout, mut stderr) =
            open_private_backend_logs(&logs, "backend.log", "backend.err.log")
                .expect("private logs should open");
        stdout.write_all(b"next\n").expect("stdout should append");
        stderr
            .write_all(b"next error\n")
            .expect("stderr should append");
        drop((stdout, stderr));

        assert_eq!(
            std::fs::read(logs.join("backend.log")).expect("stdout log should be readable"),
            b"existing\nnext\n"
        );
        assert_eq!(
            std::fs::read(logs.join("backend.err.log")).expect("stderr log should be readable"),
            b"existing error\nnext error\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_backend_logs_create_and_heal_unix_modes() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDirectory::new("modes");
        let logs = root.path().join("logs");

        drop(
            open_private_backend_logs(&logs, "backend.log", "backend.err.log")
                .expect("missing private logs should be created"),
        );
        assert_eq!(
            std::fs::metadata(&logs)
                .expect("created logs metadata should be available")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for name in ["backend.log", "backend.err.log"] {
            assert_eq!(
                std::fs::metadata(logs.join(name))
                    .expect("created log metadata should be available")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o777))
            .expect("directory mode should be adjustable");
        for name in ["backend.log", "backend.err.log"] {
            let path = logs.join(name);
            std::fs::write(&path, b"sentinel\n").expect("log should be writable");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))
                .expect("file mode should be adjustable");
        }

        drop(
            open_private_backend_logs(&logs, "backend.log", "backend.err.log")
                .expect("private logs should open"),
        );

        assert_eq!(
            std::fs::metadata(&logs)
                .expect("logs metadata should be available")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for name in ["backend.log", "backend.err.log"] {
            let path = logs.join(name);
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("log metadata should be available")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::read(&path).expect("log should remain readable"),
                b"sentinel\n"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn private_backend_logs_reject_directory_and_file_symlinks() {
        use std::os::unix::fs::symlink;

        let root = TestDirectory::new("symlinks");
        let real_logs = root.path().join("real-logs");
        std::fs::create_dir(&real_logs).expect("real logs directory should be creatable");
        let linked_logs = root.path().join("logs");
        symlink(&real_logs, &linked_logs).expect("directory symlink should be creatable");
        assert!(
            open_private_backend_logs(&linked_logs, "backend.log", "backend.err.log").is_err(),
            "a symlinked log directory must be rejected"
        );

        std::fs::remove_file(&linked_logs).expect("directory symlink should be removable");
        std::fs::create_dir(&linked_logs).expect("logs directory should be creatable");
        let outside = root.path().join("outside.log");
        std::fs::write(&outside, b"do not touch\n").expect("outside file should be writable");
        symlink(&outside, linked_logs.join("backend.log"))
            .expect("file symlink should be creatable");
        assert!(
            open_private_backend_logs(&linked_logs, "backend.log", "backend.err.log").is_err(),
            "a symlinked log file must be rejected"
        );
        assert_eq!(
            std::fs::read(&outside).expect("outside file should remain readable"),
            b"do not touch\n"
        );

        std::fs::remove_file(linked_logs.join("backend.log"))
            .expect("stdout symlink should be removable");
        symlink(&outside, linked_logs.join("backend.err.log"))
            .expect("stderr symlink should be creatable");
        assert!(
            open_private_backend_logs(&linked_logs, "backend.log", "backend.err.log").is_err(),
            "a symlinked stderr log must be rejected"
        );
        assert_eq!(
            std::fs::read(&outside).expect("outside file should remain readable"),
            b"do not touch\n"
        );
    }
}
