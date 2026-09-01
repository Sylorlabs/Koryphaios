import { createHmac, randomBytes } from 'node:crypto';

export type ProviderDiagnosticSource =
  | 'http'
  | 'sdk'
  | 'stderr'
  | 'stdout'
  | 'spawn'
  | 'stream'
  | 'configuration';

export type ProviderDiagnosticCategory =
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'permission'
  | 'invalid_request'
  | 'cancelled'
  | 'unavailable'
  | 'provider_failure';

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
   * safe to log, persist, and show to the user. */
  upstreamDetail?: string;
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
    const parts = [record.name, record.message, record.error, record.type, record.code]
      .filter((part): part is string => typeof part === 'string')
      .slice(0, 6);
    return parts.join(':');
  }
  return value === undefined || value === null ? '' : String(value);
}

function statusFrom(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>)
    : undefined;
  const status = record.status ?? record.statusCode ?? nested?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function safeCodeFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>)
    : undefined;
  const code = record.code ?? nested?.code ?? nested?.type;
  if (typeof code !== 'string' || !/^[a-z0-9_.:-]{1,64}$/i.test(code)) return undefined;
  return code;
}

function safeNameFrom(value: unknown): string | undefined {
  const name = value instanceof Error
    ? value.name
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).name
      : undefined;
  if (typeof name !== 'string') return undefined;
  if (!name || !/^[a-z][a-z0-9_.:-]{0,63}$/i.test(name)) return undefined;
  return name;
}

export function classifyProviderDiagnostic(
  value: unknown,
  status = statusFrom(value),
): ProviderDiagnosticCategory {
  const text = rawDiagnosticText(value).toLowerCase();
  if (
    status === 401 ||
    /\b(?:unauthori[sz]ed|not logged in|not signed in|authentication|authenticate|invalid api key|login required)\b/.test(
      text,
    )
  )
    return 'authentication';
  if (status === 429 || /\b(?:rate limit|too many requests|quota exceeded)\b/.test(text))
    return 'rate_limit';
  if (status === 408 || /\b(?:timed? out|timeout|deadline exceeded)\b/.test(text)) return 'timeout';
  if (/\b(?:aborterror|aborted|cancelled|canceled)\b/.test(text)) return 'cancelled';
  if (status === 403 || /\b(?:forbidden|permission denied|access denied)\b/.test(text))
    return 'permission';
  if (status === 400 || status === 404 || status === 409 || status === 422)
    return 'invalid_request';
  if (
    /\b(?:econnrefused|econnreset|enotfound|network|socket|dns|connection refused|fetch failed)\b/.test(
      text,
    )
  )
    return 'network';
  if (/\b(?:enoent|not found|unavailable|failed to launch|spawn)\b/.test(text)) return 'unavailable';
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
  return {
    provider,
    source,
    category: classifyProviderDiagnostic(value, status),
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
  };
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    antigravity: 'Antigravity',
    anthropic: 'Anthropic',
    claude: 'Claude Code',
    cline: 'Cline',
    codex: 'Codex CLI',
    copilot: 'GitHub Copilot',
    cursor: 'Cursor',
    devin: 'Devin',
    grok: 'Grok Build',
    openai: 'OpenAI',
    xai: 'xAI',
    nvidia: 'NVIDIA',
    moonshot: 'Moonshot',
    deepseek: 'DeepSeek',
    groq: 'Groq',
    togetherai: 'Together AI',
    zai: 'Z.ai',
  };
  return labels[provider] ?? provider;
}

export function safeProviderFailureMessage(
  provider: string,
  diagnostic: SafeProviderDiagnostic,
  options: { authenticationAction?: string } = {},
): string {
  const label = providerLabel(provider);
  switch (diagnostic.category) {
    case 'authentication':
      return `${label} authentication failed.${options.authenticationAction ? ` ${options.authenticationAction}` : ' Reconnect the provider and retry.'}`;
    case 'rate_limit':
      return `${label} rate limit or quota was reached. Retry later or choose another provider.`;
    case 'timeout':
      return `${label} did not respond before the request timed out.`;
    case 'network':
      return `${label} could not be reached. Check the connection and retry.`;
    case 'permission':
      return `${label} denied this request. Check the provider account and permission settings.`;
    case 'invalid_request':
      return `${label} rejected the request. Check the selected model and provider settings.${diagnostic.upstreamDetail ? ` — provider said: "${diagnostic.upstreamDetail}"` : ''}`;
    case 'cancelled':
      return `${label} request was cancelled.`;
    case 'unavailable':
      return `${label} is unavailable or failed to start.`;
    default:
      return `${label} request failed. Retry or inspect provider status in Settings.${diagnostic.upstreamDetail ? ` — provider said: "${diagnostic.upstreamDetail}"` : ''}`;
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
