use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent, Emitter, WebviewWindow, Listener,
};
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use std::sync::Mutex;
use std::process::Stdio;
use std::sync::Arc;
use tauri_plugin_dialog::DialogExt;

// Global backend process handle
static BACKEND_PROCESS: Mutex<Option<Arc<std::sync::Mutex<std::process::Child>>>> = Mutex::new(None);

mod config;
mod error;
mod indexer;
use config::AppConfig;
use error::{AppError, AppResult, log_error};

/// Spawn the backend sidecar process
fn spawn_backend_sidecar(app_handle: &tauri::AppHandle) -> Result<Arc<std::sync::Mutex<std::process::Child>>, String> {
    let sidecar_path = app_handle.path()
        .resolve("sidecar/koryphaios-backend", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve sidecar path: {}", e))?;
    
    // Check if sidecar exists (production build)
    if !sidecar_path.exists() {
        // In development, backend is started separately
        println!("[Koryphaios] Sidecar not found at {:?}, assuming development mode", sidecar_path);
        return Err("Sidecar not found - development mode".to_string());
    }
    
    println!("[Koryphaios] Starting backend sidecar from {:?}", sidecar_path);
    
    let mut cmd = std::process::Command::new(&sidecar_path);
    cmd.stdout(Stdio::piped())
       .stderr(Stdio::piped());
    
    // Set environment variables for the backend
    let config = AppConfig::get();
    cmd.env("KORYPHAIOS_PORT", config.server.port.to_string());
    cmd.env("KORYPHAIOS_HOST", &config.server.host);
    cmd.env("NODE_ENV", "production");
    
    // Set data directory
    if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
        cmd.env("KORYPHAIOS_DATA_DIR", &app_data_dir);
    }
    
    let child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn backend: {}", e))?;
    
    println!("[Koryphaios] Backend sidecar started with PID {}", child.id());
    
    Ok(Arc::new(std::sync::Mutex::new(child)))
}

