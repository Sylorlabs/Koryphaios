// Google provider — supports both API calls and google-cli child process wrapper.
// Uses Google's GenAI SDK for direct API access.

import type { ProviderConfig, ModelDef } from "@koryphaios/shared";
import { detectGeminiCLIToken, detectAntigravityToken } from "./auth-utils";
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
  createGenericModel,
  resolveModel,
} from "./types";
import { withRetry } from "./utils";
import { googleAuth } from "./google-auth";
import { providerLog } from "../logger";

// Cache for Antigravity access tokens
const ANTIGRAVITY_TOKEN_CACHE = new Map<string, { token: string; expires: number }>();

export class GeminiProvider implements Provider {
  readonly name: "google" | "vertexai" | "antigravity";

  constructor(readonly config: ProviderConfig) {
    this.name = (config.name === "vertexai" ? "vertexai" : config.name === "antigravity" ? "antigravity" : "google") as any;
  }

  isAvailable(): boolean {
    const hasAuth = !!(this.config.apiKey || this.config.authToken || detectGeminiCLIToken() || detectAntigravityToken());
    return !this.config.disabled && hasAuth;
  }

  async listModels(): Promise<ModelDef[]> {
    return getModelsForProvider(this.name);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const { GoogleGenAI } = await import("@google/genai");
    
    let apiKey = this.config.apiKey || this.config.authToken || detectAntigravityToken() || detectGeminiCLIToken();
    
    const clientOptions: any = { apiKey: apiKey! };
    const extraHeaders: Record<string, string> = {};

    // Antigravity hijacking logic
    const isAntigravity = this.name === "antigravity" || (this.config.baseUrl?.includes("antigravity") || !!detectAntigravityToken()) && !this.config.apiKey;
    
    if (isAntigravity && apiKey?.startsWith("1//")) {
      const cached = ANTIGRAVITY_TOKEN_CACHE.get(apiKey);
      if (cached && cached.expires > Date.now()) {
        apiKey = cached.token;
      } else {
        try {
          const result = await googleAuth.refreshAntigravityToken(apiKey);
          const refreshToken = apiKey;
          apiKey = result.accessToken;
          ANTIGRAVITY_TOKEN_CACHE.set(refreshToken, {
            token: apiKey,
            expires: Date.now() + (result.expiresIn * 1000) - 60000
          });
        } catch (err) {
          providerLog.error({ err }, "Failed to refresh Antigravity token");
        }
      }
    }

    if (isAntigravity || this.config.baseUrl) {
      clientOptions.baseUrl = this.config.baseUrl || "https://ide.google.com/api/antigravity/v1";
    }

    if (isAntigravity) {
      extraHeaders["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.15.8 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
      extraHeaders["Client-Metadata"] = JSON.stringify({ ideType: "ANTIGRAVITY", platform: "LINUX", pluginType: "GEMINI" });
    }

    const client = new GoogleGenAI(clientOptions);

    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: typeof m.content === "string" ? [{ text: m.content }] : (m.content as any[]).map(b => b.type === "text" ? { text: b.text ?? "" } : { text: "" }),
      }));

    const generationConfig: any = {
      systemInstruction: request.systemPrompt,
      maxOutputTokens: request.maxTokens ?? 65_536,
      temperature: request.temperature,
    };

    const modelDef = resolveModel(request.model);
    const apiModel = modelDef?.apiModelId || request.model;

    try {
      const response = await client.models.generateContentStream({
        model: apiModel,
        contents,
        config: generationConfig,
      });

      for await (const chunk of response) {
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;
        for (const part of candidate.content.parts) {
          if (part.text) yield { type: "content_delta", content: part.text };
        }
        if (candidate.finishReason) yield { type: "complete", finishReason: "end_turn" };
      }
    } catch (err: any) {
      yield { type: "error", error: err.message ?? String(err) };
    }
  }
}

export class GeminiCLIProvider implements Provider {
  readonly name: "google";
  private cliAvailable: boolean | null = null;

  constructor(readonly config: ProviderConfig) {
    this.name = "google";
  }

  isAvailable(): boolean {
    const hasAuth = this.config.authToken?.startsWith("cli:") || !!detectGeminiCLIToken();
    if (!hasAuth || this.config.disabled) return false;
    if (this.cliAvailable === null) {
      const proc = Bun.spawnSync(["which", "gemini"]);
      this.cliAvailable = proc.exitCode === 0;
    }
    return this.cliAvailable;
  }

  async listModels(): Promise<ModelDef[]> {
    return getModelsForProvider(this.name);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const modelDef = resolveModel(request.model);
    let cliModel = modelDef?.apiModelId || request.model;
    
    // Explicit CLI Auto Mappings
    if (request.model === "auto-gemini-3") cliModel = "gemini-3";
    if (request.model === "auto-gemini-2.5") cliModel = "gemini-2.5";

    const prompt = request.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    try {
      const proc = Bun.spawn(["gemini", "--model", cliModel, "--prompt", prompt], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...this.config.headers },
      });

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) yield { type: "content_delta", content: text };
      }
      yield { type: "complete", finishReason: "end_turn" };
    } catch (err: any) {
      yield { type: "error", error: "Gemini CLI error: " + (err.message ?? String(err)) };
    }
  }
}
