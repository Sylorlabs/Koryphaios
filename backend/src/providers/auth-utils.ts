import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "bun";

// Cache for token detection results to avoid repeated slow operations
const tokenCache = new Map<string, { result: string | null; timestamp: number }>();
const TOKEN_CACHE_TTL_MS = 30_000; // 30 seconds

function getCachedToken(key: string, detector: () => string | null): string | null {
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.timestamp) < TOKEN_CACHE_TTL_MS) {
    return cached.result;
  }
  const result = detector();
  tokenCache.set(key, { result, timestamp: now });
  return result;
}

/**
 * Clear all token detection caches. Useful for testing.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Robust, cross-platform config directory resolution.
 * Mirrors OpenCode's internal/config/config.go logic.
 */
export function getConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return process.env.XDG_CONFIG_HOME;
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  }
  return join(homedir(), ".config");
}

/**
 * Detects GitHub Copilot tokens from official 'gh' CLI or standard locations.
 */
export function detectCopilotToken(): string | null {
  return getCachedToken("copilot", () => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GITHUB_COPILOT_TOKEN) return process.env.GITHUB_COPILOT_TOKEN;

  // 1. Try 'gh' CLI (Semantic Auth) - with short timeout to avoid blocking
  try {
    const gh = spawnSync(["gh", "auth", "token"], { 
      stdout: "pipe", 
      stderr: "pipe",
      timeout: 1000 // 1 second timeout to avoid blocking tests
    });
    if (gh.exitCode === 0) {
      const token = gh.stdout.toString().trim();
      if (token) return token;
    }
  } catch { /* Expected: gh CLI may not be installed */ }

  // 2. Fallback to file-based detection
  const configDir = getConfigDir();
  const filePaths = [
    join(configDir, "github-copilot", "hosts.json"),
    join(configDir, "github-copilot", "apps.json"),
  ];

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      for (const key of Object.keys(data)) {
        if (key.includes("github.com") && data[key].oauth_token) {
          return data[key].oauth_token;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
  });
}

/**
 * Detects Claude Code (Anthropic) session tokens using 'claude' CLI or files.
 */
export function detectClaudeCodeToken(): string | null {
  return getCachedToken("claude", () => {
    // 1. Try 'claude status' (Semantic Auth) - with short timeout to avoid blocking
    // Claude Code CLI stores credentials internally; 'status' tells us if we're logged in.
    // Note: We might need to parse JSON if they support --json
    try {
      const status = spawnSync(["claude", "status", "--json"], { 
        stdout: "pipe", 
        stderr: "pipe",
        timeout: 1000 // 1 second timeout to avoid blocking tests
      });
      if (status.exitCode === 0) {
        try {
          const data = JSON.parse(status.stdout.toString());
          if (data?.loggedIn && data?.oauthToken) return data.oauthToken;
        } catch { /* Expected: status output may not be valid JSON */ }
      }
    } catch { /* Expected: claude CLI may not be installed */ }

    // 2. Fallback to file-based
    const paths = [
      join(homedir(), ".claude", ".credentials.json"),
      join(homedir(), ".claude", "settings.json"),
    ];

    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (data?.oauth_token) return data.oauth_token;
        if (data?.authToken) return data.authToken;
        if (data?.env?.ANTHROPIC_AUTH_TOKEN) return data.env.ANTHROPIC_AUTH_TOKEN;
      } catch {
        continue;
      }
    }
    return process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || null;
  });
}

/**
 * Detects Codex / ChatGPT session tokens.
 */
export function detectCodexToken(): string | null {
  // OpenAI doesn't have a stable 'login status' command for Codex session tokens yet
  const paths = [
    join(homedir(), ".codex", "auth.json"),
    join(getConfigDir(), "openai", "auth.json"),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      if (data?.tokens?.access_token) return data.tokens.access_token;
      if (data?.accessToken) return data.accessToken;
    } catch {
      continue;
    }
  }
  return process.env.CODEX_AUTH_TOKEN || null;
}

/**
 * Detects Gemini CLI auth state (Google AI Studio / Gemini CLI only).
 * Also checks for gcloud Application Default Credentials (ADC) as a fallback.
 */
