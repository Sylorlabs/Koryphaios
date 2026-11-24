import { createHmac, randomBytes } from 'node:crypto';
import { getCliAdapterCompatibility, type CliAdapterCompatibility } from './cli-compatibility';
import type { ProviderEvent } from './types';

export type ProviderDiagnosticSource =
  'http' | 'sdk' | 'stderr' | 'stdout' | 'spawn' | 'stream' | 'configuration';

export type ProviderDiagnosticCategory =
  | 'authentication'
  | 'rate_limit'
  | 'usage_limit'
  | 'timeout'
  | 'network'
  | 'permission'
  | 'context_limit'
  | 'invalid_request'
  | 'cancelled'
  | 'unavailable'
  | 'provider_failure';

export interface SafeCliCompatibilityDiagnostic extends CliAdapterCompatibility {
  /** No executable, filesystem or upstream error text is used to infer a version. */
  installedVersion: 'unknown';
  evidenceBoundary: string;
}

export interface SafeProviderDiagnostic {
  provider: string;
  source: ProviderDiagnosticSource;
  category: ProviderDiagnosticCategory;
  diagnosticBytes: number;
  diagnosticHash: string;
  status?: number;
  code?: string;
  errorName?: string;
  exitCode?: number;
  /** Sanitized, secret-redacted upstream reason. Bounded in length so it is
   *  safe to log, persist, and show to the user. */
  upstreamDetail?: string;
  /** The provider's own verdict that this failure is worth retrying, computed
   *  from the RAW error before `upstreamDetail` was redacted and truncated.
   *  Consumers must read this instead of re-matching `upstreamDetail`: a long
   *  gateway body can push the decisive token past the display bound. */
  transient?: boolean;
  /** Offline adapter context for existing structured diagnostic consumers.
   * This does not assert that incompatibility caused the current failure. */
  cliCompatibility?: SafeCliCompatibilityDiagnostic;
}

const MAX_CAPTURED_DIAGNOSTIC_BYTES = 64 * 1024;
const DIAGNOSTIC_FINGERPRINT_KEY = randomBytes(32);

const UPSTREAM_DETAIL_MAX_CHARS = 220;
/** Secret-looking substrings (API keys, bearer tokens, key=value pairs). */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|xai|rk|gsk|co|ghp|gho|github_pat|AIza)[-_][A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\b(?:api[_-]?key|access[_-]?token|authorization)["'=:\s]+\S+/gi,
];

/**
 * Human-readable, secret-redacted upstream reason extracted from an error.
 * OpenAI SDK `APIError.message` already embeds the provider's response body,
 * so this recovers the actual rejection cause ("Model not found",
 * "reasoning_effort is not supported", …) instead of the opaque category text.
 */
export function safeUpstreamDetail(value: unknown, maxChars = UPSTREAM_DETAIL_MAX_CHARS): string {
  let text = rawDiagnosticText(value);
  // This is SDK-generated fallback text, not a statement from the provider.
  if (/^(?:[a-z]*Error:)?\d{3} status code \(no body\)$/i.test(text.trim())) return '';
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function rawDiagnosticText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const cause = value.cause instanceof Error ? value.cause.message : '';
    return cause ? `${value.name}:${value.message}:${cause}` : `${value.name}:${value.message}`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nestedError =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : undefined;
    const nestedNestedError =
      nestedError?.error && typeof nestedError.error === 'object'
        ? (nestedError.error as Record<string, unknown>)
        : undefined;
    const parts = [
      record.name,
      record.message,
      typeof record.error === 'string' ? record.error : undefined,
      nestedError?.message,
      typeof nestedError?.error === 'string' ? nestedError.error : undefined,
      nestedNestedError?.message,
      record.type,
      record.code,
    ]
      .filter((part): part is string => typeof part === 'string')
      .slice(0, 8);
    return parts.join(':');
  }
  return value === undefined || value === null ? '' : String(value);
}

