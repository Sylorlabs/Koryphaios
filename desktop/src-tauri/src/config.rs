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
        format!("http://{}:{}", self.server.host, self.server.port)
    }
    
    pub fn websocket_url(&self) -> String {
        format!("ws://{}:{}{}", self.server.host, self.server.port, self.server.ws_path)
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
                port: 3000,
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
