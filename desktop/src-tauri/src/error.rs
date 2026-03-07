use std::fmt;

/// Application errors with user-friendly messages
#[derive(Debug)]
pub enum AppError {
    Config(String),
    Window(String),
    Tray(String),
    Menu(String),
    Io(String),
    Serialization(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Config(msg) => write!(f, "Configuration error: {}", msg),
            AppError::Window(msg) => write!(f, "Window error: {}", msg),
            AppError::Tray(msg) => write!(f, "System tray error: {}", msg),
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

/// User-friendly error messages for UI display
pub fn user_friendly_message(error: &AppError) -> String {
    match error {
        AppError::Config(_) => {
            "There was a problem with the app configuration. Please restart the application.".to_string()
        }
        AppError::Window(_) => {
            "There was a problem with the application window. Please try restarting.".to_string()
        }
        AppError::Tray(_) => {
            "System tray functionality is not available. The app will continue running.".to_string()
        }
        AppError::Menu(_) => {
            "Menu functionality may be limited. The app will continue running.".to_string()
        }
        AppError::Io(_) => {
            "There was a problem reading or writing files. Please check your permissions.".to_string()
        }
        AppError::Serialization(_) => {
            "There was a problem saving your settings. Please try again.".to_string()
        }
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
