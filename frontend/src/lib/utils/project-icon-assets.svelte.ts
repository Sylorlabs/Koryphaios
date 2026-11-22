import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';

/**
 * Project image assets live behind Bearer-authenticated API routes
 * (/api/workspace/project-icon/<assetId>). An <img> element cannot send the
 * Authorization header, and in the packaged app the relative path resolves to
 * the app origin, so `<img src>` can never display one. Fetch the bytes
 * through apiFetch instead and hand consumers a data: URL — the desktop CSP
 * allows `img-src data:` but not `blob:`.
 *
 * Results are cached by asset path with in-flight de-duplication. A 404 or a
 * non-PNG body is a definitive failure and stays cached; any other failure
 * (a backend that is still starting up, a network drop) is dropped after a
 * short backoff so the next read retries.
 */

type CacheEntry = { ok: true; dataUrl: string } | { ok: false };

const RETRY_BACKOFF_MS = 15_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let cacheVersion = $state(0);

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result) {
        resolvePromise(reader.result);
      } else {
        reject(new Error('Project icon could not be read'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Project icon could not be read'));
    reader.readAsDataURL(blob);
  });
}

function scheduleRetry(path: string): void {
  const timer = setTimeout(() => {
    retryTimers.delete(path);
    cache.delete(path);
    cacheVersion += 1;
  }, RETRY_BACKOFF_MS);
  retryTimers.set(path, timer);
}

async function loadAsset(path: string): Promise<void> {
  try {
    const response = await apiFetch(apiUrl(path));
    if (!response.ok) {
      cache.set(path, { ok: false });
      if (response.status !== 404) scheduleRetry(path);
      return;
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/png')) {
      cache.set(path, { ok: false });
      return;
    }
    cache.set(path, { ok: true, dataUrl: await readBlobAsDataUrl(await response.blob()) });
  } catch {
    cache.set(path, { ok: false });
    scheduleRetry(path);
  } finally {
    inflight.delete(path);
    cacheVersion += 1;
  }
}

/**
 * Resolve a project icon asset reference to a renderable URL. `data:` URLs
 * (unsaved drafts) pass through untouched. Returns null while the fetch is in
 * flight or after a failure — callers render the letters fallback.
 */
export function projectIconAssetUrl(reference: string | null | undefined): string | null {
  cacheVersion; // re-run callers when an in-flight load settles
  if (!reference) return null;
  if (reference.startsWith('data:')) return reference;
  const hit = cache.get(reference);
  if (hit) return hit.ok ? hit.dataUrl : null;
  if (!inflight.has(reference)) {
    // apiFetch can synchronously write auth/session $state; starting it inside
    // a derivation would trip state_unsafe_mutation. The in-flight marker is
    // registered now so concurrent readers dedupe, but the fetch itself starts
    // on the next microtask.
    inflight.set(
      reference,
      Promise.resolve().then(() => loadAsset(reference)),
    );
  }
  return null;
}

/** Test hook: drop cached entries and pending retries so a suite can re-drive a URL. */
export function clearProjectIconAssetCache(): void {
  cache.clear();
  inflight.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}
