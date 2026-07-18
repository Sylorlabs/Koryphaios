// Koryphaios Backend Server — Bun HTTP + WebSocket server.
// Main entry point via ElysiaJS.

import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { nanoid } from 'nanoid';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'bun';

import { bootstrap } from './bootstrap';
import { setContext } from './context';
import { serverLog } from './logger';
import { VERSION, ID, RATE_LIMIT, COMPAT } from './constants';
import { RateLimiter } from './security/rate-limit';
import { PROJECT_ROOT } from './runtime/paths';
import { resolveBundleHash, isBundleHashEnforced } from './config/compat';
import { createWebSocketHandlers } from './server/websocket-handler';
import type { WSClientData } from './ws/ws-manager';
import { validateLocalBearerToken } from './auth/local-route-auth';
import { serveMcp } from './mcp/koryphaios-mcp-endpoint';
import { getDb } from './db';
import { shutdownAllBrokers } from './pubsub';

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
import { feedbackRoutes } from './routes/v1/feedback';

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
  .use(feedbackRoutes);

export type App = typeof baseApp;

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

  // Setup actual running app with middleware
  const runningApp = new Elysia()
    .use(
      cors({
        origin: config.corsOrigins?.length ? config.corsOrigins : undefined,
      }),
    )
    .onRequest(({ request, set }) => {
      const url = new URL(request.url);

      // Never rate-limit the liveness endpoint. /api/health is used by the
      // Tauri supervisor (every 3s), the frontend sentinel (every 5s), and
      // the dev-mode launcher watchdog. Rate-limiting it would make those
      // monitoring loops unreliable — the whole point of the health endpoint
      // is to ALWAYS be reachable when the process is alive.
      if (url.pathname === '/api/health') return;

      const forwardedFor = request.headers.get('x-forwarded-for');
      // Direct requests to the loopback-only desktop backend have no client
      // address available through the Fetch Request API. They are all placed
      // in the old shared `local` bucket, so a normal busy UI could exhaust
      // 120 requests/minute and turn unrelated calls into 429s. Loopback is
      // the trust boundary for the desktop app, not an internet client.
      if (isLoopbackServer && !forwardedFor) return;

      const clientIp = (forwardedFor ?? 'local').split(',')[0].trim();
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

  const server = Bun.serve<WSClientData>({
    port: serverConfig.port,
    hostname: serverConfig.host,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // 1. WebSocket upgrade
      if (url.pathname === '/ws') {
        const protocols =
          req.headers
            .get('sec-websocket-protocol')
            ?.split(',')
            .map((s) => s.trim()) || [];
        // First protocol is usually 'koryphaios', second is the token
        const authToken = protocols.length > 1 ? protocols[1] : url.searchParams.get('auth');

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
        if (upgraded) return undefined;
        return new Response(JSON.stringify({ ok: false, error: 'WebSocket upgrade failed' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 1b. MCP endpoint — Koryphaios's own tools (notes/memory) for any
      // MCP-capable CLI harness (grok, claude-code, codex…).
      if (url.pathname === '/mcp') {
        return serveMcp(req, PROJECT_ROOT, (t) => !!validateLocalBearerToken(t));
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

      if (!filePath.startsWith(frontendBuildDir)) {
        return new Response('Forbidden', { status: 403 });
      }

      let file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }

      // 4. SPA Fallback (Routing handled by frontend)
      const indexHtml = Bun.file(join(frontendBuildDir, 'index.html'));
      if (await indexHtml.exists()) {
        return new Response(indexHtml);
      }

      // 5. Final Fallback
      return new Response('Not Found', { status: 404 });
    },
    websocket: createWebSocketHandlers({ wsManager, sessions, kory, providers }),
  });

  const clientHost = serverConfig.host === '0.0.0.0' ? '127.0.0.1' : serverConfig.host;
  const actualPort = server.port;
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
    } catch {
      // The marker is advisory; shutdown must still complete if it is absent or malformed.
    }
  }

  // ─── Graceful Shutdown ──────────────────────────────────────────────────
  async function gracefulShutdown(signal: string) {
    serverLog.info({ signal }, 'Graceful shutdown');
    server.stop(true);
    clearActivePortFile();
    kory.cancel();
    shutdownAllBrokers();
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
