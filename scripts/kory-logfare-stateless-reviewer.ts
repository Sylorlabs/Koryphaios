#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { normalizeDuplicateKeys, strictJson, validateAdjudication } from './reviewer-json';

// Stage-only independent reviewer adapter for an OpenAI-compatible endpoint.
// It forwards the sealed prompt unchanged and returns only the adjudication
// envelope the campaign expects. It asserts no OS isolation and no upstream
// identity; those remain coordinator responsibilities before ledger ingestion.
// The reviewer must not be the candidate. Candidate arms run on the pinned deepseek
// model, so adjudication runs on glm-5.3: a reviewer sharing the candidate's weights
// can reward its own characteristic style instead of the behaviour under test.
export const REVIEWER_MODEL = process.env.KORY_LOGFARE_REVIEWER_MODEL?.trim() || 'glm-5.3';
// Provider-neutral: the adapter speaks the OpenAI shape, so the operator's endpoint and
// label are configuration, never a hardcoded channel name.
export const REVIEWER_PROVIDER = process.env.KORY_REVIEWER_PROVIDER?.trim() || 'logfare';
// The cap is a runaway guard, not a model limit. A native-runtime scenario carries its whole
// artifact diff, and angular-engineering's sealed prompt measures 282-285 KB, so a 256 KB cap
// refused dispatch with "exceeds the byte limit" and the skill could never earn a blind review.
// 512 KB still refuses a pathological payload while admitting the largest real assignment seen
// (284 KB); reviewer reasoning effort is pinned to "none" so a long prompt does not consume the
// completion budget (see the note below).
const MAX_REQUEST_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_BASE_URL = process.env.KORY_REVIEWER_BASE_URL?.trim() || 'https://logfare.ai/v1';
// A sealed assignment can be a full source tree, and a free or slower endpoint needs longer
// than the metered default to answer one. Operators raise it per run; the shape is unchanged.
const DEADLINE_MS =
  Number(process.env.KORY_REVIEWER_DEADLINE_MS ?? process.env.KORY_LOGFARE_DEADLINE_MS ?? '') ||
  420_000;
// Sealed assignments above roughly 20 KB make this model spend the whole
// completion budget on hidden reasoning and return finish_reason=length with an
// empty content field, so no adjudication is ever emitted. Measured on a 29 KB
// prompt at max_tokens 4096: default effort -> completion_tokens 4096,
// reasoning_tokens 4096, content empty. The same prompt at reasoning effort
// "none" -> finish_reason=stop, reasoning_tokens 0, complete JSON adjudication.
// Some endpoints bill a reasoning hint as a separate, paid classification and answer
// `402 insufficient credits` for a free model. `omit` drops the field entirely; a provider
// that accepts the hint keeps the measured default.
const REVIEWER_REASONING_EFFORT =
  process.env.KORY_REVIEWER_REASONING_EFFORT?.trim() ||
  process.env.KORY_LOGFARE_REASONING_EFFORT?.trim() ||
  'none';
// No artificial completion cap. A sealed assignment carries both candidate
// artifacts, so a fixed ceiling truncated real adjudications as
// finish_reason=length with empty content: the reviewer spent the whole budget
// and returned nothing. An operator may still pin a value, but the default is to
// send no max_tokens at all and let the provider apply its own model limit.
const REVIEWER_MAX_TOKENS = (() => {
  const raw = Number(process.env.KORY_LOGFARE_REVIEWER_MAX_TOKENS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : null;
})();

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
  const explicit = process.env.KORY_REVIEWER_API_KEY?.trim();
  if (explicit) return explicit;
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
  return fail(`${REVIEWER_PROVIDER} reviewer has no credential; refusing to dispatch.`);
}

function resolveBaseUrl(): string {
  const value = process.env.KORY_LOGFARE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const url = new URL(value);
  if (url.protocol !== 'https:') fail(`${REVIEWER_PROVIDER} reviewer requires an https endpoint.`);
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
          ...(REVIEWER_MAX_TOKENS === null ? {} : { max_tokens: REVIEWER_MAX_TOKENS }),
          ...(REVIEWER_REASONING_EFFORT === 'omit'
            ? {}
            : { reasoning_effort: REVIEWER_REASONING_EFFORT }),
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

async function main(): Promise<void> {
  const prompt = await readStdin();
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();
  const model = process.env.KORY_LOGFARE_REVIEWER_MODEL?.trim() || REVIEWER_MODEL;
  const reviewerId = `logfare-stateless-${randomUUID()}`;

  // A gateway roll occasionally emits an adjudication that is not the strict
  // grammar: prose wrapped around the JSON, a repeated key with a contradicting
  // value, a truncated object. Retrying a malformed answer is a retry of the
  // measurement, never an acceptance: an answer that still fails the strict
  // grammar after the bounded attempts is a reviewer failure.
  let body = '';
  let output = '';
  let responseModel: string | null = null;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (DEADLINE_MS - (Date.now() - processStart) <= 1000) break;
    const completion = await requestCompletion(baseUrl, apiKey, model, prompt);
    body = completion.body;
    responseModel = completion.responseModel;
    stage = 'parse-adjudication';
    const candidate = stripWrappingFence(completion.content);
    try {
      const normalized = normalizeDuplicateKeys(candidate);
      strictJson(normalized);
      validateAdjudication(normalized);
      output = normalized;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Invalid reviewer JSON');
      trace(`outputChars=${candidate.length} attempt=${String(attempt)} ${lastError.message}`);
      if (attempt === 3) throw lastError;
    }
  }
  if (!output) throw lastError ?? new Error('Reviewer produced no adjudication.');

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
