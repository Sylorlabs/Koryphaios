// Google provider — direct API access only.
// Uses Google's GenAI SDK for direct API access.
// Model list is refreshed from the Gemini API when available; static list is fallback only.

import type { ProviderConfig, ProviderName, ModelDef } from '@koryphaios/shared';
import { type Provider, type ProviderEvent, type StreamRequest, resolveModel } from './types';
import { GEMINI_V1BETA_BASE } from './api-endpoints';
import { withRetry } from './utils';
import { isModelListCacheFresh, mergeModelLists, modelFromRemoteId } from './model-list-cache';
import { applyModelsDevMetadata, warmModelsDevCache } from './models-dev';
import { providerLog } from '../logger';
import { safeProviderDiagnostic, safeProviderFailureMessage } from './provider-diagnostics';

// ============================================================================
// Error classification helpers
//
// Gemini's API surfaces a few specific error shapes that the streaming path
// needs to recognize so it can retry with a degraded config (drop thinking,
// drop temperature) instead of failing the whole turn. These predicates are
// exported so tests can pin the matching behavior independently of the SDK.
// ============================================================================

/** True when the error indicates the model rejects thinking-budget configuration. */
export function rejectsThinkingConfiguration(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /thinking budget is not supported/i.test(msg);
}

/** True when the error indicates the model rejects temperature configuration. */
export function rejectsTemperatureConfiguration(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /temperature is deprecated/i.test(msg);
}

/**
 * Turn a raw Gemini API error into a single actionable user-facing message.
 *
 * Gemini quota errors arrive as a JSON-encoded string inside the Error
 * message. We parse it, classify by provider (AI Studio vs Vertex), and
 * return a concise instruction. Raw status codes (RESOURCE_EXHAUSTED etc.)
 * are stripped so the user never sees the raw API status enum.
 */
export function formatGoogleProviderError(err: unknown, modelId: string, provider: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  let status = '';
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    status = parsed?.error?.status ?? '';
    message = parsed?.error?.message ?? raw;
  } catch (err: unknown) {
    // Not JSON — use the raw message. Expected for non-JSON error strings.
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err), modelId },
      'Google error string is not JSON, using raw message',
    );
  }

  const isVertex = provider === 'vertexai';
  const isQuota = status === 'RESOURCE_EXHAUSTED' || /quota exceeded/i.test(message);

  if (isQuota) {
    if (isVertex) {
      return `Vertex AI has no available quota for ${modelId}. Request quota increase in the Google Cloud Console (IAM & Admin → Quotas).`;
    }
    return `Google AI Studio has no available quota for ${modelId}. Go to https://aistudio.google.com, open Settings, and enable billing on your Google Cloud project to raise rate limits.`;
  }

  const diagnostic = safeProviderDiagnostic(provider, 'sdk', err);
  return safeProviderFailureMessage(provider, diagnostic);
}

export class GoogleProvider implements Provider {
  // 'aistudio' is the AI Studio brand of the same Gemini (generativelanguage)
  // API — behaves exactly like 'google', just a distinct, unambiguous
  // API-key-only provider entry so users never hit the gcloud OAuth path.
  readonly name: ProviderName;

  constructor(readonly config: ProviderConfig) {
    this.name = config.custom
      ? config.name
      : config.name === 'vertexai'
        ? 'vertexai'
        : config.name === 'aistudio'
          ? 'aistudio'
          : 'google';
  }

  /** True for the Gemini AI Studio API (generativelanguage), false for Vertex. */
  private get isAiStudio(): boolean {
    return this.name !== 'vertexai';
  }

