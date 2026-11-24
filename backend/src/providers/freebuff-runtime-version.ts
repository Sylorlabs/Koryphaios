/**
 * Latest Freebuff version resolution. Kory tracks the same source the official
 * npm launcher uses: the unauthenticated npm `latest` tag on the `freebuff`
 * package. No cookies, credentials, or host state cross this boundary.
 */

/** 0.2.16 is server-retired; 0.2.36 is the oldest version with qualified shapes. */
export const FREEBUFF_MIN_RUNTIME_VERSION = '0.2.36';

const FREEBUFF_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const FREEBUFF_LATEST_URL = 'https://registry.npmjs.org/freebuff/latest';
const RESOLVE_TIMEOUT_MS = 10_000;
const RESOLVE_SUCCESS_TTL_MS = 6 * 60 * 60_000;
const RESOLVE_FAILURE_TTL_MS = 10 * 60_000;

export function isValidFreebuffVersion(value: unknown): value is string {
  return typeof value === 'string' && FREEBUFF_VERSION_PATTERN.test(value);
}

export function compareFreebuffVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Measured archive hashes for versions Kory has verified locally, keyed by
 * version and Docker architecture. A version absent here is built
 * trust-on-first-use: the downloaded hash is recorded inside the image at
 * /opt/kory/freebuff/ARCHIVE_SHA256, matching the official launcher's
 * unverified download behavior.
 */
export const KNOWN_FREEBUFF_ARCHIVE_SHA256: Record<string, { amd64: string; arm64: string }> = {
  '0.2.36': {
    amd64: '7991a166aba6f374792ac8e9d9300280f6e5a2044935b268dfd96ff4b7d103e3',
    arm64: 'ed752a58958a01a3172eebdda3b7fabff27d4dc099e94c5d8a3a6da5d97692a3',
  },
};

export interface FreebuffLatestResolveOptions {
  /** Bypass both caches and any in-flight sharing; fetch fresh registry data. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

let resolvedCache: { version: string; expiresAt: number } | undefined;
let failedUntil = 0;
let resolving: Promise<string | null> | undefined;

export function resetFreebuffVersionCacheForTests(): void {
  resolvedCache = undefined;
  failedUntil = 0;
}

/**
 * Resolve the latest published Freebuff version. Returns null on any failure —
 * offline, registry error, redirect, malformed body, or a release below the
 * minimum supported version. Never throws to callers.
 */
export async function resolveLatestFreebuffVersion(
  options: FreebuffLatestResolveOptions = {},
): Promise<string | null> {
  const now = (options.now ?? Date.now)();
  if (!options.force) {
    if (resolvedCache && now < resolvedCache.expiresAt) return resolvedCache.version;
    if (now < failedUntil) return null;
    if (resolving) return resolving;
  }
  const attempt = (async (): Promise<string | null> => {
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(FREEBUFF_LATEST_URL, {
        headers: { accept: 'application/json' },
        // Never follow redirects: the resolver stays on the npm origin and a
        // non-https redirect must never be honored.
        redirect: 'manual',
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const version =
        body && typeof body === 'object' ? (body as { version?: unknown }).version : undefined;
      if (
        !isValidFreebuffVersion(version) ||
        compareFreebuffVersions(version, FREEBUFF_MIN_RUNTIME_VERSION) < 0
      )
        return null;
      resolvedCache = { version, expiresAt: now + RESOLVE_SUCCESS_TTL_MS };
      failedUntil = 0;
      return version;
    } catch {
      return null;
    }
  })();
  if (!options.force) resolving = attempt;
  try {
    const result = await attempt;
    if (result === null) failedUntil = now + RESOLVE_FAILURE_TTL_MS;
    return result;
  } finally {
    if (resolving === attempt) resolving = undefined;
  }
}
