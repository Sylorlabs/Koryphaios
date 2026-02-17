// Backend Constants — Extract magic numbers and configuration defaults

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
  /** Requests per window */
  MAX_REQUESTS: 120,
  /** Time window in milliseconds (1 minute) */
  WINDOW_MS: 60_000,
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
  /** Allowed CORS origins (production should override) */
  ALLOWED_ORIGINS: [
    "http://localhost:5173", // Vite dev server
    "http://localhost:3000", // Bun dev server
    "http://localhost:3001", // Bun dev server (alternate)
    "http://127.0.0.1:5173", // Vite dev server (IPv4)
    "http://127.0.0.1:3000", // Bun dev server (IPv4)
    "http://127.0.0.1:3001", // Bun dev server (IPv4 alternate)
  ],
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
  DEFAULT_MANAGER_MODEL: "claude-opus-4-6",
  DEFAULT_CODER_MODEL: "claude-sonnet-4-5",
  DEFAULT_TASK_MODEL: "gpt-5.2-instant",
  DEFAULT_MAX_TOKENS: 8192,
  CODER_MAX_TOKENS: 16384,
  DEFAULT_REASONING_LEVEL: "auto" as const,
  DEFAULT_FALLBACKS: {
    "claude-opus-4-6": ["gpt-5.3-codex", "gpt-5.2-pro"],
    "claude-sonnet-4-5": ["gpt-5.2-pro", "gemini-3-pro"],
    "gpt-5.3-codex": ["claude-opus-4-6", "gpt-5.2-pro"],
    "gpt-5.2-pro": ["claude-sonnet-4-5", "gemini-3-pro"],
  },
};

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
 * Antigravity (Google Internal/Unified Gateway) Configuration
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
  }
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
 * Worker Domain Configuration
 */
export const DOMAIN = {
  KEYWORDS: {
    frontend: [
      "frontend", "component", "svelte", "react", "vue", "html", "css", "style",
      "design", "ux", "ui", "widget", "button", "layout", "animation", "render",
      "canvas", "theme", "color", "font", "icon", "responsive", "mobile",
      "tailwind", "bootstrap", "shadcn", "modal", "sidebar", "navbar",
    ],
    backend: [
      "server", "api", "database", "sql", "nosql", "redis", "cache", "auth",
      "middleware", "routing", "controller", "service", "orm", "prisma", "drizzle",
      "docker", "kubernetes", "infra", "deploy", "ci/cd", "performance",
      "optimization", "threading", "concurrency", "socket", "grpc", "protobuf",
      "c++", "cpp", "rust", "go", "python", "node", "java", "logic",
    ],
    general: [
      "refactor", "rename", "move", "organize", "clean", "lint", "format",
      "documentation", "readme", "comment", "explain", "review", "improve",
      "typescript", "javascript", "script", "bash", "shell", "git",
    ],
    review: ["review", "audit", "check", "verify", "validate", "quality", "security"],
    test: ["test", "spec", "unit", "integration", "e2e", "jest", "vitest", "mocha", "pytest", "cypress"],
    critic: ["critic", "critique", "audit", "review", "gate", "quality", "architect"],
  },
  DEFAULT_MODELS: {
    frontend: "gpt-5.2-pro",
    backend: "claude-sonnet-4-5",
    general: "gemini-3-flash",
    review: "gpt-5.2-pro",
    test: "gpt-5.2-pro",
    critic: "claude-opus-4-6",
  },
  GLOW_COLORS: {
    frontend: "rgba(0,255,255,0.5)",       // Cyan
    backend: "rgba(128,0,128,0.5)",  // Deep Purple
    general: "rgba(255,165,0,0.5)",  // Orange (Claude)
    review: "rgba(255,165,0,0.5)",   // Orange
    test: "rgba(0,255,128,0.5)",     // Green
    critic: "rgba(255,0,0,0.6)",      // Red (Harshest)
  },
} as const;
