/**
 * Shared application configuration
 * 
 * This module provides a single source of truth for app configuration
 * that is shared between the backend, frontend, and desktop app.
 * 
 * The configuration is loaded from config/app.config.json at runtime
 * for the desktop app, and from environment variables for the backend.
 */

export interface AppConfig {
  app: {
    name: string;
    version: string;
    identifier: string;
  };
  server: {
    host: string;
    port: number;
    wsPath: string;
  };
  window: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
  };
  security: {
    csp?: {
      defaultSrc: string[];
      connectSrc: string[];
      imgSrc: string[];
      styleSrc: string[];
      scriptSrc: string[];
      fontSrc: string[];
    };
  };
}

// Default configuration - must match config/app.config.json defaults
const defaultConfig: AppConfig = {
  app: {
    name: "Koryphaios",
    version: "0.1.0",
    identifier: "com.sylorlabs.koryphaios",
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    wsPath: "/ws",
  },
  window: {
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    maxWidth: 3840,
    maxHeight: 2160,
  },
  security: {
    csp: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "http://127.0.0.1:*", "ws://127.0.0.1:*"],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
    },
  },
};

let cachedConfig: AppConfig | null = null;

/**
 * Load configuration from a JSON string
 */
export function parseConfig(json: string): AppConfig {
  const parsed = JSON.parse(json);
  return mergeWithDefaults(parsed);
}

/**
 * Merge loaded config with defaults
 */
function mergeWithDefaults(loaded: Partial<AppConfig>): AppConfig {
  return {
    app: { ...defaultConfig.app, ...loaded.app },
    server: { ...defaultConfig.server, ...loaded.server },
    window: { ...defaultConfig.window, ...loaded.window },
    security: {
      csp: loaded.security?.csp ?? defaultConfig.security.csp,
    },
  };
}

/**
 * Get the backend URL from config
 */
export function getBackendUrl(config: AppConfig = defaultConfig): string {
  return `http://${config.server.host}:${config.server.port}`;
}

/**
 * Get the WebSocket URL from config
 */
export function getWebSocketUrl(config: AppConfig = defaultConfig): string {
  return `ws://${config.server.host}:${config.server.port}${config.server.wsPath}`;
}

/**
 * Get default configuration
 */
export function getDefaultConfig(): AppConfig {
  return { ...defaultConfig };
}

// Re-export for convenience
export { defaultConfig };
