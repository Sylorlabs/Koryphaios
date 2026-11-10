#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { strictJson, validateAdjudication } from './reviewer-json';

// Stage-only independent reviewer adapter for an OpenAI-compatible endpoint.
// It forwards the sealed prompt unchanged and returns only the adjudication
// envelope the campaign expects. It asserts no OS isolation and no upstream
// identity; those remain coordinator responsibilities before ledger ingestion.
export const REVIEWER_MODEL = 'deepseek-v4.1-flash-1017';
export const REVIEWER_PROVIDER = 'logfare';
// The cap is a runaway guard, not a model limit. A native-runtime scenario carries its whole
// artifact diff, and angular-engineering's sealed prompt measures 282-285 KB, so a 256 KB cap
// refused dispatch with "exceeds the byte limit" and the skill could never earn a blind review.
// 512 KB still refuses a pathological payload while admitting the largest real assignment seen
// (284 KB); reviewer reasoning effort is pinned to "none" so a long prompt does not consume the
// completion budget (see the note below).
const MAX_REQUEST_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_BASE_URL = 'https://logfare.ai/v1';
const DEADLINE_MS = 150_000;
// Sealed assignments above roughly 20 KB make this model spend the whole
// completion budget on hidden reasoning and return finish_reason=length with an
// empty content field, so no adjudication is ever emitted. Measured on a 29 KB
// prompt at max_tokens 4096: default effort -> completion_tokens 4096,
// reasoning_tokens 4096, content empty. The same prompt at reasoning effort
// "none" -> finish_reason=stop, reasoning_tokens 0, complete JSON adjudication.
const REVIEWER_REASONING_EFFORT =
  process.env.KORY_LOGFARE_REASONING_EFFORT?.trim() || 'none';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let stage = 'startup';
const processStart = Date.now();
const startedAtGlobal = () => processStart;

export function reviewerWallClockDeadline(): number {
  return DEADLINE_MS;
}


function fail(message: string): never {
  throw new Error(message);
}

// Opt-in stage trace. It never prints prompt or payload bytes.
function trace(detail: string): void {
  if (process.env.KORY_LOGFARE_DEBUG === '1') process.stderr.write(`stage=${stage} ${detail}\n`);
}

function resolveApiKey(): string {
  const fromEnvironment = process.env.KORY_LOGFARE_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const configPath =
    process.env.KORY_LOGFARE_CONFIG?.trim() ||
    // The campaign runs this adapter from a private review directory, so the
    // project config is resolved from this module rather than the caller cwd.
    resolve(import.meta.dir, '..', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      provider?: { logfare?: { options?: { apiKey?: unknown } } };
    };
    const apiKey = config.provider?.logfare?.options?.apiKey;
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  } catch {
    // Fall through to the explicit failure below.
  }
  return fail('Logfare reviewer has no credential; refusing to dispatch.');
}

function resolveBaseUrl(): string {
  const value = process.env.KORY_LOGFARE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const url = new URL(value);
  if (url.protocol !== 'https:') fail('Logfare reviewer requires an https endpoint.');
  return url.href.replace(/\/$/u, '');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_REQUEST_BYTES)
      fail('Sealed review request exceeds the byte limit; no dispatch.');
    chunks.push(chunk as Buffer);
  }
  const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks),
  );
  if (!prompt.trim()) fail('Sealed review prompt is empty.');
  return prompt;
}

function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/u);
  return fenced ? fenced[1].trim() : trimmed;
}

