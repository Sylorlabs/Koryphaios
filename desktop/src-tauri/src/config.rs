use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

static CONFIG: OnceLock<AppConfig> = OnceLock::new();
static BACKEND_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn set_backend_data_dir(path: PathBuf) {
    let _ = BACKEND_DATA_DIR.set(path);
}

pub(crate) fn uses_background_service() -> bool {
    BACKEND_DATA_DIR.get().is_some()
}

pub(crate) fn read_service_endpoint() -> Option<(String, u16, u32)> {
    let path = BACKEND_DATA_DIR
        .get()?
        .join(".koryphaios/.active-port.json");
    parse_service_endpoint(&fs::read_to_string(path).ok()?)
}

/// The backend's pre-listen progress marker, written by
/// `backend/src/runtime/startup-status.ts` next to `.active-port.json`. It
/// lets the readiness wait tell "alive and still booting" (migrations, a
/// one-time VACUUM) apart from "dead" before /api/health can answer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupStatus {
    pub pid: u32,
    pub phase: String,
    pub detail: Option<String>,
    pub started_at: u64,
    #[allow(dead_code)]
    pub phase_started_at: u64,
    pub updated_at: u64,
    pub ready: bool,
}

/// Read the backend startup marker. Only meaningful when an OS-managed
/// background service owns the backend data dir; dev mode returns None.
pub(crate) fn read_startup_status() -> Option<StartupStatus> {
    let path = BACKEND_DATA_DIR
        .get()?
        .join(".koryphaios/.startup-status.json");
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn parse_service_endpoint(raw: &str) -> Option<(String, u16, u32)> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let port = u16::try_from(parsed.get("port")?.as_u64()?)
        .ok()
        .filter(|port| *port > 0)?;
    let pid = u32::try_from(parsed.get("pid")?.as_u64()?)
        .ok()
        .filter(|pid| *pid > 0)?;
    let host = parsed
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1");
    // An on-disk marker is not an arbitrary remote connection instruction.
    let host = match host {
        "0.0.0.0" | "127.0.0.1" | "localhost" => "127.0.0.1",
        "::" | "[::]" | "::1" | "[::1]" => "[::1]",
        _ => return None,
    };
    Some((host.to_string(), port, pid))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    // `app` is required: the packaged config is the bundle's identity, and a
    // silently invented one is worse than a parse failure.
    pub app: AppInfo,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub window: WindowConfig,
    #[serde(default)]
    pub security: SecurityConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub ws_path: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 3000,
            ws_path: "/ws".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
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

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 800,
            min_width: 1024,
            min_height: 640,
            max_width: 3840,
            max_height: 2160,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SecurityConfig {
    pub csp: Option<CspConfig>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self { csp: None }
    }
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
            // Dev launchers forward KORYPHAIOS_HOST/PORT so the shell agrees
            // with its launcher-owned backend. A release build always uses the
            // packaged config: an inherited eval-script value must never
            // redirect the installed service or the UI's health checks.
            if cfg!(debug_assertions) {
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
    use super::{browser_host, parse_service_endpoint, AppConfig};

    /// The shipped `config/app.config.json` carries only the `app` section;
    /// every other section must fall back to `AppConfig::default()` values.
    #[test]
    fn packaged_config_parses_with_defaulted_sections() {
        let config: AppConfig = serde_json::from_str(include_str!(
            "../../../config/app.config.json"
        ))
        .expect("the packaged app.config.json must parse");
        let defaults = AppConfig::default();
        assert_eq!(config.app.name, "Koryphaios");
        assert_eq!(config.app.identifier, "com.sylorlabs.koryphaios");
        assert_eq!(config.server.host, defaults.server.host);
        assert_eq!(config.server.port, defaults.server.port);
        assert_eq!(config.server.ws_path, defaults.server.ws_path);
        assert_eq!(config.window.width, defaults.window.width);
        assert_eq!(config.window.height, defaults.window.height);
        assert_eq!(config.window.min_width, defaults.window.min_width);
        assert_eq!(config.window.min_height, defaults.window.min_height);
        assert_eq!(config.window.max_width, defaults.window.max_width);
        assert_eq!(config.window.max_height, defaults.window.max_height);
        assert!(config.security.csp.is_none());
    }

    /// Missing fields inside a present section fall back to the same defaults.
    #[test]
    fn missing_fields_inside_sections_use_defaults() {
        let config: AppConfig = serde_json::from_str(
            r#"{"app":{"name":"K","version":"0","identifier":"i"},"server":{"port":4000}}"#,
        )
        .unwrap();
        let defaults = AppConfig::default();
        assert_eq!(config.server.host, defaults.server.host);
        assert_eq!(config.server.port, 4000);
        assert_eq!(config.server.ws_path, defaults.server.ws_path);
    }

    /// The `app` section stays required: an empty object or a config that
    /// omits it is a parse error, not a silently-defaulted identity.
    #[test]
    fn config_without_app_section_still_fails() {
        assert!(serde_json::from_str::<AppConfig>("{}").is_err());
        assert!(
            serde_json::from_str::<AppConfig>(r#"{"server":{"host":"127.0.0.1","port":3000}}"#)
                .is_err()
        );
    }

    #[test]
    fn service_marker_remains_valid_across_days_and_validates_pid_and_port() {
        assert_eq!(
            parse_service_endpoint(r#"{"host":"0.0.0.0","port":3001,"pid":123,"timestamp":1}"#),
            Some(("127.0.0.1".into(), 3001, 123))
        );
        assert!(
            parse_service_endpoint(r#"{"host":"remote.example","port":3001,"pid":123}"#).is_none()
        );
        assert!(parse_service_endpoint(r#"{"port":65537,"pid":123}"#).is_none());
        assert!(parse_service_endpoint(r#"{"port":3001,"pid":0}"#).is_none());
        assert!(parse_service_endpoint(r#"{"port":3001}"#).is_none());
    }

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
            server: ServerConfig::default(),
            window: WindowConfig::default(),
            security: SecurityConfig::default(),
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
    // Services can run for days without touching their startup marker. Do not
    // apply the development marker's five-minute age limit to an OS service.
    if BACKEND_DATA_DIR.get().is_some() {
        return read_service_endpoint().map(|(host, port, _)| (host, port));
    }
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
