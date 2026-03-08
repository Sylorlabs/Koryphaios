import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "bun";

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
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GITHUB_COPILOT_TOKEN) return process.env.GITHUB_COPILOT_TOKEN;

  // 1. Try 'gh' CLI (Semantic Auth)
  try {
    const gh = spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
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
}

/**
 * Detects Claude Code (Anthropic) session tokens using 'claude' CLI or files.
 */
export function detectClaudeCodeToken(): string | null {
  // 1. Try 'claude status' (Semantic Auth)
  // Claude Code CLI stores credentials internally; 'status' tells us if we're logged in.
  // Note: We might need to parse JSON if they support --json
  try {
    const status = spawnSync(["claude", "status", "--json"], { stdout: "pipe", stderr: "pipe" });
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
 * Does NOT touch gcloud, Application Default Credentials, or any GCP-wide credentials —
 * those belong to Vertex AI which requires explicit configuration.
 */
export function detectGeminiCLIToken(): string | null {
  // Only look for Gemini-specific OAuth credentials (not gcloud ADC or GCP credentials)
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
  return process.env.GOOGLE_CLI_TOKEN || null;
}

/**
 * Detects Antigravity (Google internal portal) tokens.
 */
export function detectAntigravityToken(): string | null {
  const paths = [
    join(homedir(), ".gemini", "antigravity", "token.json"),
    join(homedir(), ".local", "share", "opencode", "antigravity-accounts.json"),
    join(getConfigDir(), "Antigravity", "User", "globalStorage", "storage.json"),
    join(homedir(), ".antigravity", "User", "globalStorage", "storage.json"),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      if (data?.token) return data.token;
      if (data?.access_token) return data.access_token;

      // opencode-antigravity-auth format (antigravity-accounts.json)
      if (Array.isArray(data?.accounts) && data.accounts.length > 0) {
        const activeAccount = data.accounts[data.activeIndex ?? 0];
        if (activeAccount?.refreshToken) return activeAccount.refreshToken;
      }

      if (data?.["antigravityUnifiedStateSync.oauthToken"]) {
        return data["antigravityUnifiedStateSync.oauthToken"];
      }
    } catch {
      continue;
    }
  }
  return process.env.ANTIGRAVITY_TOKEN || null;
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

