// Backend Constants — Extract magic numbers and configuration defaults

/** Application version (single source of truth) */
export const VERSION = "1.0.0";

/**
 * Session and Message Limits
 */
export const SESSION = {
  /** Maximum length for session titles */
  MAX_TITLE_LENGTH: 200,
  /** Default title for new sessions */
  DEFAULT_TITLE: "New Session",
  /** Characters to extract from first message for auto-title */
  AUTO_TITLE_CHARS: 50,
} as const;

export const MESSAGE = {
  /** Maximum content length per message (100KB) */
  MAX_CONTENT_LENGTH: 100_000,
  /** Maximum attachment size (future use) */
  MAX_ATTACHMENT_SIZE: 10_000_000, // 10MB
} as const;

/**
 * ID Generation
 */
export const ID = {
  /** Length for session/message IDs */
  SESSION_ID_LENGTH: 12,
  /** Length for WebSocket client IDs */
  WS_CLIENT_ID_LENGTH: 8,
  /** Length for tool call IDs */
  TOOL_CALL_ID_LENGTH: 12,
  /** Length for agent IDs */
  AGENT_ID_LENGTH: 16,
} as const;

/**
 * Rate Limiting
 */
export const RATE_LIMIT = {
  /** Requests per window (general API) */
  MAX_REQUESTS: 120,
  /** Time window in milliseconds (1 minute) */
  WINDOW_MS: 60_000,
  /** Auth endpoints (login, register, refresh) per IP per minute */
  AUTH_PER_MINUTE: 15,
  /** Credential-setting (PUT /api/providers) per IP per minute */
  CREDENTIAL_PER_MINUTE: 20,
} as const;

/**
 * Server Configuration Defaults
 */
export const SERVER = {
  /** Default HTTP port */
  DEFAULT_PORT: 3000,
  /** Default host */
  DEFAULT_HOST: "0.0.0.0",
  /** WebSocket path */
  WS_PATH: "/ws",
  /** SSE path */
  SSE_PATH: "/api/events",
} as const;

/**
 * Security
 */
export const SECURITY = {
  /** Maximum API key length */
  MAX_API_KEY_LENGTH: 500,
  /** Maximum provider name length */
  MAX_PROVIDER_NAME_LENGTH: 50,
  /** Allowed CORS origins (add more via config.corsOrigins for other dev hosts/ports) */
  ALLOWED_ORIGINS: [
    "http://localhost:5173",   // Vite dev default
    "http://localhost:3000",   // Bun dev server
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
  ],
} as const;

/**
 * Auth patterns (single source of truth for token format checks).
 */
export const AUTH = {
  /** Claude subscription OAuth token from "claude setup-token" (sk-ant-oat01-...). */
  CLAUDE_OAUTH_TOKEN_REGEX: /^sk-ant-oat\d{2}-/,
} as const;

/**
 * File System
 */
export const FS = {
  /** Default data directory name */
  DEFAULT_DATA_DIR: ".koryphaios",
  /** Sessions subdirectory */
  SESSIONS_DIR: "sessions",
  /** Messages file suffix */
  MESSAGES_FILE_SUFFIX: ".messages.json",
  /** Session file suffix */
  SESSION_FILE_SUFFIX: ".json",
} as const;

/**
 * Agent Configuration
 */
export const AGENT = {
  /** Default models per role if not configured */
  DEFAULT_MANAGER_MODEL: "claude-sonnet-4-6",
  DEFAULT_CODER_MODEL: "claude-sonnet-4-6",
  DEFAULT_TASK_MODEL: "gpt-5-mini",

  /** Default token limits */
  DEFAULT_MAX_TOKENS: 8192,
  CODER_MAX_TOKENS: 16384,

  /** Default reasoning level */
  DEFAULT_REASONING_LEVEL: "high" as const,

  /** Fallback model chains (IDs must exist in MODEL_CATALOG). No retired models (Claude 3.7, Haiku 3.5). */
  DEFAULT_FALLBACKS: {
    "claude-sonnet-4-5": ["claude-sonnet-4-6", "gpt-5-mini", "gemini-3.1-pro"],
    "claude-sonnet-4-6": ["claude-sonnet-4-5", "gpt-5-mini", "gemini-3.1-pro"],
    "gpt-5-mini": ["gemini-3.1-pro", "claude-haiku-4-5"],
    "o4-mini": ["gpt-5-mini", "gemini-3.1-pro"],
  } as Record<string, string[]>,

  /** Max time a single LLM stream can run before being aborted (prevents stuck requests) */
  LLM_STREAM_TIMEOUT_MS: 600_000, // 10 minutes
} as const;

/**
 * Configuration File Paths (in order of precedence)
 */
export const CONFIG_PATHS = [
  "koryphaios.json",                          // Project root
  ".config/koryphaios/config.json",           // User config (in home)
  ".koryphaios.json",                         // User config (home root)
] as const;

/**
 * Context Files (loaded into agent context)
 */
export const DEFAULT_CONTEXT_PATHS: string[] = [
  ".cursorrules",
  "CLAUDE.md",
  "AGENTS.md",
  ".opencode.json",
  "CONVENTIONS.md",
];

/**
 * Logging
 */
