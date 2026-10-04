import { ProviderRateLimitError, ValidationError } from '../../errors/types';
import type { ResolvedCapabilityConfig } from './types';

/** Bound on any single provider read; generation endpoints pass their own. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Provider capability responses are routinely megabytes of base64 media, but a
 * broken endpoint can also stream an error page forever. Cap every read so a
 * misconfigured provider cannot exhaust memory inside a request handler.
 */
export const MAX_CAPABILITY_RESPONSE_BYTES = 96 * 1024 * 1024;

export interface CapabilityFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Pre-encoded JSON body. */
  json?: unknown;
  /** Raw body (FormData, Buffer). Mutually exclusive with `json`. */
  body?: BodyInit;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Combine the caller's abort signal with a timeout, whichever fires first. */
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): AbortSignal {
  const timer = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

function abortReason(signal: AbortSignal, label: string): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(`${label} cancelled`, 'AbortError');
}

/**
 * Extract a human-readable message from the many error envelopes these APIs
 * use. Providers disagree on shape (`error.message`, `error` as a bare string,
 * `message`, `detail`, `code`, `task_status_msg`), so probe each in turn rather
 * than reporting the raw JSON body at the user.
 *
 * Always resolves to a message: `fallback` covers bodies that carry none of the
 * recognized fields, and an HTML error page, which is never useful to a user.
 */
export function providerErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return fallback;
    // Providers often answer errors with HTML; that is never a useful message.
    if (/^\s*<(!doctype|html)/i.test(trimmed)) return fallback;
    return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
  }
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail', 'task_status_msg', 'failure_reason', 'code']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().length > 400 ? `${value.trim().slice(0, 400)}…` : value.trim();
    }
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  // Mem0/Voyage style: `errors: [{ detail }]`.
  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const detail = (entry as Record<string, unknown> | null)?.detail;
      if (typeof detail === 'string' && detail.trim()) return detail.trim();
    }
  }
  return fallback;
}

/** HTTP status → Koryphaios error, preserving quota and rate-limit semantics. */
export function providerHttpError(
  provider: string,
  status: number,
  payload: unknown,
  retryAfterSeconds?: number,
): Error {
  const message = providerErrorMessage(payload, `${provider} returned HTTP ${status}`);
  if (status === 429) {
    const error = new ProviderRateLimitError(provider, retryAfterSeconds);
    error.message = `${provider} rate limited this request: ${message}`;
    return error;
  }
  if (status === 402 || status === 403) {
    // Billing and entitlement rejections are the user's to fix, not a
    // transient fault, so they surface as a 400 with the provider's wording.
    return new ValidationError(
      `${provider} rejected this request for billing or access reasons: ${message}`,
    );
  }
  return new ValidationError(message);
}

/**
 * Perform a capability request and parse the response.
 *
 * Returns `undefined` when the endpoint answered with an unusable body so
 * callers can raise a message naming the provider and model rather than leaking
 * a transport exception. Non-2xx always throws.
 */
export async function capabilityFetch(
  provider: string,
  url: string,
  config: ResolvedCapabilityConfig,
  options: CapabilityFetchOptions = {},
): Promise<{ response: Response; json?: unknown; text?: string; bytes?: Uint8Array }> {
  const { method = 'GET', headers = {}, json, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const signal = withTimeout(options.signal, timeoutMs, `${provider} request`);
  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...config.headers,
    ...headers,
  };
  const init: RequestInit = { method, headers: requestHeaders, signal };
  if (json !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err: unknown) {
    if (signal.aborted) throw abortReason(signal, `${provider} request`);
    throw new ValidationError(
      `${provider} could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    throw providerHttpError(
      provider,
      response.status,
      payload,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > MAX_CAPABILITY_RESPONSE_BYTES) {
    throw new ValidationError(
      `${provider} returned a ${contentLength}-byte response, above the supported limit.`,
    );
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

  // Binary media: hand back raw bytes so callers control decoding.
  if (/^(audio|video|application\/octet-stream|image\/)/.test(contentType)) {
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  const text = await response.text();
  if (!text.trim()) return { response, text: '' };
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new ValidationError(
      `${provider} returned an HTML page instead of an API response. Check the configured base URL.`,
    );
  }
  try {
    return { response, json: JSON.parse(text) as unknown, text };
  } catch {
    return { response, text };
  }
}

/** Read a JSON object field, ignoring non-string / null values. */
export function jsonString(source: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined;
}
