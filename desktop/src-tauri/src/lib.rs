use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

// Cached updater so install_update doesn't re-fetch the manifest every click.
// tauri_plugin_updater::Update is not Clone, so we hold it behind a Mutex.
static CACHED_UPDATE: Mutex<Option<tauri_plugin_updater::Update>> = Mutex::new(None);

// Download timeout: 137 MB at even 1 Mbps = ~1100s; 120s is generous for
// healthy connections and prevents the "stalled download hangs forever" bug
// (tauri-plugin-updater hardcodes Update.timeout = None on check()).
const UPDATE_DOWNLOAD_TIMEOUT_SECS: u64 = 120;

// Global backend process handle
static BACKEND_PROCESS: Mutex<Option<Arc<std::sync::Mutex<std::process::Child>>>> =
    Mutex::new(None);

include!(concat!(env!("OUT_DIR"), "/embedded_backend.rs"));

mod config;
mod error;
mod indexer;
use config::{browser_host, AppConfig};
use error::{log_error, AppError, AppResult};

fn materialize_embedded_backend(
    app_handle: &tauri::AppHandle,
) -> Result<Option<std::path::PathBuf>, String> {
    let Some(payload) = EMBEDDED_BACKEND else {
        return Ok(None);
    };
    let runtime_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache directory: {e}"))?
        .join("runtime");
    std::fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("Failed to create backend runtime directory: {e}"))?;
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
    let current_size = std::fs::metadata(&destination).map(|m| m.len()).ok();
    if current_size != Some(payload.len() as u64) {
        let temporary = destination.with_extension("new");
        std::fs::write(&temporary, payload)
            .map_err(|e| format!("Failed to materialize embedded backend: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("Failed to make embedded backend executable: {e}"))?;
        }
        std::fs::rename(&temporary, &destination)
            .map_err(|e| format!("Failed to activate embedded backend: {e}"))?;
    }
    Ok(Some(destination))
}

/// Start the backend embedded in the desktop executable.
fn spawn_embedded_backend(
    app_handle: &tauri::AppHandle,
) -> Result<Option<Arc<std::sync::Mutex<std::process::Child>>>, String> {
    let backend_path = match materialize_embedded_backend(app_handle)? {
        Some(path) => path,
        None => {
            println!("[Koryphaios] Dev mode: launcher owns the backend");
            return Ok(None);
        }
    };

    println!("[Koryphaios] Starting embedded backend service");

    let mut cmd = std::process::Command::new(&backend_path);
    // NEVER pipe without a reader: the backend logs heavily and a full 64KB
    // pipe buffer blocks its writes — the whole backend freezes mid-session.
    // Log to files in the data dir instead (also gives users a crash log).
    let log_dir = app_handle
        .path()
        .app_data_dir()
        .map(|d| d.join("logs"))
        .ok();
    if let Some(dir) = &log_dir {
        let _ = std::fs::create_dir_all(dir);
        let open = |name: &str| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(name))
        };
        match (open("backend.log"), open("backend.err.log")) {
            (Ok(out), Ok(err)) => {
                cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
            }
            _ => {
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
        "[Koryphaios] Embedded backend started with PID {}",
        child.id()
    );

    Ok(Some(Arc::new(std::sync::Mutex::new(child))))
}

/// Wait for backend to be ready by polling health endpoint
async fn wait_for_backend_ready(
    host: &str,
    port: u16,
    max_wait_ms: u64,
    expected_pid: Option<u32>,
    process: Option<Arc<std::sync::Mutex<std::process::Child>>>,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let health_url = format!("http://{}:{}/api/health", host, port);
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
                        "Embedded backend exited before becoming ready ({status})"
                    ));
                }
            }
        }

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
                        println!("[Koryphaios] Backend is ready!");
                        return Ok(());
                    }
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    Err(format!(
        "Backend failed to become ready within {}ms",
        max_wait_ms
    ))
}

