// Custom (bring-your-own) provider — user-defined endpoints.
//
// A user can add their own provider by giving a base URL + optional API key and choosing
// a wire format ("kind"): OpenAI-compatible (default — the most common), Anthropic-compatible
// (/v1/messages), or Gemini-compatible. We wrap the matching built-in provider so all the
// streaming/parsing logic is reused, and merge any explicitly-declared models with whatever
// the endpoint's /models discovery returns.

import type { ProviderConfig, ModelDef, ProviderName } from '@koryphaios/shared';
import { serverLog } from '../logger';
import { type Provider, type ProviderEvent, type StreamRequest, createGenericModel } from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GoogleProvider } from './google';

export type CustomProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface CustomProviderProbeInput {
  kind?: CustomProviderKind;
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  headers?: Record<string, string>;
}

export interface CustomProviderProbeResult {
  success: boolean;
  normalizedBaseUrl?: string;
  models: string[];
  status?: number;
  error?: string;
  /** Authentication failures can never be bypassed. Catalog/network gaps can. */
  canSaveUnverified: boolean;
}

const MAX_MODEL_CATALOG_BYTES = 2 * 1024 * 1024;
const TERMINAL_API_PATHS = [
  /\/chat\/completions$/i,
  /\/responses$/i,
  /\/messages$/i,
  /\/models(?:\/[^/]+(?::[a-z]+)?)?$/i,
];

/**
 * Turn the URL users normally copy from provider docs into an API base URL.
 * Koryphaios accepts only HTTP(S), rejects embedded credentials, removes
 * query/fragment material, and repairs common terminal API paths.
 */
export function normalizeCustomProviderBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('A base URL is required');

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Enter a complete endpoint URL beginning with http:// or https://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Custom provider endpoints must use http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not put credentials in the endpoint URL; use the API key field');
  }

  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  for (const terminalPath of TERMINAL_API_PATHS) {
    if (terminalPath.test(pathname)) {
      pathname = pathname.replace(terminalPath, '');
      break;
    }
  }
  parsed.pathname = pathname || '/';

  return parsed.toString().replace(/\/$/, '');
}

function modelCatalogUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

