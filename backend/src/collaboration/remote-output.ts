import type { ProviderEvent } from '../providers/types';

/** Credentials are used locally by adapters, never part of the remote contract. */
export function configuredSecretValues(configs: Record<string, unknown>): string[] {
  const values = new Set<string>();
  function visit(value: unknown, secret = false) {
    if (typeof value === 'string' && secret && value.length >= 4) {
      values.add(value);
      values.add(encodeURIComponent(value));
      values.add(JSON.stringify(value).slice(1, -1));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        visit(child, secret || /key|token|secret|password|authorization|cookie|headers/i.test(key));
    }
  }
  for (const config of Object.values(configs)) visit(config);
  return [...values].sort((a, b) => b.length - a.length);
}

function redact(text: string, secrets: readonly string[], final = true): string {
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  for (const pattern of [
    /\bBearer\s+[^\s"'<>]+/gi,
    /\b(?:sk|xai|rk|gsk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g,
    /\bAIza[A-Za-z0-9_-]{20,}/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  ]) {
    text = text.replace(pattern, (match, offset: number, original: string) =>
      !final && offset + match.length === original.length ? match : '[redacted]',
    );
  }
  return text.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["'\s]*[:=]["'\s]*)[^\s,"'<>]+/gi,
    (match, prefix: string, offset: number, original: string) =>
      !final && offset + match.length === original.length ? match : `${prefix}[redacted]`,
  );
}

const PUBLIC_FIELDS = [
  'content',
  'thinking',
  'thinkingTokens',
  'toolCallId',
  'toolName',
  'toolInput',
  'tokensIn',
  'tokensOut',
  'tokensCache',
  'tokensCacheRead',
  'tokensCacheWrite',
  'estimated',
  'billingTokensIn',
  'billingTokensOut',
  'finishReason',
  'filePath',
  'fileContent',
  'fileOldContent',
  'fileOperation',
  'toolOutput',
  'isError',
] as const;
const STREAM_FIELDS = ['content', 'thinking', 'toolInput'] as const;

/** Whitelist protocol fields and hold text tails so split credential deltas
 * cannot evade redaction. Account IDs, raw config, headers and CLI auth commands
 * are never forwarded. Adapter error text remains host-local. */
export async function* protectRemoteEvents(
  source: AsyncIterable<ProviderEvent>,
  secrets: readonly string[],
): AsyncGenerator<ProviderEvent> {
  const tails = new Map<
    string,
    { event: ProviderEvent; field: (typeof STREAM_FIELDS)[number]; text: string }
  >();
  const hold = Math.max(512, ...secrets.map((value) => value.length));
  function flush(toolCallId?: string): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    for (const [key, tail] of tails) {
      if (toolCallId && tail.event.toolCallId !== toolCallId) continue;
      if (tail.text) events.push({ ...tail.event, [tail.field]: redact(tail.text, secrets) });
      tails.delete(key);
    }
    return events;
  }
  for await (const event of source) {
    if (event.type === 'cli_commands') continue;
    if (event.type === 'complete' || event.type === 'error') {
      for (const pending of flush()) yield pending;
    } else if (event.type === 'tool_use_stop') {
      for (const pending of flush(event.toolCallId)) yield pending;
    }
    const out: ProviderEvent = { type: event.type };
    for (const field of PUBLIC_FIELDS) {
      const value = event[field];
      if (value === undefined) continue;
      if (typeof value === 'string') (out as any)[field] = redact(value, secrets);
      else if (typeof value === 'number' || typeof value === 'boolean') (out as any)[field] = value;
    }
    if (event.type === 'error')
      out.error = 'Remote model failed. The host can check its provider diagnostics.';
    if (['content_delta', 'thinking_delta', 'tool_use_delta'].includes(event.type)) {
      for (const field of STREAM_FIELDS) {
        if (typeof event[field] !== 'string') continue;
        const key = `${event.type}:${event.toolCallId ?? ''}:${field}`;
        const text = (tails.get(key)?.text ?? '') + event[field];
        // Redact before splitting, so a credential spanning the output cut is
        // replaced as one unit; hold a tail before the next provider delta.
        const safe = redact(text, secrets, false);
        let cut = Math.max(0, safe.length - hold);
        // Token-shaped credentials can exceed the usual tail length. Hold the
        // entire unfinished token, not just its last 512 characters.
        const trailingCredential = safe.match(
          /\b(?:Bearer\s+[^\s"'<>]+|(?:sk|xai|rk|gsk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]*|AIza[A-Za-z0-9_-]*|eyJ[A-Za-z0-9_.-]*|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["'\s]*[:=]["'\s]*[^\s,"'<>]*)$/i,
        );
        if (trailingCredential?.index !== undefined) cut = Math.min(cut, trailingCredential.index);
        const privateKeyStart = safe.indexOf('-----BEGIN ');
        if (privateKeyStart >= 0 && safe.includes('PRIVATE KEY-----', privateKeyStart))
          cut = Math.min(cut, privateKeyStart);
        if (safe.length - cut > 64 * 1024)
          throw new Error('Remote output credential buffer exceeded');
        out[field] = safe.slice(0, cut);
        tails.set(key, {
          event: { type: event.type, ...(out.toolCallId && { toolCallId: out.toolCallId }) },
          field,
          text: safe.slice(cut),
        });
      }
      if (!STREAM_FIELDS.some((field) => out[field])) continue;
    }
    yield out;
  }
  for (const pending of flush()) yield pending;
}