export function detectGeminiCLIToken(): string | null {
  return getCachedToken("gemini", () => {
    // 1. Check for Gemini-specific OAuth credentials first
    const geminiCredsPath = join(homedir(), ".gemini", "oauth_creds.json");
    if (existsSync(geminiCredsPath)) {
      try {
        const data = JSON.parse(readFileSync(geminiCredsPath, "utf-8"));
        if (data?.access_token) return data.access_token;
        if (data?.tokens?.access_token) return data.tokens.access_token;
        if (data?.accessToken) return data.accessToken;
        return "cli:detected";
      } catch { /* Expected: creds file may be malformed or inaccessible */ }
    }

    // 2. Check for gcloud Application Default Credentials (ADC)
    // Try to get an access token from gcloud CLI
    try {
      const gcloud = spawnSync(["gcloud", "auth", "application-default", "print-access-token"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000 // 2 second timeout to avoid blocking tests
      });
      if (gcloud.exitCode === 0) {
        const token = gcloud.stdout.toString().trim();
        if (token) return `gcloud-adc:${token}`;
      }
    } catch { /* Expected: gcloud CLI may not be installed */ }

    // 3. Check for ADC credentials file directly
    const adcPaths = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      join(homedir(), ".config", "gcloud", "application_default_credentials.json"),
      join(homedir(), ".config", "gcloud", "credentials.json"),
    ].filter(Boolean) as string[];

    for (const adcPath of adcPaths) {
      if (!adcPath || !existsSync(adcPath)) continue;
      try {
        const data = JSON.parse(readFileSync(adcPath, "utf-8"));
        // ADC file has client_id, client_secret, refresh_token, type="authorized_user"
        if (data?.type === "authorized_user" || data?.refresh_token || data?.client_id) {
          return "gcloud-adc:detected";
        }
      } catch { /* Expected: creds file may be malformed or inaccessible */ }
    }

    return process.env.GOOGLE_CLI_TOKEN || null;
  });
}

/**
 * Detects DashScope (Alibaba Cloud Qwen) API keys from aliyun CLI or environment.
 * Alibaba Cloud doesn't provide OAuth for DashScope - uses API key or AccessKey credentials.
 */
export function detectDashScopeToken(): string | null {
  // 1. Check environment variable first
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  if (process.env.QWEN_API_KEY) return process.env.QWEN_API_KEY;

  // 2. Try aliyun CLI to get AccessKey (DashScope uses same credentials)
  try {
    const aliyun = spawnSync(["aliyun", "configure", "get", "--profile", "default"], { 
      stdout: "pipe", 
      stderr: "pipe",
      timeout: 5000
    });
    if (aliyun.exitCode === 0) {
      const output = aliyun.stdout.toString();
      // Parse aliyun configure output for accessKeyId
      const match = output.match(/accessKeyId\s*[=:]\s*["']?([A-Za-z0-9]+)["']?/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch { /* Expected: aliyun CLI may not be installed */ }

  // 3. Fallback to file-based detection
  const configPaths = [
    join(homedir(), ".aliyun", "config.json"),
    join(getConfigDir(), "aliyun", "config.json"),
  ];

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8"));
      // aliyun CLI stores profiles with access_key_id
      if (data?.profiles && Array.isArray(data.profiles)) {
        for (const profile of data.profiles) {
          if (profile?.access_key_id) {
            return profile.access_key_id;
          }
          // Some versions use nested access_key object
          if (profile?.access_key?.access_key_id) {
            return profile.access_key.access_key_id;
          }
        }
      }
      // Fallback: check first profile directly
      if (data?.access_key_id) {
        return data.access_key_id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Detects Cline CLI auth tokens from WorkOS-based authentication.
 * Cline CLI stores tokens with 'workos:' prefix in their config directory.
 */
export function detectClineToken(): string | null {
  // 1. Check environment variable first
  if (process.env.CLINE_AUTH_TOKEN) return process.env.CLINE_AUTH_TOKEN;

  // 2. Try 'cline auth status' or similar CLI command if available
  try {
    const clineStatus = spawnSync(["cline", "auth", "status"], { 
      stdout: "pipe", 
      stderr: "pipe",
      timeout: 5000
    });
    if (clineStatus.exitCode === 0) {
      const output = clineStatus.stdout.toString();
      // Try to extract token from status output (if it shows the token)
      const tokenMatch = output.match(/workos:[A-Za-z0-9._-]+/);
      if (tokenMatch) {
        return tokenMatch[0];
      }
    }
  } catch { /* Expected: cline CLI may not be installed or command may not exist */ }

  // 3. Fallback to file-based detection
  // Cline stores auth tokens in various locations depending on platform
  const configPaths = [
    join(homedir(), ".cline", "auth.json"),
    join(homedir(), ".cline", "config.json"),
    join(getConfigDir(), "Cline", "auth.json"),
    join(getConfigDir(), "cline", "auth.json"),
    // VS Code extension storage location (for users who auth via extension)
    join(homedir(), ".vscode", "extensions", "cline.cline-*", "auth.json"),
  ];

  for (const configPath of configPaths) {
    // Handle glob patterns in path
    if (configPath.includes("*")) {
      // Skip glob patterns for now - would need fs.readdir to resolve
      continue;
    }
    if (!existsSync(configPath)) continue;
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8"));
      // Check common token field names
      if (data?.token) return data.token;
      if (data?.authToken) return data.authToken;
      if (data?.access_token) return data.access_token;
      if (data?.workos_token) return data.workos_token;
      // Some configs nest under 'auth' or 'credentials'
      if (data?.auth?.token) return data.auth.token;
      if (data?.credentials?.token) return data.credentials.token;
    } catch {
      continue;
    }
  }

  return null;
}

