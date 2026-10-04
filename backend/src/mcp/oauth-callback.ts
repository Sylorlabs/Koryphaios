// Ephemeral loopback listener that receives the OAuth authorization redirect.
//
// The authorization server redirects the user's browser to
// `http://127.0.0.1:<port>/callback?code=...&state=...`. A loopback redirect is
// the redirect form the MCP authorization spec and RFC 8252 both bless, and it
// needs no custom URI scheme registered with the desktop OS.
//
// This listener is deliberately paranoid: it binds the loopback interface only
// (never 0.0.0.0), serves exactly one fixed route, answers anything else with
// 404, caps header size and connection count, and tears itself down the moment
// the flow finishes or the lifetime expires.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mcpLog } from '../logger';

export interface OAuthCallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  issuer?: string;
}

export interface OAuthCallbackListener {
  /** The exact redirect_uri to hand to the authorization server. */
  redirectUri: string;
  /** Resolves with the first callback that carries a code or an error. */
  result: Promise<OAuthCallbackResult>;
  /** Idempotent teardown. Safe to call while a flow is still pending. */
  close(): Promise<void>;
}

/** How long the user has to finish consenting in the browser. */
export const CALLBACK_LIFETIME_MS = 5 * 60_000;
const MAX_HEADER_BYTES = 8192;
const MAX_CONNECTIONS = 8;

/** HTML shown in the browser once the redirect lands. Contains no user data. */
function resultPage(ok: boolean, message: string): string {
  const title = ok ? 'Koryphaios connected' : 'Koryphaios could not connect';
  const tint = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0b0b0f;color:#e6e6ea}
.card{max-width:30rem;padding:2rem;border-radius:16px;background:#16161c;border:1px solid #26262e;text-align:center}
.dot{width:12px;height:12px;border-radius:50%;background:${tint};margin:0 auto 1rem}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#a1a1aa;font-size:.9rem}</style></head>
<body><div class="card"><div class="dot"></div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Start a single-use loopback listener on an ephemeral port.
 *
 * Binds `127.0.0.1` explicitly. Only `/callback` is served; every other path
 * gets 404 so the listener cannot be used as a general-purpose proxy or a
 * file server by anything else on the machine.
 */
export async function startOAuthCallbackListener(
  options: { expectedState: string; lifetimeMs?: number } = { expectedState: '' },
): Promise<OAuthCallbackListener> {
  let settle: ((value: OAuthCallbackResult) => void) | null = null;
  let closed = false;

  const result = new Promise<OAuthCallbackResult>((resolve) => {
    settle = resolve;
  });

  const finish = (value: OAuthCallbackResult): void => {
    if (settle) {
      const resolve = settle;
      settle = null;
      resolve(value);
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const issuer = url.searchParams.get('iss');

    if (error) {
      respond(
        res,
        false,
        url.searchParams.get('error_description') ??
          `The provider returned "${error}". You can close this tab.`,
      );
      finish({
        error,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
        state: state ?? undefined,
      });
      return;
    }
    if (!code) {
      respond(res, false, 'The provider did not return an authorization code.');
      finish({ error: 'invalid_request', errorDescription: 'No code in callback' });
      return;
    }

    // Bind the response to the request that started it. A mismatched state
    // means this callback is not ours — never exchange it.
    if (options.expectedState && state !== options.expectedState) {
      respond(res, false, 'This authorization response did not match the pending request.');
      finish({ error: 'state_mismatch' });
      return;
    }

    respond(res, true, 'You can close this tab and return to Koryphaios.');
    finish({ code, state: state ?? undefined, issuer: issuer ?? undefined });
  };

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 1000;

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    // Loopback only. This listener holds a live authorization code; it must
    // never be reachable from another host.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not bind a loopback port for the OAuth callback');
  }
  const port = address.port;

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(lifetime);
    // Unblock a caller still awaiting the redirect.
    finish({ error: 'closed', errorDescription: 'The authorization window was closed' });
    closePromise = new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    return closePromise;
  };

  const lifetime = setTimeout(() => {
    void close();
  }, options.lifetimeMs ?? CALLBACK_LIFETIME_MS);
  lifetime.unref();

  mcpLog.info({ port, closed: false }, 'MCP OAuth callback listener bound to loopback');

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close: async () => {
      await close();
      mcpLog.info({ port, closed }, 'MCP OAuth callback listener closed');
    },
  };
}

function respond(res: ServerResponse, ok: boolean, message: string): void {
  const html = resultPage(ok, escapeHtml(message));
  res.writeHead(ok ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The page is a static string with no scripts, styles are inline, and it
    // must not be framed or sniffed.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

/** The only dynamic content on the page is the provider's own error text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .slice(0, 400);
}
