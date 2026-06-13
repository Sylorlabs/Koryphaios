// GitLab Duo provider — GitLab's hosted AI chat, via the GitLab Duo Chat Completions API.
//
// This is NOT OpenAI-compatible: the real endpoint is POST {instance}/api/v4/chat/completions
// with a GitLab-specific body ({ content, additional_context? }) authenticated by a GitLab
// PAT (Bearer), and it returns a single (non-streamed) JSON answer — not OpenAI SSE chunks.
// Ref: https://docs.gitlab.com/api/chat/
//
// We send the real request shape and adapt the single-shot answer into ProviderEvents.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type ProviderContentBlock,
  type ProviderMessage,
  type StreamRequest,
  getModelsForProvider,
} from './types';
import { withTimeoutSignal } from './utils';
import { providerLog } from '../logger';

const GITLAB_DEFAULT_BASE = 'https://gitlab.com/api/v4';

export class GitLabProvider implements Provider {
  readonly name = 'gitlab' as const;

  constructor(readonly config: ProviderConfig) {}

  private token(): string | undefined {
    return this.config.apiKey || this.config.authToken;
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!this.token();
  }

  listModels(): ModelDef[] {
    return getModelsForProvider('gitlab');
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const token = this.token();
    if (!token) {
      yield { type: 'error', error: 'GitLab token (Personal Access Token) required' };
      return;
    }

    const base = (this.config.baseUrl || GITLAB_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    const content = flattenToQuestion(request.systemPrompt, request.messages);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Koryphaios/1.0',
        },
        body: JSON.stringify({ content }),
        signal: withTimeoutSignal(request.signal, 60_000),
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        yield { type: 'error', error: `GitLab Duo HTTP ${res.status}${body ? `: ${body}` : ''}` };
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const text = extractAnswer(data);
      if (text) yield { type: 'content_delta', content: text };
      yield { type: 'complete', finishReason: 'end_turn' };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : String(err);
      providerLog.error({ provider: 'gitlab', err: message }, 'GitLab Duo request error');
      yield { type: 'error', error: message };
    }
  }
}

/** GitLab Duo Chat takes a single `content` question, not a message array. */
function flattenToQuestion(systemPrompt: string, messages: ProviderMessage[]): string {
  const parts: string[] = [];
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim());
  for (const m of messages) {
    if (m.role === 'system') continue;
    const text = typeof m.content === 'string' ? m.content : flattenBlocks(m.content);
    if (text.trim()) parts.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
  }
  return parts.join('\n\n');
}

function flattenBlocks(blocks: ProviderContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** GitLab Duo returns the answer as a JSON string (or an object wrapping it). */
function extractAnswer(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.response === 'string') return o.response;
    const choices = o.choices as Array<{ message?: { content?: string } }> | undefined;
    if (choices?.[0]?.message?.content) return choices[0].message!.content!;
    return JSON.stringify(data);
  }
  return '';
}
