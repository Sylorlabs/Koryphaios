// Koryphaios Backend Server — Bun HTTP + WebSocket server.
// Main entry point via ElysiaJS.

import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { nanoid } from 'nanoid';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'bun';

import { bootstrap } from './bootstrap';
import { setContext } from './context';
import { serverLog } from './logger';
import { VERSION, ID, RATE_LIMIT } from './constants';
import { RateLimiter } from './security/rate-limit';
import { PROJECT_ROOT } from './runtime/paths';
import { createWebSocketHandlers } from './server/websocket-handler';
import type { WSClientData } from './ws/ws-manager';
import { validateLocalBearerToken } from './auth/local-route-auth';
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
import { messagingRoutes } from './routes/v1/messaging';
import { processRoutes } from './routes/v1/processes';

// Define base Elysia App for export
const baseApp = new Elysia()
  .get('/api/health', () => ({
    ok: true,
    data: {
      version: VERSION,
      uptime: process.uptime(),
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
  .use(messagingRoutes)
  .use(processRoutes);

export type App = typeof baseApp;

async function main() {
  serverLog.info('═══════════════════════════════════════');
  serverLog.info(`       KORYPHAIOS v${VERSION}`);
  serverLog.info('  AI Agent Orchestration Dashboard');
  serverLog.info('═══════════════════════════════════════');

  // Bootstrap dependencies
  const ctx = await bootstrap();
  setContext(ctx);
  const { config, kory, providers, sessions, messages, wsManager, telegram, discord, slack } = ctx;

  const rateLimiter = new RateLimiter(RATE_LIMIT.MAX_REQUESTS, RATE_LIMIT.WINDOW_MS);

  // Setup actual running app with middleware
  const runningApp = new Elysia()
    .use(
      cors({
        origin: config.corsOrigins?.length ? config.corsOrigins : undefined,
      }),
    )
    .onRequest(({ request, set }) => {
      const clientIp = (request.headers.get('x-forwarded-for') ?? 'local').split(',')[0].trim();
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
  // Default to 127.0.0.1 for local-only security. 
  // User must explicitly override with 0.0.0.0 to expose to network.
  const serverConfig = {
    port: config.server?.port || 3001,
    host: config.server?.host || '127.0.0.1'
  };

  const server = Bun.serve<WSClientData>({
    port: serverConfig.port,
    hostname: serverConfig.host,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // 1. WebSocket upgrade
      if (url.pathname === '/ws') {
        const protocols = req.headers.get('sec-websocket-protocol')?.split(',').map(s => s.trim()) || [];
        // First protocol is usually 'koryphaios', second is the token
        const authToken = protocols.length > 1 ? protocols[1] : url.searchParams.get('auth');
        
        const authSession = validateLocalBearerToken(authToken);
        if (!authSession) {
          return new Response(JSON.stringify({ ok: false, error: 'Unauthorized WebSocket request' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const upgraded = srv.upgrade(req, {
          data: { id: nanoid(ID.WS_CLIENT_ID_LENGTH), userId: authSession.id },
          headers: protocols.length > 0 ? { 'Sec-WebSocket-Protocol': protocols[0] } : undefined
        });
        if (upgraded) return undefined;
        return new Response(JSON.stringify({ ok: false, error: 'WebSocket upgrade failed' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 2. API Routes
      if (url.pathname.startsWith('/api')) {
        return runningApp.handle(req);
      }

      // 3. Static Frontend Files
      const frontendBuildDir = resolve(join(PROJECT_ROOT, "frontend", "build", "client"));
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

  if (telegram && process.env.TELEGRAM_POLLING === 'true') {
    await telegram.startPolling();
  }

  if (discord) discord.start().catch((err) => serverLog.error({ err }, 'Discord bot failed'));
  if (slack) slack.start().catch((err) => serverLog.error({ err }, 'Slack bot failed'));

  // ─── Graceful Shutdown ──────────────────────────────────────────────────
  async function gracefulShutdown(signal: string) {
    serverLog.info({ signal }, 'Graceful shutdown');
    server.stop(true);
    kory.cancel();
    shutdownAllBrokers();
    try { getDb().close(); } catch (e) { /* ignore */ }
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((err) => serverLog.fatal(err, 'Server startup failed'));
