// Copilot provider — uses GitHub Copilot's chat completions API.
// Auth flow: detect GitHub OAuth token → exchange for Copilot bearer (lazily, with 30-min cache) → send with IDE headers.
// Token sources: gh CLI, ~/.config/github-copilot/hosts.json, apps.json, GITHUB_TOKEN env, device auth flow.

import type { ProviderConfig, ModelDef } from "@koryphaios/shared";
import { OpenAIProvider } from "./openai";
import { detectCopilotToken } from "./auth-utils";
import type { StreamRequest, ProviderEvent } from "./types";
import OpenAI from "openai";

const COPILOT_CHAT_URL = "https://api.githubcopilot.com";

// These headers are REQUIRED by GitHub's Copilot API — without them you get HTTP 400.
// Values must match a known IDE integration; "vscode-chat" is the standard one used by OpenCode, Cursor, etc.
const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.100.0",
  "Editor-Plugin-Version": "copilot-chat/0.27.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "Koryphaios/1.0",
} as const;

// Copilot model catalog — only models currently supported per
// https://docs.github.com/en/copilot/reference/ai-models/supported-models
// Retired models (o1, o3, o3-mini, o4-mini, Claude 3.5/3.7, Gemini 2.0 Flash, GPT-4, GPT-4o, etc.) are excluded.
const COPILOT_MODELS: ModelDef[] = [
  { id: "gpt-4.1", name: "GPT-4.1 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5-mini", name: "GPT-5 mini (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.1", name: "GPT-5.1 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.1-codex", name: "GPT-5.1-Codex (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1-Codex-Mini (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.2", name: "GPT-5.2 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.2-codex", name: "GPT-5.2-Codex (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 8_192, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-opus-4.6-fast", name: "Claude Opus 4.6 fast (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_000, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_000, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_000, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 64_000, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 8_192, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "gemini-3-pro", name: "Gemini 3 Pro (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 64_000, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 64_000, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: true, supportsAttachments: true, supportsStreaming: true },
  { id: "grok-code-fast-1", name: "Grok Code Fast 1 (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 8_192, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "raptor-mini", name: "Raptor mini (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
  { id: "goldeneye", name: "Goldeneye (Copilot)", provider: "copilot", contextWindow: 128_000, maxOutputTokens: 16_384, costPerMInputTokens: 0, costPerMOutputTokens: 0, canReason: false, supportsAttachments: true, supportsStreaming: true },
];

// Bearer tokens from GitHub's Copilot token exchange last 30 minutes.
// Refresh 60 seconds before expiry to avoid mid-request failures.
const COPILOT_BEARER_TTL_MS = 30 * 60 * 1000;
const COPILOT_BEARER_REFRESH_BUFFER_MS = 60 * 1000;

export class CopilotProvider extends OpenAIProvider {
  private bearerCache: { token: string; expiresAt: number } | null = null;
  private githubToken: string | null = null;

  constructor(config: ProviderConfig) {
    const ghToken = config.authToken ?? detectCopilotToken();
    // Initialize parent without a bearer — token is exchanged lazily on first request
    super(
      { ...config, apiKey: undefined, authToken: ghToken ?? undefined, headers: { ...config.headers, ...COPILOT_HEADERS } },
      "copilot",
      COPILOT_CHAT_URL,
    );
    this.githubToken = ghToken ?? null;
  }

  private async getOrRefreshBearer(): Promise<string | null> {
    if (
      this.bearerCache &&
      Date.now() < this.bearerCache.expiresAt - COPILOT_BEARER_REFRESH_BUFFER_MS
    ) {
      return this.bearerCache.token;
    }
    if (!this.githubToken) return null;
    const token = await exchangeGitHubTokenForCopilotAsync(this.githubToken);
    if (!token) return null;
    this.bearerCache = { token, expiresAt: Date.now() + COPILOT_BEARER_TTL_MS };
    return token;
  }

  override async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bearer = await this.getOrRefreshBearer();
    if (!bearer) {
      yield {
        type: "error",
        error: "Failed to get Copilot bearer token. Is your GitHub token valid and Copilot enabled?",
      };
      return;
    }
    this._client = new OpenAI({
      apiKey: bearer,
      baseURL: COPILOT_CHAT_URL,
      defaultHeaders: { ...this.config.headers },
    });
    yield* super.streamResponse(request);
  }

  override listModels(): ModelDef[] {
    return COPILOT_MODELS;
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.githubToken ?? detectCopilotToken());
  }
}

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

const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export async function startCopilotDeviceAuth(): Promise<CopilotDeviceAuthStart> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("scope", "read:user");
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!response.ok) throw new Error(`Failed to start device auth: HTTP ${response.status}`);
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
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!response.ok) throw new Error(`Failed to poll device auth: HTTP ${response.status}`);
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
