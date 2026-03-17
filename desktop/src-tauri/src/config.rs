use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

static CONFIG: OnceLock<AppConfig> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub app: AppInfo,
    pub server: ServerConfig,
    pub window: WindowConfig,
    pub security: SecurityConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_ws_path")]
    pub ws_path: String,
}

fn default_ws_path() -> String {
    "/ws".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    pub width: u32,
    pub height: u32,
    #[serde(rename = "minWidth")]
    pub min_width: u32,
    #[serde(rename = "minHeight")]
    pub min_height: u32,
    #[serde(rename = "maxWidth")]
    pub max_width: u32,
    #[serde(rename = "maxHeight")]
    pub max_height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    pub csp: Option<CspConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CspConfig {
    #[serde(rename = "defaultSrc")]
    pub default_src: Vec<String>,
    #[serde(rename = "connectSrc")]
    pub connect_src: Vec<String>,
    #[serde(rename = "imgSrc")]
    pub img_src: Vec<String>,
    #[serde(rename = "styleSrc")]
    pub style_src: Vec<String>,
    #[serde(rename = "scriptSrc")]
    pub script_src: Vec<String>,
    #[serde(rename = "fontSrc")]
    pub font_src: Vec<String>,
}

/// Port information written by the backend when using dynamic port allocation
#[derive(Debug, Clone, Deserialize)]
struct PortInfo {
    url: String,
    #[serde(rename = "wsUrl")]
    ws_url: String,
    timestamp: u64,
    pid: u32,
}

impl AppConfig {
    pub fn load() -> Result<Self, ConfigError> {
        let config_path = Self::config_path()?;
        let contents = fs::read_to_string(&config_path)
            .map_err(|e| ConfigError::ReadError(config_path.clone(), e.to_string()))?;
        
        let config: AppConfig = serde_json::from_str(&contents)
            .map_err(|e| ConfigError::ParseError(e.to_string()))?;
        
        Ok(config)
    }
    
    pub fn get() -> &'static AppConfig {
        CONFIG.get_or_init(|| {
            Self::load().unwrap_or_else(|e| {
                eprintln!("[Koryphaios] Failed to load config: {}. Using defaults.", e);
                Self::default()
            })
        })
    }
    
    pub fn backend_url(&self) -> String {
        // Priority order for backend URL discovery:
        // 1. KORYPHAIOS_BACKEND_URL environment variable (highest priority)
        // 2. KORYPHAIOS_PORT environment variable
        // 3. Active port file (written by backend when using dynamic port)
        // 4. Config file default
        
        // 1. Check explicit backend URL env var
        if let Ok(url) = std::env::var("KORYPHAIOS_BACKEND_URL") {
            eprintln!("[Koryphaios] Using KORYPHAIOS_BACKEND_URL: {}", url);
            return url;
        }
        
        // 2. Check KORYPHAIOS_PORT env var
        if let Ok(port_str) = std::env::var("KORYPHAIOS_PORT") {
            if let Ok(port) = port_str.parse::<u16>() {
                let url = format!("http://{}:{}", self.server.host, port);
                eprintln!("[Koryphaios] Using KORYPHAIOS_PORT: {}", url);
                return url;
            }
        }
        
        // 3. Check active port file (backend writes this when using dynamic port)
        if let Some(port_info) = Self::read_active_port_file() {
            eprintln!("[Koryphaios] Using active port file: {}", port_info.url);
            return port_info.url;
        }
        
        // 4. Fall back to config file default
        let url = format!("http://{}:{}", self.server.host, self.server.port);
        eprintln!("[Koryphaios] Using config default: {}", url);
        url
    }
    
    pub fn websocket_url(&self) -> String {
        // Priority order for WebSocket URL discovery:
        // 1. KORYPHAIOS_WS_URL environment variable
        // 2. KORYPHAIOS_PORT environment variable
        // 3. Active port file
        // 4. Config file default
        
        if let Ok(url) = std::env::var("KORYPHAIOS_WS_URL") {
            return url;
        }
        
        if let Ok(port_str) = std::env::var("KORYPHAIOS_PORT") {
            if let Ok(port) = port_str.parse::<u16>() {
                return format!("ws://{}:{}{}", self.server.host, port, self.server.ws_path);
            }
        }
        
        if let Some(port_info) = Self::read_active_port_file() {
            return port_info.ws_url;
        }
        
        format!("ws://{}:{}{}", self.server.host, self.server.port, self.server.ws_path)
    }
    
    /// Read the active port file written by the backend
    /// Returns None if file doesn't exist, is stale (>5 min old), or PID is not running
    fn read_active_port_file() -> Option<PortInfo> {
        // Determine the project root based on executable location
        let port_file = if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                // Production: exe is in target/release/ or similar
                // Check for .koryphaios next to the project
                exe_dir.join("../../../.koryphaios/.active-port.json")
            } else {
                PathBuf::from(".koryphaios/.active-port.json")
            }
        } else {
            PathBuf::from(".koryphaios/.active-port.json")
        };
        
        if !port_file.exists() {
            return None;
        }
        
        let contents = fs::read_to_string(&port_file).ok()?;
        let port_info: PortInfo = serde_json::from_str(&contents).ok()?;
        
        // Check if the port info is stale (>5 minutes old)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as u64;
        
        if now.saturating_sub(port_info.timestamp) > 5 * 60 * 1000 {
            eprintln!("[Koryphaios] Port file is stale (>5 min old)");
            return None;
        }
        
        // On Unix, check if the PID is still running
        #[cfg(unix)]
        {
            use std::process::Command;
            let output = Command::new("kill")
                .args(&["-0", &port_info.pid.to_string()])
                .output()
                .ok()?;
            
            if !output.status.success() {
                eprintln!("[Koryphaios] Backend PID {} not running", port_info.pid);
                return None;
            }
        }
        
        Some(port_info)
    }
    
    fn config_path() -> Result<PathBuf, ConfigError> {
        // Try to find config relative to executable
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                // Check for config in resources directory (Tauri production)
                let resource_path = exe_dir.join("../Resources/config/app.config.json");
                if resource_path.exists() {
                    return Ok(resource_path);
                }
                
                // Check for config next to executable
                let adjacent_path = exe_dir.join("config/app.config.json");
                if adjacent_path.exists() {
                    return Ok(adjacent_path);
                }
            }
        }
        
        // Development: check project root
        let dev_path = PathBuf::from("../../config/app.config.json");
        if dev_path.exists() {
            return Ok(dev_path);
        }
        
        Err(ConfigError::NotFound)
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            app: AppInfo {
                name: "Koryphaios".to_string(),
                version: "0.1.0".to_string(),
                identifier: "com.sylorlabs.koryphaios".to_string(),
            },
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 29473,
                ws_path: "/ws".to_string(),
            },
            window: WindowConfig {
                width: 1280,
                height: 800,
                min_width: 1024,
                min_height: 640,
                max_width: 3840,
                max_height: 2160,
            },
            security: SecurityConfig {
                csp: None,
            },
        }
    }
}

#[derive(Debug)]
pub enum ConfigError {
    NotFound,
    ReadError(PathBuf, String),
    ParseError(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::NotFound => write!(f, "Config file not found"),
            ConfigError::ReadError(path, e) => write!(f, "Failed to read config at {:?}: {}", path, e),
            ConfigError::ParseError(e) => write!(f, "Failed to parse config: {}", e),
        }
    }
}

impl std::error::Error for ConfigError {}
