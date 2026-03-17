/**
 * Shared API helpers — cookie-based auth (credentials: 'include').
 * No tokens in JS; session is in HttpOnly cookies.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Reactive count of in-flight API requests */
let _inflight = $state(0);
export const apiLoading = {
  get count() { return _inflight; },
  get active() { return _inflight > 0; },
};

export function getAuthHeaders(): Record<string, string> {
  return {};
}

export async function apiFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  _inflight++;
  try {
    const headers = new Headers(init.headers);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        headers,
        credentials: 'include',
        signal: init.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    _inflight--;
  }
}

type LooseApiResponse = {
  ok?: boolean;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers access varied response shapes without narrowing
  data?: any;
  [key: string]: any;
};

/** Parse response as JSON; on empty or invalid body return { ok: false, error } so callers don't throw. */
export async function parseJsonResponse<T = LooseApiResponse>(
  res: Response
): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    const message = res.ok ? 'Empty response from server' : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const message = res.ok ? 'Invalid JSON from server' : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
}

import { friendlyHttpError as friendlyHttpErrorImpl } from './utils/http-error';
export { friendlyHttpErrorImpl as friendlyHttpError };

// ─── Dynamic Provider API ───────────────────────────────────────────────────

import type { 
  ProviderPreset, 
  DynamicProviderConfig, 
  ReasoningConfig,
  APIResponse,
} from '@koryphaios/shared';

const API_BASE = '/api';

/** Get available provider presets */
export async function getProviderPresets(): Promise<ProviderPreset[]> {
  const res = await apiFetch(`${API_BASE}/providers/presets`);
  const data = await parseJsonResponse(res);
  return data.ok ? data.data : [];
}

/** Get all dynamic providers */
export async function getDynamicProviders(): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic`);
  return parseJsonResponse(res);
}

/** Add a new dynamic provider */
export async function addDynamicProvider(
  config: DynamicProviderConfig
): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseJsonResponse(res);
}

/** Get a specific dynamic provider */
export async function getDynamicProvider(name: string): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic/${encodeURIComponent(name)}`);
  return parseJsonResponse(res);
}

/** Update a dynamic provider */
export async function updateDynamicProvider(
  name: string,
  config: Partial<DynamicProviderConfig>
): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseJsonResponse(res);
}

/** Remove a dynamic provider */
export async function removeDynamicProvider(name: string): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  return parseJsonResponse(res);
}

/** Test a dynamic provider connection */
export async function testDynamicProvider(
  name: string,
  config: Partial<DynamicProviderConfig>
): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseJsonResponse(res);
}

/** Update provider reasoning configuration */
export async function setProviderReasoning(
  name: string,
  config: ReasoningConfig
): Promise<APIResponse> {
  const res = await apiFetch(`${API_BASE}/providers/dynamic/${encodeURIComponent(name)}/reasoning`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseJsonResponse(res);
}

/** Update model-specific reasoning configuration */
export async function setModelReasoning(
  providerName: string,
  modelId: string,
  config: ReasoningConfig
): Promise<APIResponse> {
  const encodedName = encodeURIComponent(providerName);
  const encodedModel = encodeURIComponent(modelId);
  const res = await apiFetch(`${API_BASE}/providers/dynamic/${encodedName}/reasoning/${encodedModel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return parseJsonResponse(res);
}

/** Get reasoning configuration */
export async function getProviderReasoning(
  name: string,
  modelId?: string
): Promise<APIResponse> {
  let url = `${API_BASE}/providers/dynamic/${encodeURIComponent(name)}/reasoning`;
  if (modelId) {
    url += `?model=${encodeURIComponent(modelId)}`;
  }
  const res = await apiFetch(url);
  return parseJsonResponse(res);
}
