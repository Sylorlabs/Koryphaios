// Copilot provider — uses GitHub Copilot's chat completions API.
// Auth flow mirrors OpenCode: detect GitHub OAuth token → exchange for Copilot bearer → send with IDE headers.
// Token sources: ~/.config/github-copilot/hosts.json, apps.json, GITHUB_TOKEN env, device auth flow.

import type { ProviderConfig, ModelDef } from "@koryphaios/shared";
import { OpenAIProvider } from "./openai";
import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const COPILOT_CHAT_URL = "https://api.githubcopilot.com";

// These headers are REQUIRED by GitHub's Copilot API — without them you get HTTP 400.
// Values must match a known IDE integration; "vscode-chat" is the standard one used by OpenCode, Cursor, etc.
const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.100.0",
  "Editor-Plugin-Version": "copilot-chat/0.27.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "Koryphaios/1.0",
} as const;

// Complete Copilot model catalog — per https://docs.github.com/en/copilot/reference/ai-models/supported-models
// All models are $0 cost (included in GitHub Copilot subscription).
// API model IDs are unprefixed (e.g., "gpt-4.1" not "copilot.gpt-4.1").
// Last updated: February 2026
const COPILOT_MODELS: ModelDef[] = [
  // OpenAI models
  // GPT-4.1: Standard model, no explicit reasoning controls
  {
    id: "gpt-4.1",
    name: "GPT-4.1 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  // GPT-5 mini: Supports reasoning_effort (minimal, low, medium, high)
  {
    id: "gpt-5-mini",
    name: "GPT-5 mini (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  // GPT-5.1: Supports reasoning_effort (minimal, low, medium, high)
  {
    id: "gpt-5.1",
    name: "GPT-5.1 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  // GPT-5.1-Codex: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  {
    id: "gpt-5.1-codex",
    name: "GPT-5.1-Codex (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  // GPT-5.1-Codex-Mini: Fast variant with Adaptive Reasoning (supports reasoning_effort: none/low/medium)
  {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1-Codex-Mini (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  // GPT-5.1-Codex-Max: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1-Codex-Max (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  // GPT-5.2: Supports reasoning_effort (minimal, low, medium, high)
  {
    id: "gpt-5.2",
    name: "GPT-5.2 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  // GPT-5.2-Codex: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2-Codex (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  // GPT-5.3-Codex: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3-Codex (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  
  // Anthropic models
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-opus-4.6-fast",
    name: "Claude Opus 4.6 (fast mode) (preview) (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  
  // Google models
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  
  // xAI models
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1 (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  
  // Fine-tuned models
  {
    id: "raptor-mini",
    name: "Raptor mini (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "goldeneye",
    name: "Goldeneye (Copilot)",
    provider: "copilot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
];

export class CopilotProvider extends OpenAIProvider {
  private bearerToken: string | null = null;
  private githubToken: string | null = null;

  constructor(config: ProviderConfig) {
    const ghToken = config.authToken ?? detectCopilotToken();

    super(
      {
        ...config,
        apiKey: "placeholder-will-be-fetched-async",
        authToken: ghToken ?? undefined,
        headers: { ...config.headers, ...COPILOT_HEADERS }
      },
      "copilot",
      COPILOT_CHAT_URL,
    );

    this.githubToken = ghToken;
  }

  override listModels(): ModelDef[] {
    return COPILOT_MODELS;
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.authToken || detectCopilotToken());
  }

  private _copilotClient: OpenAI | null = null;

  protected override get client(): OpenAI {
    if (!this._copilotClient) {
      this._copilotClient = new OpenAI({
        apiKey: this.bearerToken || "placeholder-awaiting-async-init",
        baseURL: COPILOT_CHAT_URL,
        defaultHeaders: { ...this.config.headers }, // Headers are already merged in constructor
      });
    }
    return this._copilotClient;
  }

  override async *streamResponse(request: import("./types").StreamRequest): AsyncGenerator<import("./types").ProviderEvent> {
    await this.ensureBearerToken();
    yield* super.streamResponse(request);
  }

  private async ensureBearerToken() {
    if (this.bearerToken) return;

    if (!this.githubToken) {
       this.githubToken = detectCopilotToken();
    }

    if (!this.githubToken) {
      throw new Error("GitHub Copilot token not found. Please authenticate.");
    }

    const bearer = await exchangeGitHubTokenForCopilotAsync(this.githubToken);
    if (bearer) {
      this.bearerToken = bearer;
      // Force recreation of client with new token
      this._copilotClient = null;
    } else {
      throw new Error("Failed to exchange GitHub token for Copilot bearer token.");
    }
  }
}

// Detect Copilot OAuth token from local config files (mirrors OpenCode's LoadGitHubToken)
export function detectCopilotToken(): string | null {
  // 1. Environment variables first
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GITHUB_COPILOT_TOKEN;
  if (envToken) return envToken;

  // 2. Resolve config directory (respects XDG_CONFIG_HOME on Linux)
  const configDir = process.env.XDG_CONFIG_HOME
    ?? join(homedir(), ".config");

  // 3. Check both hosts.json and apps.json in github-copilot config
  const filePaths = [
    join(configDir, "github-copilot", "hosts.json"),
    join(configDir, "github-copilot", "apps.json"),
  ];

  for (const path of filePaths) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, unknown>>;
      for (const key of Object.keys(data)) {
        if (key.includes("github.com")) {
          const oauthToken = data[key]?.oauth_token;
          if (typeof oauthToken === "string" && oauthToken) return oauthToken;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveCopilotBearerToken(githubToken?: string | null): string | null {
  if (!githubToken) return null;
  return exchangeGitHubTokenForCopilot(githubToken);
}

// Exchange GitHub OAuth token for Copilot bearer token (mirrors OpenCode's exchangeGitHubToken)
function exchangeGitHubTokenForCopilot(githubToken: string): string | null {
  // Use Bun.spawnSync + curl for synchronous exchange in constructor
  const proc = Bun.spawnSync(
    [
      "curl", "-sS",
      "https://api.github.com/copilot_internal/v2/token",
      "-H", `Authorization: Token ${githubToken}`,
      "-H", "User-Agent: Koryphaios/1.0",
      "-H", "Accept: application/json",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
    console.error("[copilot] Token exchange failed:", stderr || `exit code ${proc.exitCode}`);
    return null;
  }

  try {
    const body = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    const parsed = JSON.parse(body) as { token?: string; expires_at?: number };
    if (!parsed.token) {
      console.error("[copilot] Token exchange returned no token:", body.slice(0, 200));
      return null;
    }
    return parsed.token;
  } catch (err) {
    console.error("[copilot] Token exchange parse error:", err);
    return null;
  }
}

// Async version for verification/refresh flows
export async function exchangeGitHubTokenForCopilotAsync(githubToken: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
      method: "GET",
      headers: {
        Authorization: `Token ${githubToken}`,
        "User-Agent": "Koryphaios/1.0",
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[copilot] Token exchange HTTP ${resp.status}:`, body.slice(0, 200));
      return null;
    }
    const data = await resp.json() as { token?: string; expires_at?: number };
    return data.token ?? null;
  } catch (err) {
    console.error("[copilot] Token exchange error:", err);
    return null;
  }
}

export interface CopilotDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface CopilotDeviceAuthPoll {
  accessToken?: string;
  tokenType?: string;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub CLI client id

export async function startCopilotDeviceAuth(): Promise<CopilotDeviceAuthStart> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("scope", "read:user");

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to start device auth: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval ?? 5,
  };
}

export async function pollCopilotDeviceAuth(deviceCode: string): Promise<CopilotDeviceAuthPoll> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("device_code", deviceCode);
  params.append("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to poll device auth: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope,
    error: data.error,
    errorDescription: data.error_description,
  };
}
