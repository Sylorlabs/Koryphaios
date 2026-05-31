use std::fmt;

/// Application errors with user-friendly messages
#[derive(Debug)]
pub enum AppError {
    Window(String),
    Tray(String),
    #[cfg(target_os = "macos")]
    Menu(String),
    Io(String),
    Serialization(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Window(msg) => write!(f, "Window error: {}", msg),
            AppError::Tray(msg) => write!(f, "System tray error: {}", msg),
            #[cfg(target_os = "macos")]
            AppError::Menu(msg) => write!(f, "Menu error: {}", msg),
            AppError::Io(msg) => write!(f, "I/O error: {}", msg),
            AppError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Serialization(err.to_string())
    }
}

/// Log error with context
pub fn log_error(context: &str, error: &dyn std::error::Error) {
    eprintln!("[Koryphaios] Error in {}: {}", context, error);
    
    // In production, you might want to send this to a crash reporting service
    #[cfg(debug_assertions)]
    {
        if let Some(source) = error.source() {
            eprintln!("[Koryphaios] Caused by: {}", source);
        }
    }
}

/// Result type alias for app operations
pub type AppResult<T> = Result<T, AppError>;