function statusFrom(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : undefined;
  const status = record.status ?? record.statusCode ?? nested?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function safeCodeFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : undefined;
  const code = record.code ?? nested?.code ?? nested?.type;
  if (typeof code !== 'string' || !/^[a-z0-9_.:-]{1,64}$/i.test(code)) return undefined;
  return code;
}

function safeNameFrom(value: unknown): string | undefined {
  const name =
    value instanceof Error
      ? value.name
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>).name
        : undefined;
  if (typeof name !== 'string') return undefined;
  if (!name || !/^[a-z][a-z0-9_.:-]{0,63}$/i.test(name)) return undefined;
  return name;
}

/**
 * True when a provider rejection means the request did not fit the model
 * route's context window — including proxy-style 413 envelopes such as
 * conduit's `invalid_request_error: "The request exceeds this model route
 * context limit. Reduce the request or select a model with a larger verified
 * context window."` The manager uses this to auto-shrink (skills, memory,
 * tools, history) and retry without surfacing the raw dump to the user.
 */
export function isContextLimitText(text: string, status?: number): boolean {
  const lower = text.toLowerCase();
  if (status === 413) return true;
  if (
    lower.includes('context_length_exceeded') ||
    lower.includes('context_window_exceeded') ||
    lower.includes('context limit') ||
    (lower.includes('context window') && lower.includes('exceed')) ||
    lower.includes('model route context') ||
    lower.includes('verified context window') ||
    lower.includes('maximum context') ||
    lower.includes('exceeds this model') ||
    lower.includes('reduce the request') ||
    lower.includes('larger verified context') ||
    lower.includes('larger-context model') ||
    lower.includes('prompt is too long') ||
    lower.includes('too many tokens') ||
    lower.includes('token limit') ||
    lower.includes('input is too long') ||
    lower.includes('request too large')
  )
    return true;
  return false;
}

/** Detect a context-limit failure from an already-formatted provider error message. */
export function isContextLimitFailureMessage(message: unknown): boolean {
  if (typeof message !== 'string' || !message) return false;
  return isContextLimitText(message);
}

/**
 * Typed error frames that upstream classifies as server-side and retryable.
 * Only the "try again" names appear here: `authentication_error`,
 * `permission_error`, `not_found_error`, and `invalid_request_error` stay out so
 * the fail-closed categories stay fail-closed, and the caller's auth guard still
 * runs first for gateways that wrap an auth failure in an `api_error` envelope.
 */
const TRANSIENT_STREAM_ERROR_TYPES = [
  'api_error',
  'overloaded_error',
  'internal_server_error',
  'service_unavailable',
  'timeout_error',
];

/**
 * Prose a gateway uses to reject the request payload itself, often on an
 * already-open stream where there is no HTTP status to classify against ("200
 * OK" followed by `{"error":{"message":"Error:The request is invalid. Please
 * check the parameters."}}`). Without these, such a rejection fell through to
 * "request failed — retry or inspect provider status", which sends the user to
 * Settings for a problem that is neither transient nor configuration-shaped.
 */
const INVALID_REQUEST_PHRASES = [
  'request is invalid',
  'invalid_request_error',
  'invalid request',
  'could not be processed',
  'cannot be processed',
  'check the parameters',
  'invalid parameter',
  'malformed request',
  'bad request',
  'unsupported parameter',
];

/** Untyped prose gateways use for the same server-side condition. */
const TRANSIENT_STREAM_ERROR_PHRASES = [
  'service interruption',
  'temporary service',
  'internal error',
  'temporarily unavailable',
  'briefly unavailable',
  'temporarily down',
  'temporary upstream service error',
  'please try again later',
  'please retry in a moment',
  'try this request again',
];

/**
 * Credential wording that must stay fail-closed even when it arrives wrapped in
 * a retryable-looking envelope. Deliberately narrower than the registry's own
 * guard in `isRetriableProviderError`: this matcher runs on its own to set
 * `ProviderEvent.errorTransient` at the provider boundary, so it must never be
 * the thing that widens retry coverage. Gateway prose that merely mentions a
 * key ("check your API key settings") is excluded by requiring the
 * credential noun to be the failure, not by listing bare words.
 */
