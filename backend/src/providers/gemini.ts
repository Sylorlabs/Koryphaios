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
  createGenericModel,
} from './types';
import { GEMINI_V1BETA_BASE } from './api-endpoints';
import { withRetry } from './utils';

export class GeminiProvider implements Provider {
  readonly name: 'google' | 'vertexai';

  constructor(readonly config: ProviderConfig) {
    this.name = config.name === 'vertexai' ? 'vertexai' : 'google';
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;

  listModels(): ModelDef[] {
    const localModels = getModelsForProvider(this.name);
    if (this.name !== 'google') return localModels;
    if (!this.isAvailable()) return localModels;
    if (this.cachedModels && Date.now() - this.lastFetch < 5 * 60 * 1000) {
      return this.cachedModels;
    }
    this.refreshModelsInBackground(localModels);
    return this.cachedModels ?? localModels;
  }

  private refreshModelsInBackground(localModels: ModelDef[]) {
    const apiKey = this.config.apiKey || this.config.authToken;
    if (!apiKey) return;
    const url = `${GEMINI_V1BETA_BASE}/models?key=${encodeURIComponent(apiKey)}`;
    withRetry(() =>
      fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))),
    )
      .then((body: { models?: Array<{ name?: string }> }) => {
        const remote: ModelDef[] = [];
        for (const m of body.models ?? []) {
          const name = m.name;
          if (!name || !name.startsWith('models/')) continue;
          const id = name.replace(/^models\//, '');
          if (localModels.some((l) => l.id === id || l.apiModelId === id)) continue;
          const def = createGenericModel(id, 'google');
          def.apiModelId = id;
          remote.push(def);
        }
        this.cachedModels = [...localModels, ...remote];
        this.lastFetch = Date.now();
      })
      .catch(() => {
        if (!this.cachedModels) this.cachedModels = localModels;
      });
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
            : (m.content as any[]).map((b) =>
                b.type === 'text' ? { text: b.text ?? '' } : { text: '' },
              ),
      }));

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
      const response = await client.models.generateContentStream({
        model: apiModel,
        contents,
        config: generationConfig,
      });

      for await (const chunk of response) {
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
