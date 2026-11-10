/** One physical desktop: serialize across sessions, tools and adapter instances. */
let tail: Promise<unknown> = Promise.resolve();
const pending = new Set<AbortController>();
const stopListeners = new Set<() => void>();

export function onComputerUseStop(listener: () => void): () => void {
  stopListeners.add(listener);
  return () => stopListeners.delete(listener);
}

export function stopComputerUse(reason = 'Computer use stopped or permissions revoked'): number {
  const count = pending.size;
  for (const controller of pending) controller.abort(new Error(reason));
  for (const listener of stopListeners) listener();
  return count;
}

export function computerUsePendingCount(): number {
  return pending.size;
}

/** Cancellation returns promptly, but retains the lock until the native operation actually exits. */
export async function withComputerUseLock<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error('Computer use cancelled'));
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  pending.add(controller);
  const timer = setTimeout(() => controller.abort(new Error('Computer use timed out')), timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
  });
  const operation = tail.then(async () => {
    controller.signal.throwIfAborted();
    return work(controller.signal);
  });
  tail = operation.catch(() => undefined);
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // Keep aborted-but-still-running native operations visible to subsequent stops.
    void operation.finally(() => pending.delete(controller)).catch(() => undefined);
  }
}
