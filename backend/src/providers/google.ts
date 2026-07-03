// Google provider — direct API access only.
// Uses Google's GenAI SDK for direct API access.
// Model list is refreshed from the Gemini API when available; static list is fallback only.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
  resolveModel,
} from './types';
import { GEMINI_V1BETA_BASE } from './api-endpoints';
import { withRetry } from './utils';
import {
  isModelListCacheFresh,
  mergeModelLists,
  modelFromRemoteId,
} from './model-list-cache';
import { providerLog } from '../logger';

export class GoogleProvider implements Provider {
  readonly name: 'google' | 'vertexai';

  constructor(readonly config: ProviderConfig) {
    this.name = config.name === 'vertexai' ? 'vertexai' : 'google';
  }

  isAvailable(): boolean {
    const available = !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
    if (available && this.name === 'google' && !isModelListCacheFresh(this.lastFetch)) {
      this.refreshModelsInBackground(getModelsForProvider(this.name));
    }
    return available;
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private fetchInProgress = false;

  listModels(): ModelDef[] {
    const fallback = getModelsForProvider(this.name);
    if (this.name !== 'google') return fallback;
    if (!this.isAvailable()) return fallback;
    if (this.cachedModels && isModelListCacheFresh(this.lastFetch)) return this.cachedModels;
    this.refreshModelsInBackground(fallback);
    return this.cachedModels ?? fallback;
  }

  private refreshModelsInBackground(fallback: ModelDef[]) {
    if (this.fetchInProgress) return;
    const apiKey = this.config.apiKey || this.config.authToken;
    if (!apiKey) return;

    this.fetchInProgress = true;
    const url = `${GEMINI_V1BETA_BASE}/models?key=${encodeURIComponent(apiKey)}`;

    void (async () => {
      try {
        const body = await withRetry(() =>
          fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))),
        ) as { models?: Array<{ name?: string }> };
        const discovered: ModelDef[] = [];
        for (const m of body.models ?? []) {
          const name = m.name;
          if (!name || !name.startsWith('models/')) continue;
          const id = name.replace(/^models\//, '');
          discovered.push(modelFromRemoteId(id, 'google', fallback));
        }
        if (discovered.length > 0) {
          this.cachedModels = mergeModelLists(fallback, discovered);
          providerLog.debug(
            { provider: 'google', count: this.cachedModels.length },
            'Model list refreshed from Gemini API',
          );
        } else {
          this.cachedModels ??= fallback;
        }
        this.lastFetch = Date.now();
      } catch (err) {
        providerLog.debug(
          { provider: 'google', err: err instanceof Error ? err.message : String(err) },
          'Model list refresh failed; using catalog fallback',
        );
        this.cachedModels ??= fallback;
      } finally {
        this.fetchInProgress = false;
      }
    })();
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const { GoogleGenAI } = await import('@google/genai');

    const apiKey = this.config.apiKey || this.config.authToken;
    if (!apiKey) {
      yield {
        type: 'error',
        error:
          this.name === 'vertexai'
            ? 'Vertex AI requires an explicit API key (set GOOGLE_VERTEX_AI_API_KEY)'
            : 'No API key available',
      };
      return;
    }

    // Vertex AI is a DIFFERENT backend from the consumer Gemini API: it routes to
    // {location}-aiplatform.googleapis.com under a GCP project, not generativelanguage.
    // The official SDK builds that wire shape when vertexai:true. Project/location come
    // from the standard GCP env vars; an API key enables Vertex express mode.
    const clientOptions: any =
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
      clientOptions.baseUrl = this.config.baseUrl;
    }

    const client = new GoogleGenAI(clientOptions);

    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : (m.content as any[])
                .map((b) => {
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
                .filter((p): p is NonNullable<typeof p> => p !== null),
      }))
      // The API rejects messages with zero parts.
      .filter((m) => m.parts.length > 0);

    const generationConfig: any = {
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
        const hasImages = contents.some((m) => m.parts.some((p: any) => p.inlineData));
        const msg = err instanceof Error ? err.message : String(err);
        if (hasImages && /image|vision|multimodal|inline_?data/i.test(msg)) {
          for (const m of contents) {
            m.parts = m.parts.map((p: any) =>
              p.inlineData
                ? { text: '[image attachment omitted — the selected model does not support image input]' }
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
          };
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;
        for (const part of candidate.content.parts) {
          if (part.text) yield { type: 'content_delta', content: part.text };
        }
        if (candidate.finishReason) yield { type: 'complete', finishReason: 'end_turn' };
      }
    } catch (err: any) {
      yield { type: 'error', error: err.message ?? String(err) };
    }
  }
}
