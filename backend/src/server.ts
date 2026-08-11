// Koryphaios Backend Server — Bun HTTP + WebSocket server.
// Main entry point via ElysiaJS.

import 'reflect-metadata';
import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { nanoid } from 'nanoid';
import { readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'bun';

import { bootstrap } from './bootstrap';
import { setContext } from './context';
import { serverLog } from './logger';
import { VERSION, ID, RATE_LIMIT, COMPAT, SECURITY } from './constants';
import { RateLimiter } from './security/rate-limit';
import { addCorsOrigins } from './security';
import { PROJECT_ROOT } from './runtime/paths';
import { resolveBundleHash, isBundleHashEnforced } from './config/compat';
import { createWebSocketHandlers } from './server/websocket-handler';
import type { WSClientData } from './ws/ws-manager';
import { validateLocalBearerToken } from './auth/local-route-auth';
import { serveMcp } from './mcp/koryphaios-mcp-endpoint';
import { getDb } from './db';
import { shutdownAllBrokers } from './pubsub';
import { getRequestProjectRoot } from './runtime/request-project';

// Routes
import { sessionRoutes } from './routes/v1/sessions';
import { messageRoutes } from './routes/v1/messages';
import { providerRoutes } from './routes/v1/providers';
import { collaborationRoutes } from './routes/collaboration';
import { authRoutes } from './routes/v1/auth';
import { agentSettingsRoutes } from './routes/v1/agent-settings';
import { gitRoutes } from './routes/v1/git';
import { memoryRoutes } from './routes/v1/memory';
import { modeRoutes } from './routes/v1/mode';
import { spendRoutes } from './routes/v1/spend';
import { spendCapsRoutes } from './routes/v1/spend-caps';
import { billingRoutes } from './routes/v1/billing';
import { processRoutes } from './routes/v1/processes';
import { notesRoutes } from './routes/v1/notes';
import { workspaceRoutes } from './routes/v1/workspace';
import { goalRoutes } from './routes/v1/goals';
import { nativeCommandRoutes } from './routes/v1/native-commands';
import { mcpBridgeRoutes } from './routes/v1/mcp-bridge';
import { mcpServerRoutes } from './routes/v1/mcp-servers';
import { voiceRoutes } from './routes/v1/voice';
import { errorHandlingMiddleware, errorHandler } from './middleware/error-handling';

const SERVER_STARTED_AT = Date.now();
const BACKEND_SERVICE_ID = 'koryphaios';

// Define base Elysia App for export
const baseApp = new Elysia()
  .get('/api/health', () => ({
    ok: true,
    data: {
      id: BACKEND_SERVICE_ID,
      version: VERSION,
      uptime: process.uptime(),
      // Lets the desktop supervisor reject a stale process already bound to
      // the configured port instead of mistaking it for the embedded service.
      pid: process.pid,
      // Frontend/backend compatibility contract. The frontend reads this and
      // halts normal operation when its own version/bundle-hash falls outside
      // the range the backend reports. Prevents a stale frontend from running
      // silently against a fresh backend (or vice versa).
      compat: {
        minFrontend: COMPAT.minFrontend,
        currentFrontend: COMPAT.currentFrontend,
        bundleHash: resolveBundleHash(),
        bundleHashEnforced: isBundleHashEnforced(),
        serverStartedAt: SERVER_STARTED_AT,
      },
    },
  }))
  .get('/api/project', async () => {
    const { basename } = await import('node:path');
    const projectName = basename(PROJECT_ROOT);
    return { ok: true, data: { projectName } };
  })
  .post('/api/debug/log-error', () => ({ ok: true }))
  .onError(errorHandler)
  .use(sessionRoutes)
  .use(messageRoutes)
  .use(providerRoutes)
  .use(collaborationRoutes)
  .use(authRoutes)
  .use(agentSettingsRoutes)
  .use(gitRoutes)
  .use(memoryRoutes)
  .use(modeRoutes)
  .use(spendRoutes)
  .use(spendCapsRoutes)
  .use(billingRoutes)
  .use(processRoutes)
  .use(notesRoutes)
  .use(workspaceRoutes)
  .use(goalRoutes)
  .use(nativeCommandRoutes)
  .use(mcpBridgeRoutes)
  .use(mcpServerRoutes)
  .use(voiceRoutes);

export type App = typeof baseApp;

// ─── Rate-limit helper functions ───────────────────────────────────────

/** True when the IP is a loopback address (127.0.0.0/8 or ::1). */
function isLoopbackIp(ip: string): boolean {
  if (ip === '::1') return true;
  if (ip.startsWith('127.')) return true;
  // IPv4-mapped IPv6 loopback.
  if (ip === '::ffff:127.0.0.1') return true;
  return false;
}

/**
 * Check whether a peer IP is in the trusted-proxy list. Supports exact IP
 * matches and CIDR notation (e.g. "10.0.0.0/24"). When the list is empty,
 * no IP is trusted — X-Forwarded-For is never honored.
 */
function isIpInTrustedProxies(ip: string, proxies: string[]): boolean {
  if (proxies.length === 0) return false;
  for (const entry of proxies) {
    if (entry === ip) return true;
    if (entry.includes('/')) {
      if (isIpInCidr(ip, entry)) return true;
    }
  }
  return false;
}

/** Minimal CIDR check for IPv4. Returns false for IPv6 (not needed for the
 *  common proxy case; operators can list exact IPv6 proxies). */
function isIpInCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/');
  if (!base || !prefixStr) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipParts = ip.split('.').map(Number);
  const baseParts = base.split('.').map(Number);
  if (ipParts.length !== 4 || baseParts.length !== 4) return false;
  if (ipParts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  if (baseParts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const baseNum =
    ((baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // The network portions (ip & mask and base & mask) must match.
  return (ipNum & mask) === (baseNum & mask);
}

async function main() {
  serverLog.info('═══════════════════════════════════════');
  serverLog.info(`       KORYPHAIOS v${VERSION}`);
  serverLog.info('  AI Agent Orchestration Dashboard');
  serverLog.info('═══════════════════════════════════════');

  // Bootstrap dependencies
  const ctx = await bootstrap();
  setContext(ctx);
  const { config, kory, providers, sessions, messages, wsManager } = ctx;

  // Default to 127.0.0.1 for local-only security. A network-exposed server
  // keeps the normal per-client rate limit below; a desktop loopback server
  // must not throttle its own UI, health sentinel, or auxiliary windows as
  // though they were unrelated public clients.
  const requestedPort = Number(process.env.KORYPHAIOS_PORT);
  const serverConfig = {
    // The desktop launcher owns the dev port contract. Respect its explicit
    // override so it can keep frontend, backend, and Tauri on the same
    // isolated stack when the default port is occupied.
    port:
      Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535
        ? requestedPort
        : (config.server?.port ?? 3001),
    host: process.env.KORYPHAIOS_HOST || config.server?.host || '127.0.0.1',
  };
  const isLoopbackServer = ['127.0.0.1', '::1', 'localhost'].includes(serverConfig.host);

  const rateLimiter = new RateLimiter(RATE_LIMIT.MAX_REQUESTS, RATE_LIMIT.WINDOW_MS);

  // CORS origin policy. When the user has not configured any origins, fall
  // back to the loopback dev origins in SECURITY.ALLOWED_ORIGINS instead of
  // reflecting any origin (the old `origin: undefined` behavior). This keeps
  // the desktop app working while closing the cross-origin hole that opens
  // the moment someone binds the backend to 0.0.0.0.
  const corsOrigins = config.corsOrigins?.length
    ? config.corsOrigins
    : [...SECURITY.ALLOWED_ORIGINS];
  // Keep the low-level CORS helper used by OPTIONS/error paths in sync with
  // Elysia's configured allowlist. Packaged Tauri origins are included in
  // SECURITY.ALLOWED_ORIGINS; configured origins are merged here as well.
  addCorsOrigins(corsOrigins);

  // Trusted proxy CIDRs for X-Forwarded-For. When the backend is behind a
  // reverse proxy, the operator sets KORYPHAIOS_TRUSTED_PROXIES to the
  // proxy's CIDR(s). Only then is X-Forwarded-For honored for rate-limit
  // identity; otherwise the socket peer IP is used, preventing clients from
  // rotating the header to bypass rate limits.
  const trustedProxies = (process.env.KORYPHAIOS_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Setup actual running app with middleware
  const runningApp = new Elysia()
    .use(cors({ origin: corsOrigins }))
    .onRequest(({ request, set, server }) => {
      const url = new URL(request.url);

      // Never rate-limit the liveness endpoint. /api/health is used by the
      // Tauri supervisor (every 3s), the frontend sentinel (every 5s), and
      // the dev-mode launcher watchdog. Rate-limiting it would make those
      // monitoring loops unreliable — the whole point of the health endpoint
      // is to ALWAYS be reachable when the process is alive.
      if (url.pathname === '/api/health') return;

      // Determine the client IP. X-Forwarded-For is only honored when the
      // request came from a trusted proxy; otherwise the socket peer IP is
      // used. This prevents clients from rotating the header to get a fresh
      // rate-limit bucket.
      const peerInfo = server?.requestIP(request);
      const peerIp = peerInfo?.address ?? null;
      const forwardedFor = request.headers.get('x-forwarded-for');
      let clientIp: string;
      if (forwardedFor && peerIp && isIpInTrustedProxies(peerIp, trustedProxies)) {
        clientIp = forwardedFor.split(',')[0].trim();
      } else if (forwardedFor && isLoopbackServer && !peerIp) {
        // Legacy compat: loopback server with no peer info available through
        // the Fetch Request API. Keep the old behavior so the desktop UI's
        // own requests don't all bucket into 'local' and starve each other.
        clientIp = forwardedFor.split(',')[0].trim();
      } else {
        clientIp = peerIp ?? 'local';
      }

      // Loopback desktop backend: don't throttle the UI's own requests.
      if (isLoopbackServer && (clientIp === 'local' || isLoopbackIp(clientIp))) return;

      const rateCheck = rateLimiter.check(clientIp);
      if (!rateCheck.allowed) {
        set.status = 429;
        return { ok: false, error: 'Rate limit exceeded' };
      }
    })
    .use(baseApp)
    .all('/api/*', ({ set }) => {
      set.status = 404;
      return { ok: false, error: 'Not Found' };
    });

  // ─── Start Server ───────────────────────────────────────────────────────────

  // Bind directly to the requested port. The old code pre-probed the port
  // with a throwaway TCP server and then asked Bun to bind — a TOCTOU race
  // (another process could grab the port between the probe and the bind)
  // and a sequential scan up to 65535 when the port was taken. Now we bind
  // directly and handle EADDRINUSE by incrementing the port once. If the
  // next port is also taken, we fail loudly instead of scanning — the
  // desktop launcher and the user should know, not silently climb.
  let actualPort = serverConfig.port;
  let server: Server<WSClientData>;

  // Capture the fetch handler so the server closure can use it.
  const fetchHandler = async (req: Request, srv: Server<WSClientData>): Promise<Response> => {
    const url = new URL(req.url);

    // 1. WebSocket upgrade
    if (url.pathname === '/ws') {
      // Auth token: prefer the Authorization header (not logged by
      // proxies). Fall back to the subprotocol header (legacy, but
      // browsers can't set WS headers — the Tauri webview can, so the
      // desktop app uses the header). The ?auth= query fallback is
      // deprecated because query strings appear in access logs.
      const authHeader = req.headers.get('authorization');
      const protocols =
        req.headers
          .get('sec-websocket-protocol')
          ?.split(',')
          .map((s) => s.trim()) || [];
      const authToken =
        authHeader ?? (protocols.length > 1 ? protocols[1] : null) ?? url.searchParams.get('auth');

      const authSession = validateLocalBearerToken(authToken);
      if (!authSession) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Unauthorized WebSocket request' }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const upgraded = srv.upgrade(req, {
        data: { id: nanoid(ID.WS_CLIENT_ID_LENGTH), userId: authSession.id },
      });
      if (upgraded) return new Response(null, { status: 101 });
      return new Response(JSON.stringify({ ok: false, error: 'WebSocket upgrade failed' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1b. MCP endpoint — Koryphaios's own tools (notes/memory) for any
    // MCP-capable CLI harness (grok, claude-code, codex…).
    if (url.pathname === '/mcp') {
      try {
        return serveMcp(req, getRequestProjectRoot(req), (t) => !!validateLocalBearerToken(t));
      } catch (error) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid project',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    // 2. API Routes
    if (url.pathname.startsWith('/api')) {
      return runningApp.handle(req);
    }

    // 3. Static Frontend Files — packaged app ships the build as a Tauri
    // resource and points KORYPHAIOS_FRONTEND_DIST at it; dev serves the
    // repo's build output. Same server either way: one app, one origin.
    const frontendBuildDir = resolve(
      process.env.KORYPHAIOS_FRONTEND_DIST?.trim() ||
        join(PROJECT_ROOT, 'frontend', 'build', 'client'),
    );
    let filePath = resolve(join(frontendBuildDir, url.pathname));

    if (url.pathname === '/' || url.pathname.endsWith('/')) {
      filePath = join(frontendBuildDir, 'index.html');
    }

    // Containment check via realpath, not resolve. resolve() doesn't
    // resolve symlinks, so a symlink inside the build dir pointing
    // outside would walk past this check. realpathSync resolves the
    // full symlink chain before we compare against the build dir.
    let resolvedFilePath: string;
    try {
      resolvedFilePath = realpathSync(filePath);
    } catch (err: unknown) {
      // ENOENT is expected for SPA routes that should fall back to
      // index.html. Other errors (EACCES, ELOOP, EIO) are suspicious —
      // fail closed instead of using the unresolved path, which could
      // bypass the containment check.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        resolvedFilePath = filePath;
      } else {
        return new Response('Forbidden', { status: 403 });
      }
    }
    let resolvedBuildDir: string;
    try {
      resolvedBuildDir = realpathSync(frontendBuildDir);
    } catch {
      resolvedBuildDir = frontendBuildDir;
    }
    if (!resolvedFilePath.startsWith(resolvedBuildDir)) {
      return new Response('Forbidden', { status: 403 });
    }

    let file = Bun.file(resolvedFilePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // 4. SPA Fallback (Routing handled by frontend)
    const indexHtml = Bun.file(join(resolvedBuildDir, 'index.html'));
    if (await indexHtml.exists()) {
      return new Response(indexHtml);
    }

    // 5. Final Fallback
    return new Response('Not Found', { status: 404 });
  };

  const startServer = (port: number): Server<WSClientData> =>
    Bun.serve<WSClientData>({
      port,
      hostname: serverConfig.host,
      websocket: createWebSocketHandlers({ wsManager, sessions, kory, providers }),
      async fetch(req, srv) {
        return fetchHandler(req, srv);
      },
    });

  try {
    server = startServer(actualPort);
  } catch (err: unknown) {
    // Bun.serve throws synchronously on EADDRINUSE. Retry once on the
    // next port; if that's also taken, fail loudly.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EADDRINUSE') && actualPort < 65_535) {
      actualPort = actualPort + 1;
      serverLog.warn(
        { requestedPort: serverConfig.port, actualPort },
        'Requested port in use, using next available port',
      );
      server = startServer(actualPort);
    } else {
      throw err;
    }
  }

  const clientHost = serverConfig.host === '0.0.0.0' ? '127.0.0.1' : serverConfig.host;
  const activePortPath = join(PROJECT_ROOT, '.koryphaios', '.active-port.json');

  try {
    writeFileSync(
      activePortPath,
      JSON.stringify(
        {
          port: actualPort,
          host: clientHost,
          url: `http://${clientHost}:${actualPort}`,
          wsUrl: `ws://${clientHost}:${actualPort}/ws`,
          timestamp: Date.now(),
          pid: process.pid,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    serverLog.warn({ err }, 'Failed to write active port file');
  }

  serverLog.info({ host: serverConfig.host, port: actualPort }, 'Server running');

  function clearActivePortFile() {
    try {
      const active = JSON.parse(readFileSync(activePortPath, 'utf-8')) as { pid?: number };
      // Never remove a marker written by a replacement backend.
      if (active.pid === process.pid) rmSync(activePortPath, { force: true });
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to clear active port file on shutdown',
      );
    }
  }

  // ─── Graceful Shutdown ──────────────────────────────────────────────────
  async function gracefulShutdown(signal: string) {
    serverLog.info({ signal }, 'Graceful shutdown');
    server.stop(true);
    clearActivePortFile();
    kory.cancel();
    shutdownAllBrokers();
    // Dispose the local auth manager so its session-cleanup interval is
    // cleared and the master key buffer is zeroed before exit.
    try {
      const { localAuth } = await import('./auth/local-auth');
      localAuth.dispose();
    } catch {
      /* ignore — auth module may not be loaded */
    }
    try {
      getDb().close();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((err) => {
  serverLog.fatal(err, 'Server startup failed');
  // Bootstrap may have started timers before Bun attempts its socket bind. A
  // failed bind must still terminate the process so the desktop launcher can
  // tear down the frontend instead of waiting for a backend that can never
  // become healthy.
  process.exit(1);
});