const TRANSIENT_CREDENTIAL_MARKERS = [
  'authentication_error',
  'invalid_api_key',
  'invalid api key',
  'invalid x-api-key',
  'unauthorized',
  'unauthenticated',
  'permission_error',
  'permission denied',
  'access denied',
  'forbidden',
  'credentials',
  'api key is invalid',
  'token expired',
  'expired token',
  'invalid token',
  'login required',
  'not logged in',
  'not signed in',
];

/**
 * Hard account/model usage caps ("usage limit reached", "quota exceeded",
 * "insufficient credits", "out of credits"). These are NOT transient: retrying
 * the same model cannot help and the user must switch model/provider or wait
 * for the limit to reset. Matching this must win over generic transient
 * phrasing — providers wrap caps in 500-class text like "Internal error: Free
 * usage limit reached…" (observed live from OpenCode).
 */
export const USAGE_LIMIT_TEXT =
  /usage limit (?:reached|exceeded)|quota (?:reached|exceeded)|insufficient (?:credits|quota|balance)|out of credits/i;

/**
 * True when a failure is a transient upstream condition worth retrying the same
 * turn. Covers the case a status-based check cannot see: an `error` frame that
 * arrives on an already-open SSE stream. Anthropic's SDK throws
 * `APIError.generate(undefined, 'SSE Error: …')` for those, so `status` is
 * `undefined` and a genuine 500-class `api_error` ("Temporary service
 * interruption…") would otherwise fail the turn on the first blip with no retry
 * and no fallback. Fail-closed on credential wording, and deliberately NOT
 * routed through `isContextLimitText` — a route-limit rejection is not
 * retryable without shrinking the prompt.
 */
export function isTransientStreamErrorText(value: unknown, status?: number): boolean {
  const text = rawDiagnosticText(value).toLowerCase();
  if (text && USAGE_LIMIT_TEXT.test(text)) return false;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (!text) return false;
  if (TRANSIENT_CREDENTIAL_MARKERS.some((marker) => text.includes(marker))) return false;
  return (
    TRANSIENT_STREAM_ERROR_TYPES.some((marker) => text.includes(marker)) ||
    TRANSIENT_STREAM_ERROR_PHRASES.some((marker) => text.includes(marker))
  );
}

export interface ProviderStreamFailure {
  /** Ready-to-yield error event. `errorTransient` is computed from the raw
   *  value, never from the bounded display detail. */
  event: ProviderEvent;
  /** The same diagnostic the event was built from, for structured logging. */
  diagnostic: SafeProviderDiagnostic;
}

/**
 * Build the error event for a provider failure so no call site can forget the
 * transient flag. Keeps the retry decision at the boundary where the raw error
 * is still in hand: the `upstreamDetail` carried to the user is secret-redacted
 * and length-bounded, so classifying from it would silently lose the signal on
 * long gateway bodies.
 */
export function providerStreamFailure(
  provider: string,
  source: ProviderDiagnosticSource,
  value: unknown,
  options: { status?: number; exitCode?: number; message?: string } = {},
): ProviderStreamFailure {
  const diagnostic = safeProviderDiagnostic(provider, source, value, options);
  return {
    event: {
      type: 'error',
      error: options.message ?? safeProviderFailureMessage(provider, diagnostic),
      errorTransient: isTransientStreamErrorText(value, options.status ?? diagnostic.status),
    },
    diagnostic,
  };
}

/**
 * Final banner for a provider whose retry budget ran out on a transient
 * failure. Keeps the provider's own reason — it is the only actionable part —
 * and states how many attempts were made, so a blip is never presented as a
 * broken configuration.
 */
export function transientExhaustedMessage(message: string, attempts: number): string {
  const total = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  const reason = message.trim();
  const tail = `Koryphaios retried this turn ${total} ${total === 1 ? 'attempt' : 'attempts'} without success — the provider kept interrupting the request. Retry the turn, or pick another provider if it persists.`;
  return reason ? `${reason} ${tail}` : tail;
}