export const LOG = {
  /** Log level for production */
  PROD_LEVEL: "info" as const,
  /** Log level for development */
  DEV_LEVEL: "debug" as const,
  /** Enable pretty printing in dev */
  PRETTY_PRINT_DEV: true,
} as const;

/**
 * Provider Configuration
 */
export const PROVIDER = {
  /** Environment variable prefix */
  ENV_VAR_PREFIX: "ANTHROPIC_API_KEY", // Example pattern

  /** Expected environment variable names */
  ENV_VARS: {
    ANTHROPIC: "ANTHROPIC_API_KEY",
    OPENAI: "OPENAI_API_KEY",
    GEMINI: "GEMINI_API_KEY",
    GROQ: "GROQ_API_KEY",
    XAI: "XAI_API_KEY",
    AZURE: "AZURE_OPENAI_API_KEY",
    BEDROCK: "AWS_ACCESS_KEY_ID", // Also needs AWS_SECRET_ACCESS_KEY
    COPILOT: "GITHUB_TOKEN",
    OPENROUTER: "OPENROUTER_API_KEY",
    VERTEXAI: "GOOGLE_APPLICATION_CREDENTIALS",
  } as const,
} as const;

/**
 * Telegram Configuration
 */
export const TELEGRAM = {
  /** Webhook path */
  WEBHOOK_PATH: "/api/telegram/webhook",
  /** Polling interval (ms) */
  POLLING_INTERVAL: 1000,
  /** Max message length */
  MAX_MESSAGE_LENGTH: 4096,
} as const;

/**
 * Health Check
 */
export const HEALTH = {
  /** Include detailed metrics */
  INCLUDE_METRICS: true,
  /** Response timeout (ms) */
  TIMEOUT_MS: 5000,
} as const;

/**
 * WebSocket
 */
export const WS = {
  /** Heartbeat interval (future use) */
  HEARTBEAT_INTERVAL_MS: 30_000,
  /** Max message size */
  MAX_MESSAGE_SIZE: 1_000_000, // 1MB
  /** Reconnect delay (client-side, for reference) */
  RECONNECT_DELAY_MS: 2000,
} as const;

/**
 * Timeouts
 */
export const TIMEOUT = {
  /** Tool execution timeout */
  TOOL_EXECUTION_MS: 300_000, // 5 minutes
  /** Agent response timeout */
  AGENT_RESPONSE_MS: 600_000, // 10 minutes
  /** Provider API timeout */
  PROVIDER_API_MS: 120_000, // 2 minutes
} as const;

/**
 * Antigravity (Google OAuth) configuration.
 * Client credentials must be provided via environment variables.
 */
export const ANTIGRAVITY = {
  CLIENT_ID: process.env.ANTIGRAVITY_CLIENT_ID ?? "",
  CLIENT_SECRET: process.env.ANTIGRAVITY_CLIENT_SECRET ?? "",
  REDIRECT_URI: process.env.ANTIGRAVITY_REDIRECT_URI ?? "http://localhost:51121/oauth-callback",
  SCOPES: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  ENDPOINTS: {
    DAILY: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    PROD: "https://cloudcode-pa.googleapis.com",
    AUTH: "https://accounts.google.com/o/oauth2/v2/auth",
    TOKEN: "https://oauth2.googleapis.com/token",
  },
} as const;

/**
 * Worker Domain Configuration
 */
export const DOMAIN = {
  KEYWORDS: {
    ui: [
      "skia", "flutter", "ui", "widget", "button", "layout", "css", "style",
      "animation", "render", "frontend", "component", "svelte", "react", "view",
      "canvas", "draw", "paint", "theme", "color", "font", "icon", "design",
      "responsive", "mobile", "dark mode", "light mode", "sidebar", "modal",
    ],
    backend: [
      "c++", "cpp", "cmake", "makefile", "gtest", "boost", "llvm", "clang",
      "server", "api", "database", "sql", "grpc", "protobuf", "socket",
      "memory", "pointer", "thread", "mutex", "algorithm", "data structure",
      "compiler", "linker", "binary", "build", "performance", "optimization",
      "kernel", "driver", "system", "dsp", "audio", "midi", "signal",
    ],
    general: [
      "refactor", "rename", "move", "organize", "clean", "lint", "format",
      "documentation", "readme", "comment", "explain", "review", "improve",
      "typescript", "javascript", "python", "rust", "go",
    ],
    review: ["review", "audit", "check", "verify", "validate"],
    test: ["test", "spec", "gtest", "jest", "vitest", "mocha", "pytest"],
    critic: ["critic", "critique", "audit", "review", "gate", "quality"],
  },
  DEFAULT_MODELS: {
    ui: "gpt-5.2",
    backend: "gemini-3.1-pro",
    general: "gemini-3-flash",
    review: "gpt-5.2",
    test: "gpt-5.2",
    critic: "claude-sonnet-4-6",
  },
  GLOW_COLORS: {
    ui: "rgba(0,255,255,0.5)",       // Cyan
    backend: "rgba(128,0,128,0.5)",  // Deep Purple
    general: "rgba(255,165,0,0.5)",  // Orange (Claude)
    review: "rgba(255,165,0,0.5)",   // Orange
    test: "rgba(0,255,128,0.5)",     // Green
    critic: "rgba(255,0,0,0.6)",      // Red (Harshest)
  },
} as const;
