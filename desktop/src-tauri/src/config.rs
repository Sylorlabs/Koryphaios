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

        let config: AppConfig =
            serde_json::from_str(&contents).map_err(|e| ConfigError::ParseError(e.to_string()))?;

        Ok(config)
    }

    pub fn get() -> &'static AppConfig {
        CONFIG.get_or_init(|| {
            let mut config = Self::load().unwrap_or_else(|e| {
                eprintln!("[Koryphaios] Failed to load config: {}. Using defaults.", e);
                Self::default()
            });
            if let Ok(host) = std::env::var("KORYPHAIOS_HOST") {
                if !host.trim().is_empty() {
                    config.server.host = host;
                }
            }
            if let Ok(port) = std::env::var("KORYPHAIOS_PORT") {
                if let Ok(port) = port.parse::<u16>() {
                    if port > 0 {
                        config.server.port = port;
                    }
                }
            }
            config
        })
    }

    pub fn backend_url(&self) -> String {
        // Check for active-port.json (written by the backend when it uses a
        // dynamic port). This lets the frontend discover the actual port when
        // the backend fell back from the default due to EADDRINUSE.
        if let Some((host, port)) = read_active_port() {
            return format!("http://{}:{}", host, port);
        }
        format!(
            "http://{}:{}",
            browser_host(&self.server.host),
            self.server.port
        )
    }

    pub fn websocket_url(&self) -> String {
        if let Some((host, port)) = read_active_port() {
            return format!("ws://{}:{}/ws", host, port);
        }
        format!(
            "ws://{}:{}{}",
            browser_host(&self.server.host),
            self.server.port,
            self.server.ws_path
        )
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
                // Linux AppImage: resources land in usr/lib/<product>/
                let appimage_path = exe_dir.join("../lib/Koryphaios/config/app.config.json");
                if appimage_path.exists() {
                    return Ok(appimage_path);
                }
                let adjacent_path = exe_dir.join("config/app.config.json");
                if adjacent_path.exists() {
                    return Ok(adjacent_path);
                }
            }
        }

        // Development: check project root (from desktop/src-tauri/target/debug/ -> project root)
        let dev_path = PathBuf::from("../../../../config/app.config.json");
        if dev_path.exists() {
            return Ok(dev_path);
        }

        // Alternative: check from project root directly
        let dev_path2 = PathBuf::from("../../config/app.config.json");
        if dev_path2.exists() {
            return Ok(dev_path2);
        }

        Err(ConfigError::NotFound)
    }
}

/// Wildcard addresses are valid bind targets but invalid navigation targets.
pub(crate) fn browser_host(host: &str) -> &str {
    match host {
        "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" => "[::1]",
        _ => host,
    }
}

#[cfg(test)]
mod tests {
    use super::browser_host;

    #[test]
    fn wildcard_bind_hosts_become_browser_safe_loopback_hosts() {
        assert_eq!(browser_host("0.0.0.0"), "127.0.0.1");
        assert_eq!(browser_host("::"), "[::1]");
        assert_eq!(browser_host("[::]"), "[::1]");
        assert_eq!(browser_host("localhost"), "localhost");
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            app: AppInfo {
                name: "Koryphaios".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
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
            security: SecurityConfig { csp: None },
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
            ConfigError::ReadError(path, e) => {
                write!(f, "Failed to read config at {:?}: {}", path, e)
            }
            ConfigError::ParseError(e) => write!(f, "Failed to parse config: {}", e),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Read the backend's `.active-port.json` file to discover the actual port
/// it bound to (may differ from the config default when EADDRINUSE caused
/// a fallback). Returns `(host, port)` if the file exists and is fresh.
pub fn read_active_port_public() -> Option<(String, u16)> {
    read_active_port()
}

/// Read the backend's `.active-port.json` file to discover the actual port
/// it bound to (may differ from the config default when EADDRINUSE caused
/// a fallback). Returns `(host, port)` if the file exists and is fresh.
fn read_active_port() -> Option<(String, u16)> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Search candidate paths: project root (dev) and cwd-relative.
    let candidates = [
        PathBuf::from("../../../../.koryphaios/.active-port.json"),
        PathBuf::from("../../../.koryphaios/.active-port.json"),
        PathBuf::from("../../.koryphaios/.active-port.json"),
        PathBuf::from("../.koryphaios/.active-port.json"),
        PathBuf::from(".koryphaios/.active-port.json"),
    ];

    for path in &candidates {
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };

        // Ignore stale files older than 5 minutes
        if let Some(ts) = parsed.get("timestamp").and_then(|v| v.as_u64()) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now.saturating_sub(ts) > 5 * 60 * 1000 {
                continue;
            }
        }

        let port = parsed.get("port").and_then(|v| v.as_u64())? as u16;
        let host = parsed
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1")
            .to_string();
        return Some((host, port));
    }

    None
}
