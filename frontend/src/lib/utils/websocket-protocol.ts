export interface WebSocketPing {
  type: 'ping';
  timestamp: number;
}

export interface WebSocketPong {
  type: 'pong';
  timestamp: number;
}

export function isWebSocketPing(value: unknown): value is WebSocketPing {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WebSocketPing>;
  return candidate.type === 'ping' && Number.isFinite(candidate.timestamp);
}

export function createWebSocketPong(timestamp = Date.now()): WebSocketPong {
  return { type: 'pong', timestamp };
}

/** Diagnostic labels must never expose auth query parameters. */
export function redactWebSocketUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[invalid websocket URL]';
  }
}

/**
 * Validate the local browser session before a websocket is constructed.
 *
 * The desktop webview survives backend restarts, while the backend's local
 * bearer registry does not. Reading the token only after `ensureSession`
 * finishes guarantees a reconnect cannot replay the stale pre-restart token.
 */
export async function prepareAuthenticatedWebSocketUrl(
  baseUrl: string,
  ensureSession: () => Promise<boolean>,
  getToken: () => string | undefined,
): Promise<string | null> {
  if (!(await ensureSession())) return null;
  const token = getToken();
  if (!token) return null;
  const url = new URL(baseUrl);
  url.searchParams.set('auth', token);
  return url.toString();
}

/** Established sockets always retry the authoritative direct backend first. */
export function nextWebSocketCandidateIndex(
  currentIndex: number,
  candidateCount: number,
  opened: boolean,
): number {
  if (opened || candidateCount <= 1) return 0;
  return currentIndex < candidateCount - 1 ? currentIndex + 1 : 0;
}
