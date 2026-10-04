import { ValidationError } from '../../errors/types';
import { withTimeout } from './http';

/**
 * Submit → poll → download is the shape of every asynchronous media provider
 * Koryphaios speaks to (Luma generations, Kling tasks, Prodia jobs, Replicate
 * predictions). Only the URL builder and state mapping differ, so the polling
 * discipline lives here once: bounded attempts, bounded wall clock, immediate
 * abort propagation, and no unbounded sleep after cancellation.
 */

export interface PollJobOptions<T> {
  /** Query the provider for current job state. */
  status: (attempt: number) => Promise<T>;
  /** Map a provider status payload onto a decision. */
  interpret: (state: T) => JobState;
  /** Download the finished asset once the job reports success. */
  onCompleted?: (state: T) => Promise<void>;
  signal: AbortSignal;
  /** Overall wall-clock budget for the whole poll. */
  timeoutMs: number;
  /** First delay between polls. */
  intervalMs?: number;
  /** Upper bound on the delay; grows toward it between polls. */
  maxIntervalMs?: number;
  provider: string;
}

export type JobState =
  { kind: 'pending' } | { kind: 'completed' } | { kind: 'failed'; reason: string };

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_INTERVAL_MS = 8_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollJob<T>(options: PollJobOptions<T>): Promise<T> {
  const {
    status,
    interpret,
    onCompleted,
    signal,
    timeoutMs,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
    provider,
  } = options;
  const bounded = withTimeout(signal, timeoutMs, `${provider} generation`);
  const deadline = Date.now() + timeoutMs;
  const deadlineError = () =>
    new ValidationError(
      `${provider} did not finish generating within ${Math.round(timeoutMs / 1000)}s. ` +
        'The job may still complete upstream, so this is not proof the request failed.',
    );
  let attempt = 0;
  let delay = intervalMs;
  let lastPending: T | undefined;

  while (true) {
    if (bounded.aborted) {
      // The caller's own cancellation must win; only our deadline timer is
      // translated into the actionable "still rendering" message.
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException(`${provider} generation cancelled`, 'AbortError');
      }
      throw deadlineError();
    }
    if (Date.now() >= deadline) {
      throw deadlineError();
    }
    let state: T;
    try {
      state = await status(attempt);
    } catch (err: unknown) {
      // A single failed poll is not fatal while the deadline is far away;
      // upstream generation endpoints 5xx transiently under load.
      if (Date.now() + delay < deadline && !signal.aborted) {
        lastPending = undefined;
        attempt += 1;
        await sleep(delay, signal).catch(() => undefined);
        delay = Math.min(maxIntervalMs, Math.round(delay * 1.5));
        continue;
      }
      throw err;
    }
    const decision = interpret(state);
    if (decision.kind === 'completed') {
      if (onCompleted) await onCompleted(state);
      return state;
    }
    if (decision.kind === 'failed') {
      throw new ValidationError(`${provider} generation failed: ${decision.reason}`);
    }
    lastPending = state;
    attempt += 1;
    try {
      await sleep(delay, bounded);
    } catch {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException(`${provider} generation cancelled`, 'AbortError');
      }
      throw deadlineError();
    }
    delay = Math.min(maxIntervalMs, Math.round(delay * 1.4));
  }
}

/**
 * Fetch a provider-hosted asset and inline it as base64.
 *
 * Every media provider here returns a signed CDN URL that expires in days (and
 * Kling explicitly clears generated media after 30 days), so the bytes must be
 * persisted immediately rather than stored as a link.
 */
export async function downloadAsset(
  url: string,
  options: { provider: string; mimeType?: string; signal: AbortSignal; maxBytes: number },
): Promise<{ base64: string; mimeType: string }> {
  const { provider, mimeType, signal, maxBytes } = options;
  let response: Response;
  try {
    response = await fetch(url, { signal: withTimeout(signal, 120_000, `${provider} download`) });
  } catch (err: unknown) {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException(`${provider} download cancelled`, 'AbortError');
    }
    throw new ValidationError(
      `${provider} produced a result that could not be downloaded (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  if (!response.ok) {
    throw new ValidationError(`${provider} result download returned HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new ValidationError(
      `${provider} produced a ${declared}-byte asset, above the supported limit of ${maxBytes} bytes.`,
    );
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new ValidationError(
      `${provider} produced a ${buffer.byteLength}-byte asset, above the supported limit of ${maxBytes} bytes.`,
    );
  }
  return {
    base64: Buffer.from(buffer).toString('base64'),
    mimeType:
      mimeType || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
  };
}

/** Decode a `data:` URL, which several providers use for inline output. */
export function decodeDataUrl(value: string): { base64: string; mimeType: string } | undefined {
  const match = /^data:([\w.+-]+\/[\w.+-]+)?;base64,(.+)$/s.exec(value.trim());
  if (!match) return undefined;
  return { mimeType: match[1] || 'application/octet-stream', base64: match[2] };
}