/// Wait for backend to be ready by polling health endpoint
async fn wait_for_backend_ready(host: &str, port: u16, max_wait_ms: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    let health_url = format!("http://{}:{}/api/health", host, port);
    
    while (start.elapsed().as_millis() as u64) < max_wait_ms {
        // Try to connect to health endpoint
        if let Ok(response) = reqwest::get(&health_url).await {
            if response.status().is_success() {
                println!("[Koryphaios] Backend is ready!");
                return Ok(());
            }
        }
        
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
    
    Err(format!("Backend failed to become ready within {}ms", max_wait_ms))
}

/// Kill the backend process
fn kill_backend() {
    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
        if let Some(process_arc) = guard.take() {
            if let Ok(mut process) = process_arc.lock() {
                println!("[Koryphaios] Stopping backend sidecar...");
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
    let result = app.dialog()
        .file()
        .set_title("Select Folder Location")
        .blocking_pick_folder();
    
    Ok(result.map(|p| p.to_string()))
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
    
    fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    
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
    
    let folder_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Project")
        .to_string();
    
    // Key files to read content from
    let key_files: &[&str] = &[
        "README.md", "readme.md", "Readme.md", "README.txt", "readme.txt",
        "package.json", "Cargo.toml", "pyproject.toml", "go.mod", ".env.example", "main.py", "main.js", "index.js"
    ];
    
    let mut files = Vec::new();
    
    fn visit_dir(dir: &Path, base: &Path, files: &mut Vec<FileEntry>, key_files: &[&str]) -> Result<(), String> {
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
                let file_name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                
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

fn window_state(window: &WebviewWindow) -> AppResult<WindowState> {
    let scale_factor = window.scale_factor()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let size = window.inner_size()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let position = window.outer_position()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let maximized = window.is_maximized()
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
    let app_config_dir = app.path().app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    
    std::fs::create_dir_all(&app_config_dir)
        .map_err(|e| AppError::Io(e.to_string()))?;
    
    let state_path = app_config_dir.join("window-state.json");
    let json = serde_json::to_string(&state)
        .map_err(|e| AppError::Serialization(e.to_string()))?;
    
    std::fs::write(&state_path, json)
        .map_err(|e| AppError::Io(e.to_string()))?;
    
    Ok(())
}

fn load_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let app_config_dir = app.path().app_config_dir().ok()?;
    let state_path = app_config_dir.join("window-state.json");
    
    let json = std::fs::read_to_string(&state_path).ok()?;
    serde_json::from_str(&json).ok()
}

#[cfg(target_os = "macos")]
fn create_native_menu(app: &tauri::AppHandle) -> AppResult<Menu<tauri::Wry>> {
    // File menu
    let new_session = MenuItem::with_id(app, "new_session", "New Session", true, Some("CmdOrCtrl+N"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let close_window = MenuItem::with_id(app, "close_window", "Close Window", true, Some("CmdOrCtrl+W"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    
    let file_menu = Submenu::with_items(app, "File", true, &[
        &new_session,
        &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
        &close_window,
        &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
        &quit,
    ]).map_err(|e| AppError::Menu(e.to_string()))?;
    
    // Edit menu
    let cut = MenuItem::with_id(app, "cut", "Cut", true, Some("CmdOrCtrl+X"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let copy = MenuItem::with_id(app, "copy", "Copy", true, Some("CmdOrCtrl+C"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let paste = MenuItem::with_id(app, "paste", "Paste", true, Some("CmdOrCtrl+V"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let select_all = MenuItem::with_id(app, "select_all", "Select All", true, Some("CmdOrCtrl+A"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    
    let edit_menu = Submenu::with_items(app, "Edit", true, &[
        &cut,
        &copy,
        &paste,
        &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
        &select_all,
    ]).map_err(|e| AppError::Menu(e.to_string()))?;
    
    // View menu
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let toggle_fullscreen = MenuItem::with_id(app, "toggle_fullscreen", "Toggle Fullscreen", true, Some("F11"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let toggle_devtools = MenuItem::with_id(app, "toggle_devtools", "Toggle Developer Tools", true, Some("F12"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    
    let view_menu = Submenu::with_items(app, "View", true, &[
        &reload,
        &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
        &toggle_fullscreen,
        &toggle_devtools,
    ]).map_err(|e| AppError::Menu(e.to_string()))?;
    
    // Window menu
    let minimize = MenuItem::with_id(app, "minimize", "Minimize", true, Some("CmdOrCtrl+M"))
        .map_err(|e| AppError::Menu(e.to_string()))?;
    let zoom = MenuItem::with_id(app, "zoom", "Zoom", true, None::<&str>)
        .map_err(|e| AppError::Menu(e.to_string()))?;
    
    let window_menu = Submenu::with_items(app, "Window", true, &[
        &minimize,
        &zoom,
        &PredefinedMenuItem::separator(app).map_err(|e| AppError::Menu(e.to_string()))?,
        &PredefinedMenuItem::close_window(app, Some("Close")).map_err(|e| AppError::Menu(e.to_string()))?,
    ]).map_err(|e| AppError::Menu(e.to_string()))?;
    
    // Help menu
    let about = MenuItem::with_id(app, "about", &format!("About {}", config.app.name), true, None::<&str>)
        .map_err(|e| AppError::Menu(e.to_string()))?;
    
    let help_menu = Submenu::with_items(app, "Help", true, &[
        &about,
    ]).map_err(|e| AppError::Menu(e.to_string()))?;
    
    // Main menu bar
    let menu = Menu::with_items(app, &[
        &file_menu,
        &edit_menu,
        &view_menu,
        &window_menu,
        &help_menu,
    ]).map_err(|e| AppError::Menu(e.to_string()))?;
    
    Ok(menu)
}

fn setup_system_tray(app: &tauri::AppHandle) -> AppResult<()> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)
        .map_err(|e| AppError::Tray(e.to_string()))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| AppError::Tray(e.to_string()))?;
    let separator = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::Tray(e.to_string()))?;
    
    let menu = Menu::with_items(app, &[&show, &separator, &quit])
        .map_err(|e| AppError::Tray(e.to_string()))?;
    
    let tray_icon = app.default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::Tray("No default icon found".to_string()))?;
    
    TrayIconBuilder::with_id("main-tray")
        .tooltip("Koryphaios")
        .icon(tray_icon)
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
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
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event {
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Spawn backend sidecar in production mode
            let config = AppConfig::get();
            let app_handle = app.handle().clone();
            
            match spawn_backend_sidecar(&app_handle) {
                Ok(process) => {
                    // Store process handle
                    if let Ok(mut guard) = BACKEND_PROCESS.lock() {
                        *guard = Some(process);
                    }
                    
                    // Wait for backend to be ready (async block)
                    let host = config.server.host.clone();
                    let port = config.server.port;
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = wait_for_backend_ready(&host, port, 30000).await {
                            eprintln!("[Koryphaios] Warning: {}", e);
                        }
                    });
                }
                Err(e) => {
                    // Development mode - backend started separately
                    println!("[Koryphaios] {}", e);
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
                // Load and apply window state if available
                if let Some(state) = load_window_state(app.handle()) {
                    if !state.maximized {
                        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                            width: state.width,
                            height: state.height,
                        }));
                        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                            x: state.x,
                            y: state.y,
                        }));
                    } else {
                        let _ = window.maximize();
                    }
                }

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
            app_handle_clone.run_on_main_thread(|| {
                // Cleanup happens automatically via Drop, but we ensure it here
            }).ok();
            
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
            create_project_folder,
            read_folder_contents,
            indexer::search_codebase,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koryphaios desktop app");
}