export function classifyProviderDiagnostic(
  value: unknown,
  status = statusFrom(value),
): ProviderDiagnosticCategory {
  const text = rawDiagnosticText(value).toLowerCase();
  if (isContextLimitText(text, status)) return 'context_limit';
  if (
    status === 401 ||
    /\b(?:unauthori[sz]ed|not logged in|not signed in|authentication|authenticate|invalid api key|login required)\b/.test(
      text,
    )
  )
    return 'authentication';
  if (USAGE_LIMIT_TEXT.test(text)) return 'usage_limit';
  if (status === 429 || /\b(?:rate limit|too many requests|quota exceeded)\b/.test(text))
    return 'rate_limit';
  if (status === 408 || /\b(?:timed? out|timeout|deadline exceeded)\b/.test(text)) return 'timeout';
  if (/\b(?:aborterror|aborted|cancelled|canceled)\b/.test(text)) return 'cancelled';
  if (status === 403 || /\b(?:forbidden|permission denied|access denied)\b/.test(text))
    return 'permission';
  if (status === 400 || status === 404 || status === 409 || status === 422)
    return 'invalid_request';
  if (INVALID_REQUEST_PHRASES.some((phrase) => text.includes(phrase))) return 'invalid_request';
  if (
    /\b(?:econnrefused|econnreset|enotfound|network|socket|dns|connection refused|fetch failed)\b/.test(
      text,
    )
  )
    return 'network';
  if (/\b(?:enoent|not found|unavailable|failed to launch|spawn)\b/.test(text))
    return 'unavailable';
  return 'provider_failure';
}

export function safeProviderDiagnostic(
  provider: string,
  source: ProviderDiagnosticSource,
  value: unknown,
  options: { status?: number; exitCode?: number } = {},
): SafeProviderDiagnostic {
  const text = rawDiagnosticText(value);
  const status = options.status ?? statusFrom(value);
  const upstreamDetail = safeUpstreamDetail(value);
  const compatibility = getCliAdapterCompatibility(provider);
  const transient = isTransientStreamErrorText(value, status);
  return {
    provider,
    source,
    category: classifyProviderDiagnostic(value, status),
    transient,
    diagnosticBytes: Buffer.byteLength(text, 'utf8'),
    diagnosticHash: createHmac('sha256', DIAGNOSTIC_FINGERPRINT_KEY)
      .update(text)
      .digest('hex')
      .slice(0, 16),
    ...(status !== undefined ? { status } : {}),
    ...(safeCodeFrom(value) ? { code: safeCodeFrom(value) } : {}),
    ...(safeNameFrom(value) ? { errorName: safeNameFrom(value) } : {}),
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    ...(upstreamDetail ? { upstreamDetail } : {}),
    ...(compatibility
      ? {
          cliCompatibility: {
            ...compatibility,
            installedVersion: 'unknown' as const,
            evidenceBoundary:
              'Offline source contracts and local tests only; no live support is established. ' +
              'Revalidation items are review guidance, not proof that incompatibility caused this failure.',
            // Diagnostic consumers may decorate or serialize these records. Never
            // expose shared catalog objects that could corrupt later diagnostics.
            versionBoundary: { ...compatibility.versionBoundary },
            evidence: compatibility.evidence.map((item) => ({ ...item })),
            revalidate: [...compatibility.revalidate],
          },
        }
      : {}),
  };
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    antigravity: 'Antigravity',
    anthropic: 'Anthropic',
    claude: 'Claude Code',
    cline: 'Cline',
    codex: 'Codex CLI',
    beam: 'Reflection AI',
    copilot: 'GitHub Copilot',
    cursor: 'Cursor',
    devin: 'Devin',
    grok: 'Grok Build',
    opencode: 'OpenCode',
    codebuddy: 'CodeBuddy',
    openai: 'OpenAI',
    xai: 'xAI',
    gwarden: 'Gwarden AI',
    nvidia: 'NVIDIA',
    moonshot: 'Moonshot',
    deepseek: 'DeepSeek',
    groq: 'Groq',
    togetherai: 'Together AI',
    zai: 'Z.ai',
    workbuddy: 'WorkBuddy',
    'workbuddy-desktop': 'WorkBuddy Desktop',
  };
  return labels[provider] ?? provider;
}