  isAvailable(): boolean {
    const customCredential = this.config.apiKey || this.config.authToken;
    const available =
      !this.config.disabled &&
      !!(this.config.custom ? this.config.baseUrl && customCredential : this.config.apiKey);
    if (available && this.isAiStudio && !isModelListCacheFresh(this.lastFetch)) {
      this.refreshModelsInBackground([]);
    }
    return available;
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private fetchInProgress = false;

  listModels(): ModelDef[] {
    const fallback: ModelDef[] = [];
    if (!this.isAiStudio) return [];
    if (!this.isAvailable()) return [];
    if (this.cachedModels && isModelListCacheFresh(this.lastFetch)) return this.cachedModels;
    this.refreshModelsInBackground(fallback);
    return this.cachedModels ?? [];
  }

  private refreshModelsInBackground(fallback: ModelDef[]) {
    if (this.fetchInProgress) return;
    void this.refreshModels(false, fallback).catch(() => {
      // refreshModels already logs at debug level; swallow to avoid unhandled rejection
    });
  }

  async refreshModels(force?: boolean, fallback: ModelDef[] = []): Promise<void> {
    if (this.fetchInProgress && !force) return;
    const apiKey = this.config.apiKey || (this.config.custom ? this.config.authToken : undefined);
    if (!apiKey && !this.config.custom) return;

    this.fetchInProgress = true;
    const customBase = this.config.custom ? this.config.baseUrl?.replace(/\/+$/, '') : undefined;
    const url = customBase
      ? `${customBase}/models`
      : `${GEMINI_V1BETA_BASE}/models?key=${encodeURIComponent(apiKey!)}`;
    const headers = new Headers(this.config.headers ?? {});
    if (customBase && apiKey) headers.set('x-goog-api-key', apiKey);

    try {
      // Await models.dev so enrichment data is available when discovery completes.
      await warmModelsDevCache();
      const body = (await withRetry(() =>
        fetch(url, { headers }).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(r.statusText)),
        ),
      )) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          inputTokenLimit?: number;
          outputTokenLimit?: number;
          supportedGenerationMethods?: string[];
          thinking?: boolean;
          supportedThinkingLevels?: string[];
          temperature?: number;
          maxTemperature?: number;
        }>;
      };
      const discovered: ModelDef[] = [];
      for (const m of body.models ?? []) {
        const name = m.name;
        if (!name || !name.startsWith('models/')) continue;
        // Filter out non-chat models (embedders, etc.)
        const methods = m.supportedGenerationMethods ?? [];
        if (!methods.includes('generateContent')) continue;
        const id = name.replace(/^models\//, '');
        const base = modelFromRemoteId(id, this.name, fallback);
        const enriched: ModelDef = {
          ...base,
          ...(m.displayName ? { name: m.displayName } : {}),
          ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit, contextVerified: true } : {}),
          ...(m.outputTokenLimit ? { maxOutputTokens: m.outputTokenLimit } : {}),
          ...(m.thinking ? { canReason: true } : {}),
          ...(m.supportedThinkingLevels?.length
            ? { reasoningLevels: m.supportedThinkingLevels }
            : {}),
          ...(typeof m.temperature === 'number' ? { temperature: m.temperature } : {}),
          ...(typeof m.maxTemperature === 'number' ? { maxTemperature: m.maxTemperature } : {}),
        };
        discovered.push(enriched);
      }
      if (discovered.length > 0) {
        this.cachedModels = applyModelsDevMetadata(
          this.name,
          mergeModelLists(fallback, discovered),
        );
        providerLog.debug(
          { provider: this.name, count: this.cachedModels.length },
          'Model list refreshed from Gemini API',
        );
      }
      this.lastFetch = Date.now();
    } catch (err) {
      this.lastFetch = Date.now();
      providerLog.debug(
        { provider: this.name, err: err instanceof Error ? err.message : String(err) },
        'Model list refresh failed; leaving catalog empty rather than exposing a fallback list',
      );
    } finally {
      this.fetchInProgress = false;
    }
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const { GoogleGenAI } = await import('@google/genai');

    const apiKey = this.config.apiKey || (this.config.custom ? this.config.authToken : undefined);
    if (!apiKey) {
      yield {
        type: 'error',
        error:
          this.name === 'vertexai'
            ? 'Vertex AI requires an explicit API key (set GOOGLE_VERTEX_AI_API_KEY)'
            : this.config.custom
              ? 'Gemini-compatible custom providers require an API key'
              : 'No API key available',
      };
      return;
    }

    // Vertex AI is a DIFFERENT backend from the consumer Gemini API: it routes to
    // {location}-aiplatform.googleapis.com under a GCP project, not generativelanguage.
    // The official SDK builds that wire shape when vertexai:true. Project/location come
    // from the standard GCP env vars; an API key enables Vertex express mode.
    // SDK constructor accepts a broad options shape; we build the two known
    // variants (Vertex vs AI Studio) and let the SDK validate at runtime.
    const clientOptions: Record<string, unknown> =
      this.name === 'vertexai'
        ? {
            vertexai: true,
            apiKey,
            project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_VERTEX_PROJECT,
            location:
              process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_VERTEX_LOCATION || undefined,
          }
        : { apiKey };

    if (this.config.baseUrl) {
      clientOptions.httpOptions = {
        baseUrl: this.config.baseUrl,
        headers: { ...(this.config.headers ?? {}) },
      };
    }

    const client = new GoogleGenAI(clientOptions as ConstructorParameters<typeof GoogleGenAI>[0]);

    // Gemini content parts: either text or inlineData (image). The SDK's
    // Part type is a strict union; we build a compatible shape explicitly.
    type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? ([{ text: m.content }] satisfies GeminiPart[])
            : (
                m.content as Array<{
                  type: string;
                  text?: string;
                  imageData?: string;
                  imageMimeType?: string;
                }>
              )
                .map((b): GeminiPart | null => {
                  if (b.type === 'text') return { text: b.text ?? '' };
                  // Gemini is vision-capable — pass images as inlineData so the
                  // model actually sees them (previously mapped to empty text).
                  if (b.type === 'image' && b.imageData) {
                    return {
                      inlineData: {
                        mimeType: b.imageMimeType ?? 'image/png',
                        data: b.imageData,
                      },
                    };
                  }
                  return null;
                })
                .filter((p): p is GeminiPart => p !== null),
      }))
      // The API rejects messages with zero parts.
      .filter((m) => m.parts.length > 0);

    // SDK generateContent config accepts a broad shape; we populate the known
    // fields and conditionally add thinkingConfig below.
    const generationConfig: Record<string, unknown> = {
      systemInstruction: request.systemPrompt,
      maxOutputTokens: request.maxTokens ?? 65_536,
      temperature: request.temperature,
    };

    const modelDef = resolveModel(request.model);
    const apiModel = modelDef?.apiModelId || request.model;
    const isGemini3 = /gemini-3/i.test(request.model) || /gemini-3/i.test(apiModel ?? '');

    if (request.reasoningLevel !== undefined && request.reasoningLevel !== '') {
      const level = String(request.reasoningLevel).trim();
      if (isGemini3) {
        const thinkingLevel = ['low', 'medium', 'high'].includes(level.toLowerCase())
          ? level.toUpperCase()
          : 'MEDIUM';
        generationConfig.thinkingConfig = { thinkingLevel };
      } else {
        const budget =
          level === '0' || level.toLowerCase() === 'off'
            ? 0
            : Math.max(0, parseInt(level, 10) || 8192);
        generationConfig.thinkingConfig = { thinkingBudget: budget };
      }
    }

    try {
      let response: Awaited<ReturnType<typeof client.models.generateContentStream>>;
      try {
        response = await client.models.generateContentStream({
          model: apiModel,
          contents,
          config: generationConfig,
        });
      } catch (err) {
        // Gemini-compatible custom endpoints may reject inlineData images.
        // Degrade gracefully: swap them for a text note and retry once.
        const hasImages = contents.some((m) =>
          m.parts.some(
            (p): p is { inlineData: { mimeType: string; data: string } } =>
              'inlineData' in p && p.inlineData !== undefined,
          ),
        );
        const msg = err instanceof Error ? err.message : String(err);
        if (hasImages && /image|vision|multimodal|inline_?data/i.test(msg)) {
          for (const m of contents) {
            m.parts = m.parts.map((p): GeminiPart =>
              'inlineData' in p
                ? {
                    text: '[image attachment omitted — the selected model does not support image input]',
                  }
                : p,
            );
          }
          response = await client.models.generateContentStream({
            model: apiModel,
            contents,
            config: generationConfig,
          });
        } else {
          throw err;
        }
      }

      for await (const chunk of response) {
        // Gemini reports usage per chunk; promptTokenCount already includes any
        // cached content, so no separate tokensCache is emitted.
        const meta = chunk.usageMetadata;
        if (meta?.promptTokenCount || meta?.candidatesTokenCount) {
          yield {
            type: 'usage_update',
            tokensIn: meta.promptTokenCount ?? 0,
            tokensOut: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
            // Gemini includes cache hits inside promptTokenCount.
            tokensCacheRead: meta.cachedContentTokenCount,
          };
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;
        for (const part of candidate.content.parts) {
          if (!part.text) continue;
          const isThought = (part as { thought?: boolean }).thought === true;
          if (isThought) yield { type: 'thinking_delta', thinking: part.text };
          else yield { type: 'content_delta', content: part.text };
        }
        if (candidate.finishReason) yield { type: 'complete', finishReason: 'end_turn' };
      }
    } catch (err: unknown) {
      const diagnostic = safeProviderDiagnostic(this.name, 'sdk', err);
      providerLog.error({ ...diagnostic, model: request.model }, 'Google provider stream error');
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
    }
  }
}