/// Kill the backend process
fn kill_backend() {
    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
        if let Some(process_arc) = guard.take() {
            if let Ok(mut process) = process_arc.lock() {
                println!("[Koryphaios] Stopping embedded backend...");
                let _ = process.kill();
            }
        }
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
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
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
    use tauri_plugin_updater::UpdaterExt;

    // Try the cached Update from check_for_updates first; only re-fetch if the
    // cache is empty (e.g. the user clicked Install without a prior check, or
    // the app was restarted and the static was cleared).
    let update_opt = CACHED_UPDATE.lock().ok().and_then(|mut c| c.take());
    let mut update = match update_opt {
        Some(u) => u,
        None => {
            let updater = app.updater().map_err(|e| e.to_string())?;
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

#[tauri::command]
fn show_main_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.unminimize();
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!is_fullscreen);
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
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
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
                                Some(text[..max_len].to_string() + "\n... (truncated)")
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

// A workspace is an organizational root. Its immediate child directories are
// offered as projects, but none becomes the working directory until selected.
#[tauri::command]
fn list_workspace_projects(folder_path: String) -> Result<Vec<String>, String> {
    let root = std::path::Path::new(&folder_path);
    if !root.is_dir() {
        return Err("Workspace folder does not exist".to_string());
    }
    let mut projects = std::fs::read_dir(root)
        .map_err(|e| format!("Failed to read workspace: {}", e))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| !name.starts_with('.'))
                .unwrap_or(false)
        })
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    projects.sort();
    Ok(projects)
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
    let cut = MenuItem::with_id(app, "cut", "Cut", true, Some("CmdOrCtrl+X"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let copy = MenuItem::with_id(app, "copy", "Copy", true, Some("CmdOrCtrl+C"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let paste = MenuItem::with_id(app, "paste", "Paste", true, Some("CmdOrCtrl+V"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let select_all = MenuItem::with_id(app, "select_all", "Select All", true, Some("CmdOrCtrl+A"))
        .map_err(|e| AppError::Menu(e.to_string()))?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
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
        &format!("About {}", config.app.name),
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
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload()) {
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

pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Force X11 backend on Linux to ensure custom titlebar dragging works correctly
        // This is a known workaround for Tauri v2 / GTK issues on certain window managers
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
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
            // Start the backend payload embedded in production builds.
            let config = AppConfig::get();
            let app_handle = app.handle().clone();

            match spawn_embedded_backend(&app_handle) {
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
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = wait_for_backend_ready(
                            &nav_host,
                            port,
                            120_000,
                            process_pid,
                            Some(nav_process.clone()),
                        )
                        .await
                        {
                            eprintln!("[Koryphaios] Warning: {}", e);
                            // A live-but-unhealthy process would otherwise sit
                            // outside the exit-only watchdog forever. Killing
                            // it hands recovery to the normal restart loop.
                            if let Ok(mut child) = nav_process.lock() {
                                let _ = child.kill();
                            }
                            return;
                        }
                        // Backend is up and serving the bundled frontend —
                        // navigate the window there so the ENTIRE app runs
                        // from one origin (API, WS, images: all same-origin).
                        if let Some(window) = nav_handle.get_webview_window("main") {
                            let url = format!("http://{}:{}/", nav_host, port);
                            if let Ok(parsed) = url.parse() {
                                if let Err(e) = window.navigate(parsed) {
                                    eprintln!("[Koryphaios] Failed to navigate to backend: {}", e);
                                }
                            }
                        }
                    });

                    // Supervise: if the backend ever dies, restart it and
                    // reload the window. The app and backend live and die
                    // together — never a dead UI over a dead server.
                    let watch_handle = app_handle.clone();
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
                            eprintln!("[Koryphaios] Backend died — restarting...");
                            match spawn_embedded_backend(&watch_handle) {
                                Ok(Some(new_proc)) => {
                                    let new_pid = new_proc.lock().ok().map(|child| child.id());
                                    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                                        *guard = Some(new_proc.clone());
                                    }
                                    let ready = wait_for_backend_ready(
                                        &host,
                                        port,
                                        60_000,
                                        new_pid,
                                        Some(new_proc.clone()),
                                    )
                                    .await
                                    .is_ok();
                                    if ready {
                                        if let Some(window) =
                                            watch_handle.get_webview_window("main")
                                        {
                                            let url = format!("http://{}:{}/", host, port);
                                            if let Ok(parsed) = url.parse() {
                                                let _ = window.navigate(parsed);
                                            }
                                        }
                                    } else if let Ok(mut child) = new_proc.lock() {
                                        let _ = child.kill();
                                    }
                                }
                                _ => {
                                    eprintln!(
                                        "[Koryphaios] Backend restart failed; retrying in 5s"
                                    );
                                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                                }
                            }
                        }
                    });
                }
                Ok(None) => {}
                Err(e) => {
                    // A release without its backend is not a functioning app.
                    // Fail startup instead of showing a frontend that can
                    // never authenticate, load data, or recover.
                    return Err(std::io::Error::other(format!(
                        "Failed to start embedded backend: {e}"
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
                            let _ = window.open_devtools();
                        }
                    }
                    "minimize" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.minimize();
                        }
                    }
                    "about" => {
                        let config = AppConfig::get();
                        // Use a simple message dialog via tauri-plugin-dialog
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("show-about", {
                                let _ = ();
                            });
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
                // Startup default is always full-screen (maximized) regardless
                // of the saved window state — the user can resize afterwards.
                let _ = window.maximize();

                // CRITICAL: Always force show, focus, and unminimize to ensure window is visible on launch
                println!("[Koryphaios] Main window initialized, forcing visibility...");
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();

                // Set up file drop handler
                setup_file_drop_handler(&window);

                // Set up window event handler for state persistence
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
            create_project_folder,
            read_folder_contents,
            list_workspace_projects,
            indexer::search_codebase,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koryphaios desktop app");
}
