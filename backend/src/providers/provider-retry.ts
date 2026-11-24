/**
 * Provider retry policy and the retrying collector for provider calls that sit
 * outside `ProviderRegistry.executeWithRetry`.
 *
 * Two kinds of caller use this:
 *   - the registry, for the main chat turn (it owns the fallback chain and the
 *     carried tool ledger, so it keeps its own inline retry loop and asks this
 *     module only for the retry *decision* and the backoff), and
 *   - auxiliary Kory calls — compaction, titles, plan parsing, inquiry routing,
 *     relay decisions, the Settings connection probe — which invoke
 *     `provider.streamResponse` directly. Those used to have no retry at all, so
 *     a single upstream blip silently degraded a feature (empty allowed-path
 *     list, missing title) or failed a compaction outright.
 *
 * Kept in its own module so the policy has one home: `provider-diagnostics`
 * cannot import `codex-cli` (which already imports it) without a cycle.
 */

import { isTransientCodexFailure } from './codex-cli';
import { isTransientStreamErrorText, USAGE_LIMIT_TEXT } from './provider-diagnostics';
import type { Provider, ProviderEvent, StreamRequest } from './types';

/** Retries after the first attempt, for both the registry and the collector. */
export const SAME_MODEL_MAX_RETRIES = 2;
export const SAME_MODEL_RETRY_BASE_MS = 750;

/**
 * Identify transient provider errors (5xx / timeouts / in-stream server error
 * frames) that should be retried on the same model, or fall through to a
 * fallback provider, instead of failing closed. 4xx auth errors (401/403/
 * invalid key) stay fail-closed.
 */
export function isRetriableProviderFailure(error: unknown): boolean {
  const errObj = error as
    { message?: string; status?: number; statusCode?: number; code?: string } | undefined;
  const rawMsg = String(errObj?.message || error || '');
  const msg = rawMsg.toLowerCase();
  const status =
    typeof errObj?.status === 'number'
      ? errObj.status
      : typeof errObj?.statusCode === 'number'
        ? errObj.statusCode
        : undefined;
  const code = String(errObj?.code || '').toUpperCase();

  // A hard usage cap never recovers on a same-model retry — providers wrap it
  // in 500-class text ("Internal error: Free usage limit reached"), so this
  // check must precede every status-based retry path.
  if (USAGE_LIMIT_TEXT.test(msg)) return false;

  // Fail-closed for auth errors even if the message mentions retryable words.
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('authentication') ||
    msg.includes('sign in') ||
    msg.includes('sign-in') ||
    msg.includes('signin') ||
    msg.includes('not signed') ||
    msg.includes('not logged') ||
    msg.includes('login required') ||
    msg.includes('codex login') ||
    msg.includes('invalid token') ||
    msg.includes('expired token') ||
    msg.includes('token expired') ||
    msg.includes('auth.json')
  ) {
    // A genuine 5xx status still retries even with noisy text; otherwise stay closed.
    if (status !== 500 && status !== 502 && status !== 503 && status !== 504) return false;
  }

  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED') return true;
  if (
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('504') ||
    msg.includes('etimedout') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('upstream') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('internal server error') ||
    msg.includes('gateway timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('econnreset') ||
    msg.includes('econnaborted')
  )
    return true;
  // In-stream `error` frames carry no HTTP status — the Anthropic SDK throws
  // `APIError.generate(undefined, 'SSE Error: …')` — so a 500-class upstream
  // `api_error` is invisible to the status checks above.
  if (isTransientStreamErrorText(rawMsg, status)) return true;
  // Codex CLI / ChatGPT-side blips ("Reconnecting... 1/5", "Something went
  // wrong", stream disconnects, 429-adjacent rate blips). The shared matcher
  // stays fail-closed on auth text, so delegating here is safe.
  return isTransientCodexFailure(rawMsg);
}

/**
 * Backoff between retries (750ms, 1500ms). Abort-aware: resolves early on
 * cancel so a user stop is never stuck behind a sleep.
 */
export function waitForProviderRetry(retryIndex: number, signal?: AbortSignal): Promise<void> {
  const delayMs = SAME_MODEL_RETRY_BASE_MS * 2 ** Math.max(0, retryIndex - 1);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CollectedProviderStream {
  /** Every event from the attempt that was kept, in order. A failed attempt's
   *  events are discarded so a retry cannot duplicate partial output. */
  events: ProviderEvent[];
  /** True when the stream ended on a provider error event rather than cleanly. */
  failed: boolean;
  /** The provider's reason for `failed`, already redacted and bounded. */
  error?: string;
  /** Attempts actually made, including the first. */
  attempts: number;
}

export interface CollectProviderEventsOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  /** Called before each retry with the provider's reason, for logging. */
  onRetry?: (attempt: number, reason: string) => void;
}

/**
 * Run a provider call to completion, retrying a transient failure on the same
 * model, and return the events of the attempt that was kept.
 *
 * Buffers per attempt instead of streaming through: these callers accumulate
 * text or inspect tool events, so a retried attempt must not append to output
 * the previous attempt already produced. The main chat turn does not use this —
 * it goes through the registry, which streams and resumes with its tool ledger.
 *
 * Never throws for a provider-reported failure: inspect `failed`/`error`, or
 * let the caller's own fallback decide. Genuine aborts and unexpected throws
 * still propagate.
 */
export async function collectProviderEvents(
  provider: Provider,
  request: StreamRequest,
  options: CollectProviderEventsOptions = {},
): Promise<CollectedProviderStream> {
  const maxRetries = options.maxRetries ?? SAME_MODEL_MAX_RETRIES;
  let attempt = 0;
  for (;;) {
    const events: ProviderEvent[] = [];
    let failure: ProviderEvent | undefined;
    try {
      for await (const event of provider.streamResponse(request)) {
        if (event.type === 'error') {
          failure = event;
          break;
        }
        events.push(event);
      }
    } catch (error: unknown) {
      // A throw mid-stream is the same class of failure as an error event.
      failure = { type: 'error', error: error instanceof Error ? error.message : String(error) };
    }

    if (!failure) {
      return { events, failed: false, attempts: attempt + 1 };
    }

    const message = typeof failure.error === 'string' ? failure.error : '';
    const retriable =
      failure.errorTransient === true ||
      (message.length > 0 && isRetriableProviderFailure(message));
    const aborted = options.signal?.aborted === true;
    if (!retriable || aborted || attempt >= maxRetries) {
      return {
        events,
        failed: true,
        ...(message ? { error: message } : {}),
        attempts: attempt + 1,
      };
    }

    attempt += 1;
    options.onRetry?.(attempt, message);
    await waitForProviderRetry(attempt, options.signal);
    if (options.signal?.aborted) {
      return { events: [], failed: true, error: message, attempts: attempt + 1 };
    }
  }
}