async function requestCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ body: string; content: string; responseModel: string | null }> {
  // A gateway can occasionally return an empty content field for an otherwise
  // healthy request. Retry those bounded, and never retry a real adjudication.
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let lastEmpty = false;
  let lastFailure = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remaining = DEADLINE_MS - (Date.now() - startedAtGlobal());
    if (remaining <= 1000) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response | undefined;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 4096,
          reasoning_effort: REVIEWER_REASONING_EFFORT,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (error) {
      lastFailure =
        error instanceof Error && error.name === 'AbortError'
          ? 'request deadline exceeded'
          : 'network request failed';
      trace(`transport attempt=${String(attempt)} failure=${lastFailure}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response) {
      if (attempt < 3) await pause(Math.min(2_000, attempt * 750));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      // A gateway can return a transient 429/5xx for a healthy sealed prompt.
      lastFailure = `status ${String(response.status)}`;
      trace(`retryable attempt=${String(attempt)} ${lastFailure}`);
      if (attempt < 3) await pause(Math.min(2_000, attempt * 750));
      continue;
    }
    if (!response.ok) fail(`Logfare reviewer returned status ${response.status}.`);
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      fail('Reviewer response exceeded the byte limit.');
    }
    const parsed = JSON.parse(body) as {
      model?: string;
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
    };
    stage = 'read-response';
    trace(`httpStatus=${response.status} finish=${parsed.choices?.[0]?.finish_reason ?? 'none'}`);
    const message = parsed.choices?.[0]?.message as { content?: unknown } | undefined;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (content) return { body, content, responseModel: parsed.model ?? null };
    lastEmpty = true;
    trace('empty-content attempt=' + String(attempt));
  }
  return fail(
    lastEmpty
      ? 'Reviewer returned no message content.'
      : lastFailure
        ? `Reviewer request failed after retries: ${lastFailure}.`
        : 'Reviewer exceeded its deadline.',
  );
}

// This route's model emits an adjudication that repeats keys inside an artifact
// object: a second "evidence" array, or a trailing "quality"/"verification" pair
// after the evidence array. Measured on four captured samples, the repeated
// scalar values are identical and the repeated arrays differ only in being a
// shorter restatement, so the first occurrence is the substantive one. Keep the
// first occurrence, reject any duplicate whose scalar value disagrees, and hand
// the rebuilt JSON to the strict grammar so nothing else is relaxed.
function normalizeDuplicateKeys(text: string): string {
  let index = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[index] ?? '\0')) index += 1;
  };
  const readString = (): string => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/u.exec(
      text.slice(index),
    );
    if (!match) throw new Error('Invalid reviewer JSON (details redacted).');
    index += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const readValue = (depth: number): string => {
    if (depth > 20) throw new Error('Invalid reviewer JSON (details redacted).');
    whitespace();
    const token = text[index];
    const start = index;
    if (token === '"') {
      readString();
      return text.slice(start, index);
    }
    if (token === '{') {
      index += 1;
      const seen = new Map<string, string>();
      const fields: string[] = [];
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return '{}';
      }
      while (true) {
        whitespace();
        const key = readString();
        whitespace();
        if (text[index++] !== ':') throw new Error('Invalid reviewer JSON (details redacted).');
        const value = readValue(depth + 1);
        const previous = seen.get(key);
        if (previous === undefined) {
          seen.set(key, value);
          fields.push(`${JSON.stringify(key)}:${value}`);
        } else if (previous !== value && !(previous.startsWith('[') && value.startsWith('['))) {
          throw new Error('Invalid reviewer JSON (details redacted).');
        }
        whitespace();
        const separator = text[index++];
        if (separator === '}') return `{${fields.join(',')}}`;
        if (separator !== ',') throw new Error('Invalid reviewer JSON (details redacted).');
      }
    }
    if (token === '[') {
      index += 1;
      const items: string[] = [];
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return '[]';
      }
      while (true) {
        items.push(readValue(depth + 1));
        whitespace();
        const separator = text[index++];
        if (separator === ']') return `[${items.join(',')}]`;
        if (separator !== ',') throw new Error('Invalid reviewer JSON (details redacted).');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      text.slice(index),
    );
    if (!literal) throw new Error('Invalid reviewer JSON (details redacted).');
    index += literal[0].length;
    return literal[0];
  };
  const candidateStart = text.indexOf('{');
  const candidateEnd = text.lastIndexOf('}');
  if (candidateStart < 0 || candidateEnd <= candidateStart) {
    throw new Error('Invalid reviewer JSON (details redacted).');
  }
  index = candidateStart;
  const normalized = readValue(0);
  whitespace();
  if (index !== candidateEnd + 1) throw new Error('Invalid reviewer JSON (details redacted).');
  return normalized;
}

async function main(): Promise<void> {
  const prompt = await readStdin();
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();
  const model = process.env.KORY_LOGFARE_REVIEWER_MODEL?.trim() || REVIEWER_MODEL;
  const reviewerId = `logfare-stateless-${randomUUID()}`;

  const { body, content, responseModel } = await requestCompletion(baseUrl, apiKey, model, prompt);

  stage = 'parse-adjudication';
  let output = stripWrappingFence(content);
  try {
    output = normalizeDuplicateKeys(output);
    strictJson(output);
    validateAdjudication(output);
  } catch (error) {
    trace(`outputChars=${output.length} ${error instanceof Error ? error.message : 'invalid'}`);
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        reviewerId,
        completed: true,
        output,
        events: [
          { type: 'review.started', reviewerId },
          { type: 'review.completed', reviewerId, outputSha256: hash(output) },
        ],
        hostReceipt: {
          schemaVersion: 1,
          stageOnly: true,
          identitySource: 'host-invocation-uuid',
          upstreamSessionObserved: true,
          requestedModel: model,
          responseModel,
          promptSha256: hash(prompt),
          requestBytes: Buffer.byteLength(prompt, 'utf8'),
          responseSha256: hash(body),
          outputSha256: hash(output),
          elapsedMs: Date.now() - processStart,
          osIsolationVerified: false,
          upstreamIdentityVerified: false,
          signed: false,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  // Prompts and model payloads may contain private artifact data.
  if (process.env.KORY_LOGFARE_DEBUG === '1') {
    process.stderr.write(
      `stage=${stage} failure=${error instanceof Error ? error.message : 'unknown'}\n`,
    );
  }
  process.stderr.write(
    'kory-logfare-stateless-reviewer: failed; diagnostics redacted. No completed review emitted.\n',
  );
  process.exitCode = 1;
});