function modelIdsFromCatalog(payload: unknown, kind: CustomProviderKind): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const entries = kind === 'gemini' ? record.models : record.data;
  if (!Array.isArray(entries)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = (entry as Record<string, unknown>)[kind === 'gemini' ? 'name' : 'id'];
    if (typeof raw !== 'string') continue;
    const id = raw.replace(/^models\//, '').trim();
    if (!id || id.length > 512 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_CATALOG_BYTES) {
    throw new Error('catalog-too-large');
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_MODEL_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error('catalog-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Probe a staged custom provider before it is allowed into durable config. */
export async function probeCustomProvider(
  input: CustomProviderProbeInput,
  options: { timeoutMs?: number } = {},
): Promise<CustomProviderProbeResult> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeCustomProviderBaseUrl(input.baseUrl);
  } catch (error: unknown) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : 'The endpoint URL is invalid',
      canSaveUnverified: false,
    };
  }

  const kind = input.kind ?? 'openai';
  if (kind === 'gemini' && !input.apiKey?.trim() && !input.authToken?.trim()) {
    return {
      success: false,
      normalizedBaseUrl,
      models: [],
      error:
        'Gemini-compatible endpoints require an API key. Nothing was saved; use OpenAI-compatible for a keyless local endpoint that exposes that wire format.',
      canSaveUnverified: false,
    };
  }
  const headers = new Headers(input.headers ?? {});
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', 'Koryphaios/1.0');
  const credential = input.apiKey?.trim() || input.authToken?.trim();
  if (credential) {
    if (kind === 'anthropic' && input.apiKey?.trim()) {
      headers.set('x-api-key', credential);
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    } else if (kind === 'gemini') {
      headers.set('x-goog-api-key', credential);
    } else {
      headers.set('Authorization', `Bearer ${credential}`);
    }
  }

  const catalogUrl = modelCatalogUrl(normalizedBaseUrl);
  try {
    const response = await fetch(catalogUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      if (status === 401 || status === 403) {
        return {
          success: false,
          normalizedBaseUrl,
          models: [],
          status,
          error: credential
            ? `The endpoint rejected this API key (HTTP ${status}). Nothing was saved.`
            : `This endpoint requires credentials (HTTP ${status}). Nothing was saved.`,
          canSaveUnverified: false,
        };
      }
      return {
        success: false,
        normalizedBaseUrl,
        models: [],
        status,
        error: `Koryphaios could not verify a model catalog at ${catalogUrl} (HTTP ${status}).`,
        canSaveUnverified: true,
      };
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error: unknown) {
      const tooLarge = error instanceof Error && error.message === 'catalog-too-large';
      return {
        success: false,
        normalizedBaseUrl,
        models: [],
        status: response.status,
        error: tooLarge
          ? "The model catalog was larger than Koryphaios's 2 MiB safety limit."
          : 'The model catalog did not return valid JSON.',
        canSaveUnverified: true,
      };
    }

    const models = modelIdsFromCatalog(payload, kind);
    if (models.length === 0) {
      return {
        success: false,
        normalizedBaseUrl,
        models: [],
        status: response.status,
        error: 'The endpoint responded, but its model catalog contained no valid model IDs.',
        canSaveUnverified: true,
      };
    }
    return {
      success: true,
      normalizedBaseUrl,
      models,
      status: response.status,
      canSaveUnverified: false,
    };
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      success: false,
      normalizedBaseUrl,
      models: [],
      error: timedOut
        ? 'The endpoint did not answer within 5 seconds.'
        : 'Koryphaios could not reach the endpoint.',
      canSaveUnverified: true,
    };
  }
}

export class CustomProvider implements Provider {
  readonly name: ProviderName;
  private readonly inner: Provider;
  private catalogRefreshRequested = false;

  constructor(readonly config: ProviderConfig) {
    this.name = config.name;
    const kind: CustomProviderKind = config.kind ?? 'openai';
    if (kind === 'anthropic') {
      this.inner = new AnthropicProvider(config, config.name);
    } else if (kind === 'gemini') {
      this.inner = new GoogleProvider({ ...config });
    } else {
      this.inner = new OpenAIProvider(config, config.name, config.baseUrl);
    }
  }

  isAvailable(): boolean {
    // A custom provider is usable as long as it's enabled and has an endpoint. The API key
    // is optional (many self-hosted OpenAI-compatible servers don't require one).
    if (this.config.disabled) return false;
    if (!this.config.baseUrl) return false;
    return true;
  }

  listModels(): ModelDef[] {
    const declared = (this.config.models ?? []).map((id) => {
      const m = createGenericModel(id, this.name);
      m.apiModelId = id;
      return m;
    });
    let live: ModelDef[] = [];
    if (this.catalogRefreshRequested) {
      try {
        live = this.inner.listModels();
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Custom provider: live model list failed',
        );
        live = [];
      }
    }
    const seen = new Set<string>();
    const merged: ModelDef[] = [];
    for (const m of [...declared, ...live]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    return merged;
  }

  refreshModels(forceRefresh = false): void | Promise<unknown> {
    this.catalogRefreshRequested = true;
    return this.inner.refreshModels?.(forceRefresh);
  }

  getModelDiscoveryError(): string | undefined {
    return this.inner.getModelDiscoveryError?.();
  }

  streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    return this.inner.streamResponse(request);
  }
}

/** Derive a stable provider id from a user-supplied label. */
export function customProviderId(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `custom:${slug || 'provider'}`;
}

export function isCustomProviderId(name: string): boolean {
  return typeof name === 'string' && name.startsWith('custom:');
}
