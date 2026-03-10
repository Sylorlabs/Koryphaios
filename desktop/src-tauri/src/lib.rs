use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent, Emitter, WebviewWindow, Listener,
};
use std::sync::Mutex;
use tauri_plugin_updater::UpdaterExt;

mod config;
mod error;
use config::AppConfig;
use error::{AppError, AppResult, log_error};

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

// Global window state
static WINDOW_STATE: Mutex<Option<WindowState>> = Mutex::new(None);

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

// Update check result
#[derive(serde::Serialize, Clone)]
struct UpdateCheckResult {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
}

// Check for updates command
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    
    match updater.check().await {
        Ok(Some(update)) => {
            Ok(UpdateCheckResult {
                available: true,
                version: Some(update.version.clone()),
                notes: Some(update.body.clone().unwrap_or_default()),
                pub_date: update.date.map(|d| d.to_string()),
            })
        }
        Ok(None) => {
            Ok(UpdateCheckResult {
                available: false,
                version: None,
                notes: None,
                pub_date: None,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

// Install update command
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    
    match updater.check().await {
        Ok(Some(update)) => {
            update.download_and_install(|_, _| {}, || {}).await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Ok(None) => Err("No update available".to_string()),
        Err(e) => Err(e.to_string()),
    }
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

fn create_native_menu(app: &tauri::AppHandle) -> AppResult<Menu<tauri::Wry>> {
    let config = AppConfig::get();
    
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
    let config = AppConfig::get();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::init())
        .setup(|app| {
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
                            #[cfg(debug_assertions)]
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
            
            // Get main window and restore state
            if let Some(window) = app.get_webview_window("main") {
                // Set up file drop handler
                setup_file_drop_handler(&window);
                
                // Load and apply window state
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
            
            Ok(())
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
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koryphaios desktop app");
}