/**
 * Append the provider's own redacted reason. The detail is already
 * secret-scrubbed and length-bounded by `safeUpstreamDetail`, and it is
 * frequently the only actionable part of the failure: an account with no API
 * entitlement, a key scoped to the wrong project, and a plan that excludes a
 * model all arrive as the same bare 403, and "check your permission settings"
 * is unactionable without it. Deliberately NOT used for `context_limit`, where
 * the manager shrinks and retries silently and must not surface the raw dump.
 */
function withUpstreamDetail(message: string, diagnostic: SafeProviderDiagnostic): string {
  return diagnostic.upstreamDetail
    ? `${message} — provider said: "${diagnostic.upstreamDetail}"`
    : message;
}

export function safeProviderFailureMessage(
  provider: string,
  diagnostic: SafeProviderDiagnostic,
  options: { authenticationAction?: string } = {},
): string {
  const label = providerLabel(provider);
  switch (diagnostic.category) {
    case 'context_limit':
      return `${label} reported the request exceeds its context limit. Koryphaios shrinks skills, memory, tools, and history automatically and retries; if this persists, choose a larger-context model or shorten the latest input.`;
    case 'authentication':
      return withUpstreamDetail(
        `${label} authentication failed${diagnostic.status ? ` (HTTP ${diagnostic.status})` : ''}.${options.authenticationAction ? ` ${options.authenticationAction}` : ' Reconnect the provider and retry.'}`,
        diagnostic,
      );
    case 'rate_limit':
      return withUpstreamDetail(
        `${label} rate limit or quota was reached. Retry later or choose another provider.`,
        diagnostic,
      );
    case 'usage_limit': {
      const detail = diagnostic.upstreamDetail?.slice(0, 200);
      return `${label} reports a usage limit for this model${detail ? `: "${detail}"` : ''}. Pick another model or provider, or wait for the limit to reset.`;
    }
    case 'timeout':
      return withUpstreamDetail(
        `${label} did not respond before the request timed out.`,
        diagnostic,
      );
    case 'network':
      return withUpstreamDetail(
        `${label} could not be reached. Check the connection and retry.`,
        diagnostic,
      );
    case 'permission':
      return withUpstreamDetail(
        `${label} denied this request. Check the provider account and permission settings.`,
        diagnostic,
      );
    case 'invalid_request':
      return withUpstreamDetail(
        `${label} rejected the request. Check the selected model and provider settings.`,
        diagnostic,
      );
    case 'cancelled':
      return withUpstreamDetail(`${label} request was cancelled.`, diagnostic);
    case 'unavailable':
      return withUpstreamDetail(`${label} is unavailable or failed to start.`, diagnostic);
    default:
      if (diagnostic.transient) {
        // A server-side blip the registry already retried: send the user back to
        // the turn, not to Settings, and never imply their configuration is
        // wrong. The verdict comes from the raw failure, so a redacted or
        // truncated detail clause cannot hide it.
        return withUpstreamDetail(
          `${label} hit a temporary upstream service error. Retry the turn, or pick another provider if it persists.`,
          diagnostic,
        );
      }
      return withUpstreamDetail(
        `${label} request failed. Retry or inspect provider status in Settings.`,
        diagnostic,
      );
  }
}

/** Bound untrusted subprocess diagnostics in memory. The returned value must
 * only be classified/hashed, never logged, persisted, or sent to clients. */
export function appendPrivateDiagnostic(current: string, chunk: unknown): string {
  if (Buffer.byteLength(current, 'utf8') >= MAX_CAPTURED_DIAGNOSTIC_BYTES) return current;
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  const available = MAX_CAPTURED_DIAGNOSTIC_BYTES - Buffer.byteLength(current, 'utf8');
  if (available <= 0) return current;
  return current + Buffer.from(text, 'utf8').subarray(0, available).toString('utf8');
}
