// Koryphaios Backend Server — Bun HTTP + WebSocket server.
// This is the main entry point that wires everything together.

import type { WSMessage, APIResponse, SendMessageRequest, CreateSessionRequest, StoredMessage, ProviderName } from "@koryphaios/shared";
import type { ServerWebSocket } from "bun";
import { ProviderRegistry } from "./providers";
import { startCopilotDeviceAuth, pollCopilotDeviceAuth } from "./providers/copilot";
import { ToolRegistry, BashTool, ShellManageTool, ReadFileTool, WriteFileTool, EditFileTool, GrepTool, GlobTool, LsTool, WebSearchTool, WebFetchTool, DeleteFileTool, MoveFileTool, DiffTool, PatchTool } from "./tools";
import { AskUserTool, AskManagerTool, DelegateToWorkerTool } from "./tools/interaction";
import { KoryManager } from "./kory/manager";
import { Bot } from "grammy";
import { TelegramBridge } from "./telegram/bot";
import { messagingGateway, sessionReplyStream } from "./messaging";
import { TelegramAdapter } from "./messaging";
import { MCPManager } from "./mcp/client";
import { wsBroker } from "./pubsub";
import { serverLog } from "./logger";
import { getCorsHeaders, addCorsOrigins, getSecurityHeaders, validateSessionId, validateProviderName, sanitizeString, encryptForStorage, RateLimiter, initializeEncryption } from "./security";
import { handleError, generateCorrelationId } from "./errors";
import { AUTH, SESSION, MESSAGE, ID, RATE_LIMIT, VERSION } from "./constants";
import { validateEnvironment, getAllowRegistration } from "./config-schema";
import { nanoid } from "nanoid";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { googleAuth } from "./providers/google-auth";
import { cliAuth } from "./providers/cli-auth";
import { initDb } from "./db/sqlite";
import { initCreditAccountant } from "./credit-accountant";

import { PROJECT_ROOT, BACKEND_ROOT } from "./runtime/paths";
import { loadConfig } from "./runtime/config";
import { persistEnvVar, clearEnvVar } from "./runtime/env";
import { SessionStore } from "./stores/session-store";
import { MessageStore } from "./stores/message-store";
import { WSManager, type WSClientData } from "./ws/ws-manager";

import { requireAuth } from "./middleware";
import { handleV1Routes } from "./routes/v1";
import { getMetricsRegistry } from "./metrics";
import { getReconciliation } from "./credit-accountant";
import { createUser, getOrCreateLocalUser } from "./auth";

// ─── Configuration Loading ──────────────────────────────────────────────────

// ─── Main Server ────────────────────────────────────────────────────────────

async function main() {
  serverLog.info("═══════════════════════════════════════");
  serverLog.info(`       KORYPHAIOS v${VERSION}`);
  serverLog.info("  AI Agent Orchestration Dashboard");
  serverLog.info("═══════════════════════════════════════");

  // Validate environment variables
  validateEnvironment();

  const config = loadConfig(PROJECT_ROOT);

  // Register any extra CORS origins from config
  if (config.corsOrigins?.length) {
    addCorsOrigins(config.corsOrigins);
    serverLog.info({ origins: config.corsOrigins }, "Registered extra CORS origins");
  }

  // Initialize SQLite Database (must complete before any request uses getDb())
  await initDb(join(PROJECT_ROOT, config.dataDirectory));

  // Initialize CreditAccountant (sylorlabs.db + optional polling)
  initCreditAccountant(join(PROJECT_ROOT, config.dataDirectory), {
    openaiApiKey: process.env.OPENAI_API_KEY,
    githubEnterpriseId: process.env.GITHUB_ENTERPRISE_ID,
    githubToken: process.env.GITHUB_TOKEN,
  });

  // Initialize envelope encryption (optional; legacy encryption used if this fails)
  try {
    await initializeEncryption();
    serverLog.info("Envelope encryption initialized");
  } catch (err: any) {
    serverLog.warn({ err: err?.message }, "Envelope encryption unavailable; API keys will use legacy encryption");
  }

  // Ensure local system user exists (no sign-in required)
  try {
    await getOrCreateLocalUser();
    serverLog.info("Local system user ready (no sign-in required)");
  } catch (err: any) {
    serverLog.error({ err }, "Failed to create local system user");
    throw err;
  }

  // Create default admin user only when explicitly enabled (e.g. first-time setup)
  const createDefaultAdmin = process.env.CREATE_DEFAULT_ADMIN === "true";
  if (createDefaultAdmin) {
    const { getDb } = await import("./db/sqlite");
    const userCount = (getDb().query("SELECT COUNT(*) as count FROM users").get() as any)?.count ?? 0;
    if (userCount === 0) {
      const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
      const isProduction = process.env.NODE_ENV === "production";
      if (isProduction && (!adminPassword || adminPassword.length < 16)) {
        serverLog.warn("CREATE_DEFAULT_ADMIN is true but ADMIN_INITIAL_PASSWORD is missing or too short in production (min 16 chars). Skipping default admin.");
      } else {
        const password = isProduction ? adminPassword! : (adminPassword ?? "admin");
        const adminUser = await createUser("admin", password, true);
        if ("id" in adminUser) {
          serverLog.info("Created default admin user (username: admin)");
          if (!isProduction) serverLog.warn("Set CREATE_DEFAULT_ADMIN=false and change the admin password in production.");
        }
      }
    }
  }

  // Initialize providers (auth hub)
  const providers = new ProviderRegistry(config);
  await providers.initializeEncryptedCredentials();

  // Initialize tools
  const tools = new ToolRegistry();
  tools.register(new BashTool());
  tools.register(new ShellManageTool());
  tools.register(new ReadFileTool());
  tools.register(new WriteFileTool());
  tools.register(new EditFileTool());
  tools.register(new DeleteFileTool());
  tools.register(new MoveFileTool());
  tools.register(new DiffTool());
  tools.register(new PatchTool());
  tools.register(new GrepTool());
  tools.register(new GlobTool());
  tools.register(new LsTool());
  tools.register(new WebSearchTool());
  tools.register(new WebFetchTool());
  tools.register(new AskUserTool());
  tools.register(new AskManagerTool());
  tools.register(new DelegateToWorkerTool());

  // Load local plugins
  await loadPlugins(tools);

  // Initialize MCP connections
  const mcpManager = new MCPManager();
  if (config.mcpServers) {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      await mcpManager.connectServer({
        name,
        transport: serverConfig.type,
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
        url: serverConfig.url,
        headers: serverConfig.headers,
      }, tools);
    }
    serverLog.info({ count: mcpManager.getStatus().length }, "MCP servers connected");
  }

  // Initialize sessions
  const sessions = new SessionStore();
  const messages = new MessageStore();

  // Initialize Kory
  const kory = new KoryManager(providers, tools, PROJECT_ROOT, config, sessions, messages);

  // Initialize WebSocket manager
  const wsManager = new WSManager();

  // Wire up pub/sub → WebSocket broadcast
  const wsStream = wsBroker.subscribe();
  const wsReader = wsStream.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await wsReader.read();
        if (done) break;
        wsManager.broadcast(value.payload, { sessionId: value.payload.sessionId });
      }
    } catch (err) {
      serverLog.error({ err }, "WebSocket pub/sub reader error");
    }
  })();

  // Messaging gateway + Telegram bridge (optional)
  let telegram: TelegramBridge | undefined;
  if (config.telegram?.botToken && config.telegram.adminId) {
    messagingGateway.start();
    const bot = new Bot(config.telegram.botToken);
    const telegramAdapter = new TelegramAdapter(bot);
    telegram = new TelegramBridge(
      {
        botToken: config.telegram.botToken,
        adminId: config.telegram.adminId,
        secretToken: config.telegram.secretToken,
      },
      kory,
      messagingGateway,
      telegramAdapter,
    );
    serverLog.info({ adminId: config.telegram.adminId }, "Telegram bridge enabled (replies stream to chat)");
  }

  // ─── HTTP + WebSocket Server ────────────────────────────────────────────

  const rateLimiter = new RateLimiter(RATE_LIMIT.MAX_REQUESTS, RATE_LIMIT.WINDOW_MS);
  const credentialRateLimiter = new RateLimiter(RATE_LIMIT.CREDENTIAL_PER_MINUTE, RATE_LIMIT.WINDOW_MS);
  const pendingAntigravityAuth = new Map<string, Promise<{ success: boolean; token?: string; error?: string }>>();

  const server = Bun.serve<WSClientData>({
    port: config.server.port,
    hostname: config.server.host,

    async fetch(req, server) {
      const url = new URL(req.url);
      const method = req.method;
      const origin = req.headers.get("origin");
      const requestId = generateCorrelationId();

      try {
        serverLog.debug({ requestId, method, path: url.pathname }, "Incoming request");

        // Guard against path traversal sequences that may be normalized by URL parsing.
        if (req.url.includes("/api/sessions/") && req.url.includes("..")) {
          const corsHeaders = getCorsHeaders(origin);
          return json({ ok: false, error: "Invalid session ID" }, 400, corsHeaders);
        }

        // CORS — origin allowlist (not *)
        const corsHeaders = { ...getCorsHeaders(origin), ...getSecurityHeaders() };

        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Rate limiting (IP; per-user applied on critical authenticated routes)
        const clientIp = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
          return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
        }

        // ── WebSocket upgrade (session cookie or Bearer or query param) ──
        if (url.pathname === "/ws") {
          const userId = (await getOrCreateLocalUser()).id;
          const upgraded = server.upgrade(req, {
            data: { id: nanoid(ID.WS_CLIENT_ID_LENGTH), userId },
          });
          if (upgraded) return undefined;
          return json({ ok: false, error: "WebSocket upgrade failed" }, 400, corsHeaders);
        }

        // ── Telegram webhook ──
        if (url.pathname === "/api/telegram/webhook" && telegram) {
          try {
            const handler = telegram.getWebhookHandler();
            return await handler(req);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        // ── REST API Routes ──

        // Agent steering (authenticated)
        if (url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/cancel") && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const agentId = url.pathname.replace("/api/agents/", "").replace("/cancel", "");
          kory.cancelWorker(agentId);
          return json({ ok: true }, 200, corsHeaders);
        }

        // Metrics endpoint (Prometheus)
        if (url.pathname === "/metrics" && method === "GET") {
          return withCors(getMetricsRegistry().handleMetrics(), corsHeaders);
        }

        // Current user endpoint — always returns local system user (no sign-in required)
        if (url.pathname === "/api/auth/me" && method === "GET") {
          try {
            const user = await getOrCreateLocalUser();
            return json({ ok: true, data: { user } }, 200, corsHeaders);
          } catch (err: any) {
            serverLog.error({ err }, "GET /api/auth/me failed");
            return json({ ok: false, error: "Auth unavailable", detail: err?.message ?? String(err) }, 500, corsHeaders);
          }
        }

        // Billing / credits (local estimate vs cloud reality, drift) — same shape as v1
        if (url.pathname === "/api/billing/credits" && method === "GET") {
          try {
            const data = getReconciliation();
            return json(
              {
                localEstimate: data.localEstimate,
                cloudReality: data.cloudReality,
                driftPercent: data.driftPercent,
                highlightDrift: data.highlightDrift,
              },
              200,
              corsHeaders
            );
          } catch (err: any) {
            serverLog.error({ err }, "Failed to get billing credits");
            return json({ error: "Failed to get billing credits" }, 500, corsHeaders);
          }
        }

        // Health check endpoint (minimal for public/lb)
        if (url.pathname === "/health" && method === "GET") {
          return json({ ok: true, data: { version: VERSION } }, 200, corsHeaders);
        }

        // API v1 Routes (Credentials, API Keys, Audit)
        if (url.pathname.startsWith("/api/v1/")) {
          const v1Response = await handleV1Routes(req, url.pathname, method);
          if (v1Response) {
            // Add CORS headers to v1 responses
            const headers: Record<string, string> = {};
            v1Response.headers.forEach((value, key) => {
              headers[key] = value;
            });
            Object.entries(corsHeaders).forEach(([key, value]) => {
              if (!headers[key]) headers[key] = value;
            });
            return new Response(v1Response.body, {
              status: v1Response.status,
              headers,
            });
          }
        }

        // Sessions (Authenticated)
        if (url.pathname === "/api/sessions" && method === "GET") {
          let auth: Awaited<ReturnType<typeof requireAuth>>;
          try {
            auth = await requireAuth(req);
          } catch (err: any) {
            serverLog.error({ err }, "Auth failed in GET /api/sessions");
            return json({ ok: false, error: "Authentication failed" }, 503, corsHeaders);
          }
          if ("error" in auth) return withCors(auth.error, corsHeaders);

          try {
            const data = sessions.listForUser(auth.user.id);
            return json({ ok: true, data }, 200, corsHeaders);
          } catch (err: any) {
            serverLog.error({ err }, "Error fetching sessions");
            return json(
              { ok: false, error: "Failed to fetch sessions", detail: err?.message ?? String(err) },
              500,
              corsHeaders
            );
          }
        }

        if (url.pathname === "/api/sessions" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const userRate = rateLimiter.check(`user:${auth.user.id}`);
          if (!userRate.allowed) return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);

          const parsed = await parseJson<CreateSessionRequest>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          try {
            const title = sanitizeString(body.title, SESSION.MAX_TITLE_LENGTH);
            const session = sessions.create(auth.user.id, title ?? undefined, body.parentSessionId);
            return json({ ok: true, data: session }, 201, corsHeaders);
          } catch (err: any) {
            serverLog.error({ err }, "Error creating session");
            return json({ ok: false, error: "Failed to create session" }, 500, corsHeaders);
          }
        }

        // Session by ID routes — parse path segments (Authenticated)
        if (url.pathname.startsWith("/api/sessions/")) {
          const segments = url.pathname.split("/");
          const id = segments[3];
          const subResource = segments[4]; // "messages", "auto-title", or undefined

          if (!id) return json({ ok: false, error: "Session ID required" }, 400, corsHeaders);
          const validatedId = validateSessionId(id);
          if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400, corsHeaders);

          // All session operations require authentication
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);

          // Verify session ownership
          const session = sessions.getForUser(validatedId, auth.user.id);
          if (!session && subResource !== "messages") {
            return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
          }

          // GET /api/sessions/:id/messages — fetch message history
          if (subResource === "messages" && method === "GET") {
            if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
            const sessionMessages = messages.getAll(validatedId);
            return json({ ok: true, data: sessionMessages }, 200, corsHeaders);
          }

          // POST /api/sessions/:id/auto-title — generate title from first message
          if (subResource === "auto-title" && method === "POST") {
            if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
            const sessionMessages = messages.getAll(validatedId);
            const firstUserMsg = sessionMessages.find(m => m.role === "user");
            if (firstUserMsg) {
              const rawTitle = firstUserMsg.content.replace(/\n/g, " ").trim();
              const title = rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
              const updated = sessions.update(validatedId, { title });
              if (updated) {
                wsManager.broadcast({
                  type: "session.updated",
                  payload: { session: updated },
                  timestamp: Date.now(),
                  sessionId: validatedId,
                } satisfies WSMessage);
              }
              return json({ ok: true, data: { title } }, 200, corsHeaders);
            }
            return json({ ok: true, data: { title: "New Session" } }, 200, corsHeaders);
          }

          // No sub-resource — operate on session itself
          if (!subResource) {
            if (method === "GET") {
              if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
              return json({ ok: true, data: session }, 200, corsHeaders);
            }

            if (method === "PATCH") {
              if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
              const parsed = await parseJson<{ title?: string }>(req, corsHeaders);
              if (!parsed.ok) return parsed.res;
              const body = parsed.data;
              const title = sanitizeString(body.title, SESSION.MAX_TITLE_LENGTH);
              if (!title) return json({ ok: false, error: "title is required" }, 400, corsHeaders);
              const updated = sessions.update(validatedId, { title });
              if (!updated) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
              wsManager.broadcast({
                type: "session.updated",
                payload: { session: updated },
                timestamp: Date.now(),
                sessionId: validatedId,
              } satisfies WSMessage);
              return json({ ok: true, data: updated }, 200, corsHeaders);
            }

            if (method === "DELETE") {
              if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
              kory.cancelSessionWorkers(validatedId);
              sessions.deleteForUser(validatedId, auth.user.id);
              wsManager.broadcast({
                type: "session.deleted",
                payload: { sessionId: id },
                timestamp: Date.now(),
                sessionId: validatedId,
              } satisfies WSMessage);
              return json({ ok: true }, 200, corsHeaders);
            }
          }

          // GET /api/sessions/:id/running — check if session is running (manager or workers)
          if (subResource === "running" && method === "GET") {
            if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
            return json({ ok: true, data: { running: kory.isSessionRunning(validatedId) } }, 200, corsHeaders);
          }

          // POST /api/sessions/:id/cancel — stop manager and all workers for this session
          if (subResource === "cancel" && method === "POST") {
            if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
            kory.cancelSessionWorkers(validatedId);
            return json({ ok: true }, 200, corsHeaders);
          }
        }

        // Send message (trigger Kory) — requires authentication
        if (url.pathname === "/api/messages" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const userRate = rateLimiter.check(`user:${auth.user.id}`);
          if (!userRate.allowed) return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);

          const parsed = await parseJson<SendMessageRequest>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          const sessionId = validateSessionId(body.sessionId);
          const content = sanitizeString(body.content, MESSAGE.MAX_CONTENT_LENGTH);

          if (!sessionId || !content) {
            return json({ ok: false, error: "Valid sessionId and content are required" }, 400, corsHeaders);
          }

          // Session must exist and belong to the authenticated user (or we create one for them)
          let session = sessions.getForUser(sessionId, auth.user.id);
          let activeSessionId = sessionId;
          if (!session) {
            const existing = sessions.get(sessionId);
            if (existing) {
              return json({ ok: false, error: "Session not found or access denied" }, 404, corsHeaders);
            }
            session = sessions.create(auth.user.id, SESSION.DEFAULT_TITLE);
            activeSessionId = session.id;
          }

          // Persist user message
          const userMsg: StoredMessage = {
            id: nanoid(ID.SESSION_ID_LENGTH),
            sessionId: activeSessionId,
            role: "user",
            content,
            createdAt: Date.now(),
          };
          messages.add(activeSessionId, userMsg);
          sessions.update(activeSessionId, {
            messageCount: (session.messageCount ?? 0) + 1,
          });

          // Auto-title on first message
          if (session.messageCount === 0 || session.title === SESSION.DEFAULT_TITLE) {
            const rawTitle = content.replace(/\n/g, " ").trim();
            const title = rawTitle.length > SESSION.AUTO_TITLE_CHARS
              ? rawTitle.slice(0, SESSION.AUTO_TITLE_CHARS - 3) + "..."
              : rawTitle;
            sessions.update(activeSessionId, { title });
            wsManager.broadcast({
              type: "session.updated",
              payload: { session: sessions.get(activeSessionId) },
              timestamp: Date.now(),
              sessionId: activeSessionId,
            } satisfies WSMessage);
          }

          // Process async — results stream via WebSocket
          kory.processTask(activeSessionId, content, body.model, body.reasoningLevel)
            .then(() => {
              serverLog.debug({ sessionId: activeSessionId }, "Task completed successfully");
            })
            .catch((err) => {
              serverLog.error({ sessionId: activeSessionId, error: err }, "Error processing request");
              wsManager.broadcast({
                type: "system.error",
                payload: { error: err.message },
                timestamp: Date.now(),
                sessionId: activeSessionId,
              });
            });

          return json({ ok: true, data: { sessionId: activeSessionId, status: "processing" } }, 202, corsHeaders);
        }

        // All provider types that can be added (for "Add provider" UI; no auth filter)
        if (url.pathname === "/api/providers/available" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          return json({ ok: true, data: providers.getAvailableProviderTypes() }, 200, corsHeaders);
        }

        // Provider status — only providers the user has authenticated (no hardcoded list)
        if (url.pathname === "/api/providers" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          return json({ ok: true, data: await providers.getStatus() }, 200, corsHeaders);
        }

        // Start Copilot browser device auth flow (authenticated)
        if (url.pathname === "/api/providers/copilot/device/start" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          try {
            const start = await startCopilotDeviceAuth();
            return json({ ok: true, data: start }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message ?? "Failed to start Copilot auth" }, 400, corsHeaders);
          }
        }

        // Poll Copilot device auth and finalize connection (authenticated)
        if (url.pathname === "/api/providers/copilot/device/poll" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ deviceCode?: string }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          const deviceCode = sanitizeString(body.deviceCode, 300);
          if (!deviceCode) {
            return json({ ok: false, error: "deviceCode is required" }, 400, corsHeaders);
          }

          try {
            const poll = await pollCopilotDeviceAuth(deviceCode);
            if (poll.error) {
              // Standard pending/slow_down/expired_token responses
              return json({ ok: true, data: { status: poll.error, description: poll.errorDescription } }, 200, corsHeaders);
            }
            if (!poll.accessToken) {
              return json({ ok: false, error: "No access token returned from GitHub" }, 400, corsHeaders);
            }

            const result = providers.setCredentials("copilot", { authToken: poll.accessToken });
            if (!result.success) {
              return json({ ok: false, error: result.error }, 400, corsHeaders);
            }

            const verification = await providers.verifyConnection("copilot", { authToken: poll.accessToken });
            if (!verification.success) {
              providers.removeApiKey("copilot");
              return json({ ok: false, error: verification.error ?? "Copilot verification failed" }, 400, corsHeaders);
            }

            persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar("copilot", "authToken"), await encryptForStorage(poll.accessToken));
            providers.refreshProvider("copilot");

            wsManager.broadcast({
              type: "provider.status",
              payload: { providers: await providers.getStatus() },
              timestamp: Date.now(),
            } satisfies WSMessage);

            return json({ ok: true, data: { status: "connected" } }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message ?? "Failed to complete Copilot auth" }, 400, corsHeaders);
          }
        }

        // Google/Gemini Auth Routes (authenticated)
        if (url.pathname === "/api/providers/google/auth/cli" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          try {
            const result = await googleAuth.startGeminiCLIAuth();
            return json({ ok: true, data: result }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        if (url.pathname === "/api/providers/google/auth/antigravity" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          try {
            const startResult = await googleAuth.startAntigravityAuth();
            const authId = nanoid();

            // Start listener in background and store the promise
            const promise = googleAuth.waitForAntigravityCallback();
            pendingAntigravityAuth.set(authId, promise);

            // Auto-clean after 6 minutes
            setTimeout(() => pendingAntigravityAuth.delete(authId), 360_000);

            return json({ ok: true, data: { ...startResult, authId } }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        if (url.pathname === "/api/providers/google/auth/antigravity/poll" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const authId = url.searchParams.get("authId");
          if (!authId || !pendingAntigravityAuth.has(authId)) {
            return json({ ok: false, error: "Invalid or expired auth session" }, 404, corsHeaders);
          }

          try {
            const result = await pendingAntigravityAuth.get(authId);
            pendingAntigravityAuth.delete(authId);

            if (result?.success && result.token) {
              const setResult = providers.setCredentials("google", { authToken: result.token });
              if (!setResult.success) {
                return json({ ok: false, error: setResult.error ?? "Failed to store Google token" }, 400, corsHeaders);
              }
              persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar("google", "authToken"), await encryptForStorage(result.token));
              providers.refreshProvider("google");
              wsManager.broadcast({
                type: "provider.status",
                payload: { providers: await providers.getStatus() },
                timestamp: Date.now(),
              } satisfies WSMessage);
              return json({ ok: true, data: { success: true } }, 200, corsHeaders);
            } else if (result?.success) {
              return json({ ok: true, data: { success: true } }, 200, corsHeaders);
            } else {
              return json({ ok: false, error: result?.error || "Authentication failed" }, 400, corsHeaders);
            }
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        // Set provider credentials (authenticated, rate-limited)
        if (url.pathname.startsWith("/api/providers/") && method === "PUT") {
          const credLimit = credentialRateLimiter.check(`cred:${clientIp}`);
          if (!credLimit.allowed) return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const rawName = url.pathname.split("/")[3];
          const providerName = validateProviderName(rawName);
          if (!providerName) {
            return json({ ok: false, error: `Invalid provider name: ${rawName ?? "missing"}` }, 400, corsHeaders);
          }

          const parsed = await parseJson<{ apiKey?: string; authToken?: string; baseUrl?: string; selectedModels?: string[]; hideModelSelector?: boolean; authMode?: string }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;

          try {
          // Allow long API keys (e.g. JWT, multi-line keys); do not truncate
          const apiKey = sanitizeString(body.apiKey, 8192);
          const authToken = sanitizeString(body.authToken, 8192);
          const baseUrl = sanitizeString(body.baseUrl, 2048);
          const authMode = sanitizeString(body.authMode, 50);

          // Handle special CLI auth modes (gemini cli, antigravity)
          if (authMode === "cli" || authMode === "antigravity") {
            const cliName = authMode === "antigravity" ? "antigravity" : "gemini";
            const targetProvider = (authMode === "antigravity" ? "google" : "google") as ProviderName;

            // Verify CLI is installed and accessible (for CLI-based auth)
            if (!Bun.which(cliName)) {
              return json({ ok: false, error: `${cliName} CLI not found in PATH. Install it first.` }, 400, corsHeaders);
            }

            // Mark provider as CLI-authenticated temporarily to verify
            const authValue = authMode === "antigravity" ? "cli:antigravity" : "cli:gemini";

            const verification = await providers.verifyConnection(targetProvider, {
              authToken: authValue
            });

            if (!verification.success) {
              return json({ ok: false, error: verification.error || `${cliName} CLI auth failed` }, 400, corsHeaders);
            }

            // Verification passed, set and persist
            const result = providers.setCredentials(targetProvider, {
              authToken: authValue,
            });

            if (!result.success) {
              return json({ ok: false, error: result.error }, 400, corsHeaders);
            }

            persistEnvVar(
              PROJECT_ROOT,
              providers.getExpectedEnvVar(targetProvider, "authToken"),
              authValue,
            );

            wsManager.broadcast({
              type: "provider.status",
              payload: { providers: await providers.getStatus() },
              timestamp: Date.now(),
            } satisfies WSMessage);

            return json({ ok: true, data: { provider: targetProvider, status: "connected", authMode } }, 200, corsHeaders);
          }

          const isPreferencesOnlyUpdate =
            !apiKey &&
            !authToken &&
            !baseUrl &&
            (body.selectedModels !== undefined || body.hideModelSelector !== undefined);

          const result = providers.setCredentials(providerName, {
            ...(apiKey && { apiKey }),
            ...(authToken && { authToken }),
            ...(baseUrl && { baseUrl }),
            ...(body.selectedModels && { selectedModels: body.selectedModels }),
            ...(body.hideModelSelector !== undefined && { hideModelSelector: body.hideModelSelector }),
          });
          if (!result.success) {
            return json({ ok: false, error: result.error }, 400, corsHeaders);
          }

          if (!isPreferencesOnlyUpdate) {
            const verification = await providers.verifyConnection(providerName, {
              ...(apiKey && { apiKey }),
              ...(authToken && { authToken }),
              ...(baseUrl && { baseUrl }),
            });
            if (!verification.success) {
              providers.removeApiKey(providerName);
              return json({ ok: false, error: verification.error ?? "Provider verification failed" }, 400, corsHeaders);
            }
          }

          if (apiKey) {
            persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "apiKey"), await encryptForStorage(apiKey));
          }
          if (authToken) {
            persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "authToken"), await encryptForStorage(authToken));
          }
          if (baseUrl) {
            persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "baseUrl"), baseUrl);
          }

          // Broadcast updated provider status via WebSocket
          wsManager.broadcast({
            type: "provider.status",
            payload: { providers: await providers.getStatus() },
            timestamp: Date.now(),
          } satisfies WSMessage);

          return json({ ok: true, data: { provider: providerName, status: "connected" } }, 200, corsHeaders);
          } catch (err: any) {
            serverLog.error({ err, provider: rawName }, "Set provider credentials failed");
            return json({ ok: false, error: err?.message ?? "Failed to set provider credentials" }, 500, corsHeaders);
          }
        }

        // ─── Git Integration (authenticated) ───

        // Status
        if (url.pathname === "/api/git/status" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          try {
            const status = await kory.git.getStatus();
            const branch = await kory.git.getBranch();
            return json({ ok: true, data: { status, branch } }, 200, corsHeaders);
          } catch (err: any) {
            serverLog.error({ err }, "GET /api/git/status failed");
            return json({ ok: false, error: "Git status failed", detail: err?.message ?? String(err) }, 500, corsHeaders);
          }
        }

        // Diff
        if (url.pathname === "/api/git/diff" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const file = url.searchParams.get("file");
          const staged = url.searchParams.get("staged") === "true";
          if (!file) return json({ ok: false, error: "file parameter required" }, 400, corsHeaders);
          if (!kory.git.resolvePathUnderRepo(file)) return json({ ok: false, error: "Invalid file path" }, 400, corsHeaders);
          const diff = await kory.git.getDiff(file, staged);
          return json({ ok: true, data: { diff } }, 200, corsHeaders);
        }

        // Stage/Unstage
        if (url.pathname === "/api/git/stage" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ file: string; unstage?: boolean }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          if (!body.file) return json({ ok: false, error: "file required" }, 400, corsHeaders);
          if (!kory.git.resolvePathUnderRepo(body.file)) return json({ ok: false, error: "Invalid file path" }, 400, corsHeaders);
          const success = body.unstage
            ? await kory.git.unstageFile(body.file)
            : await kory.git.stageFile(body.file);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        // Restore (Discard)
        if (url.pathname === "/api/git/restore" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ file: string }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          if (!body.file) return json({ ok: false, error: "file required" }, 400, corsHeaders);
          if (!kory.git.resolvePathUnderRepo(body.file)) return json({ ok: false, error: "Invalid file path" }, 400, corsHeaders);
          const success = await kory.git.restoreFile(body.file);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        // Commit
        if (url.pathname === "/api/git/commit" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ message: string }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          if (!body.message) return json({ ok: false, error: "message required" }, 400, corsHeaders);
          const message = sanitizeString(body.message, 2000);
          if (!message) return json({ ok: false, error: "message required" }, 400, corsHeaders);
          const success = await kory.git.commit(message);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        // Branches
        if (url.pathname === "/api/git/branches" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const branches = await kory.git.getBranches();
          return json({ ok: true, data: { branches } }, 200, corsHeaders);
        }

        // Checkout
        if (url.pathname === "/api/git/checkout" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ branch: string; create?: boolean }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          if (!body.branch) return json({ ok: false, error: "branch required" }, 400, corsHeaders);
          const { GitManager } = await import("./kory/git-manager");
          if (!GitManager.validateBranchName(body.branch)) return json({ ok: false, error: "Invalid branch name" }, 400, corsHeaders);
          const success = await kory.git.checkout(body.branch, body.create);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        // Merge
        if (url.pathname === "/api/git/merge" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ branch: string }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          if (!body.branch) return json({ ok: false, error: "branch required" }, 400, corsHeaders);
          const { GitManager } = await import("./kory/git-manager");
          if (!GitManager.validateBranchName(body.branch)) return json({ ok: false, error: "Invalid branch name" }, 400, corsHeaders);
          const result = await kory.git.merge(body.branch);
          const conflicts = result.hasConflicts ? await kory.git.getConflicts() : [];
          return json({ ok: result.success, data: { output: result.output, conflicts, hasConflicts: result.hasConflicts } }, 200, corsHeaders);
        }

        // Push
        if (url.pathname === "/api/git/push" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const result = await kory.git.push();
          return json({ ok: result.success, error: result.output }, result.success ? 200 : 500, corsHeaders);
        }

        // Pull
        if (url.pathname === "/api/git/pull" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const result = await kory.git.pull();
          const hasConflicts = result.output.includes("CONFLICT") || result.output.includes("Automatic merge failed");
          const conflicts = hasConflicts ? await kory.git.getConflicts() : [];
          return json({ ok: result.success, data: { output: result.output, conflicts, hasConflicts } }, 200, corsHeaders);
        }

        // Set worker assignments (authenticated)
        if (url.pathname === "/api/assignments" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          return json({ ok: true, data: { assignments: config.assignments ?? {} } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/assignments" && method === "PUT") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{ assignments: Record<string, string> }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;
          if (!body.assignments || typeof body.assignments !== "object") {
            return json({ ok: false, error: "assignments object is required" }, 400, corsHeaders);
          }

          // Update config in memory
          config.assignments = { ...config.assignments, ...body.assignments };

          // Persist to koryphaios.json if it exists
          const configPath = join(PROJECT_ROOT, "koryphaios.json");
          try {
            let currentConfig: any = {};
            if (existsSync(configPath)) {
              currentConfig = JSON.parse(readFileSync(configPath, "utf-8"));
            }
            currentConfig.assignments = config.assignments;
            writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
            serverLog.info("Updated worker assignments in koryphaios.json");
          } catch (err) {
            serverLog.warn({ err }, "Failed to persist assignments to koryphaios.json");
          }

          return json({ ok: true, data: { assignments: config.assignments } }, 200, corsHeaders);
        }

        // Messaging config (GET: current state; PUT: update and persist)
        if (url.pathname === "/api/messaging" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const t = config.telegram;
          const data = {
            telegram: t
              ? {
                  enabled: true,
                  adminId: t.adminId,
                  botTokenSet: !!t.botToken,
                  webhookUrl: t.webhookUrl,
                }
              : { enabled: false, adminId: 0, botTokenSet: false, webhookUrl: undefined },
          };
          return json({ ok: true, data }, 200, corsHeaders);
        }

        if (url.pathname === "/api/messaging" && method === "PUT") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const parsed = await parseJson<{
            telegram?: { botToken?: string; adminId?: number; secretToken?: string; webhookUrl?: string };
          }>(req, corsHeaders);
          if (!parsed.ok) return parsed.res;
          const body = parsed.data;

          if (body.telegram !== undefined) {
            const t = body.telegram;
            if (t === null) {
              config.telegram = undefined;
            } else if (typeof t === "object") {
              config.telegram = {
                botToken: t.botToken ?? config.telegram?.botToken ?? "",
                adminId: typeof t.adminId === "number" ? t.adminId : config.telegram?.adminId ?? 0,
                secretToken: t.secretToken ?? config.telegram?.secretToken,
                webhookUrl: t.webhookUrl ?? config.telegram?.webhookUrl,
              };
            }
          }

          const configPath = join(PROJECT_ROOT, "koryphaios.json");
          try {
            let currentConfig: Record<string, unknown> = {};
            if (existsSync(configPath)) {
              currentConfig = JSON.parse(readFileSync(configPath, "utf-8"));
            }
            currentConfig.telegram = config.telegram ?? null;
            writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
            serverLog.info("Updated messaging config in koryphaios.json");
          } catch (err) {
            serverLog.warn({ err }, "Failed to persist messaging config to koryphaios.json");
          }

          return json({
            ok: true,
            data: {
              telegram: config.telegram
                ? { enabled: true, adminId: config.telegram.adminId, botTokenSet: !!config.telegram.botToken }
                : { enabled: false },
            },
          }, 200, corsHeaders);
        }

        // Remove provider API key (authenticated)
        if (url.pathname.startsWith("/api/providers/") && method === "DELETE") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const rawName = url.pathname.split("/")[3];
          const providerName = validateProviderName(rawName);
          if (!providerName) {
            return json({ ok: false, error: "Invalid provider name" }, 400, corsHeaders);
          }
          providers.removeApiKey(providerName);
          clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "apiKey"));
          clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "authToken"));
          clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "baseUrl"));

          // Persist provider disconnect state so auto-detected CLI/env auth does not
          // immediately re-enable on next restart unless user explicitly reconnects.
          try {
            config.providers = config.providers ?? {};
            const existing = config.providers[providerName as keyof typeof config.providers] ?? { name: providerName };
            config.providers[providerName as keyof typeof config.providers] = {
              ...existing,
              name: providerName,
              apiKey: undefined,
              authToken: undefined,
              baseUrl: undefined,
              disabled: true,
            } as any;

            const configPath = join(PROJECT_ROOT, "koryphaios.json");
            if (existsSync(configPath)) {
              const currentConfig = JSON.parse(readFileSync(configPath, "utf-8"));
              currentConfig.providers = currentConfig.providers ?? {};
              currentConfig.providers[providerName] = {
                ...(currentConfig.providers[providerName] ?? {}),
                name: providerName,
                disabled: true,
              };
              delete currentConfig.providers[providerName].apiKey;
              delete currentConfig.providers[providerName].authToken;
              delete currentConfig.providers[providerName].baseUrl;
              writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
            }
          } catch (err) {
            serverLog.warn({ provider: providerName, err }, "Failed to persist provider disconnect state");
          }

          wsManager.broadcast({
            type: "provider.status",
            payload: { providers: await providers.getStatus() },
            timestamp: Date.now(),
          } satisfies WSMessage);

          return json({ ok: true }, 200, corsHeaders);
        }

        // Agent status (authenticated)
        if (url.pathname === "/api/agents/status" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          return json({ ok: true, data: { workers: kory.getStatus() } }, 200, corsHeaders);
        }

        // Cancel all (authenticated)
        if (url.pathname === "/api/agents/cancel" && method === "POST") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          kory.cancel();
          return json({ ok: true }, 200, corsHeaders);
        }

        // Health check
        if (url.pathname === "/api/health") {
          return json({
            ok: true,
            data: {
              version: VERSION,
              uptime: process.uptime(),
              providers: providers.getAvailable().length,
              wsClients: wsManager.clientCount,
              allowRegistration: getAllowRegistration(),
            },
          }, 200, corsHeaders);
        }

        // Channel reply stream (SSE) for a single session — for bridge devices
        if (url.pathname === "/api/channels/replies" && method === "GET") {
          const auth = await requireAuth(req);
          if ("error" in auth) return withCors(auth.error, corsHeaders);
          const sessionId = url.searchParams.get("sessionId")?.trim();
          if (!sessionId) {
            return json({ ok: false, error: "sessionId required" }, 400, corsHeaders);
          }
          const stream = sessionReplyStream.getStream(sessionId);
          const encoder = new TextEncoder();
          const s = new ReadableStream({
            start(controller) {
              const reader = stream.getReader();
              (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
                  }
                } catch {
                  // Client disconnected or stream closed
                } finally {
                  controller.close();
                }
              })();
            },
          });
          return new Response(s, {
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        // SSE endpoint (same events as WebSocket)
        if (url.pathname === "/api/events") {
          const userId = (await getOrCreateLocalUser()).id;
          const abortController = new AbortController();
          const sub = wsBroker.subscribe(abortController.signal);
          const reader = sub.getReader();
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const data = `data: ${JSON.stringify(value.payload)}\n\n`;
                    controller.enqueue(encoder.encode(data));
                  }
                } catch {
                  // Client disconnected or stream closed
                } finally {
                  controller.close();
                }
              })();
            },
            cancel() {
              abortController.abort();
              reader.cancel().catch(() => { });
            },
          });

          return new Response(stream, {
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          });
        }

        return json({ ok: false, error: "Not found" }, 404, corsHeaders);
      } catch (err) {
        const handled = handleError(err, {
          requestId,
          method,
          path: url.pathname,
          query: url.search,
        });
        const corsHeaders = getCorsHeaders(origin);
        return json(
          { ok: false, error: `${handled.message} (requestId=${requestId})` },
          handled.statusCode,
          corsHeaders,
        );
      }
    },

    websocket: {
      open(ws: ServerWebSocket<WSClientData>) {
        try {
          wsManager.add(ws);
          serverLog.info({ clientId: ws.data.id, clients: wsManager.clientCount }, "WS client connected");

          // Send initial state
          try {
            const initialStatus = providers.getStatus();
            ws.send(JSON.stringify({
              type: "provider.status",
              payload: { providers: initialStatus },
              timestamp: Date.now(),
            } satisfies WSMessage));
          } catch (err) {
            handleError(err, { event: "ws.open.init_status", clientId: ws?.data?.id });
          }

        } catch (err) {
          handleError(err, { event: "ws.open", clientId: ws?.data?.id });
        }
      },

      message(ws: ServerWebSocket<WSClientData>, message: string | Buffer) {
        try {
          const msg = JSON.parse(String(message));
          const userId = ws.data.userId;

          const assertSessionOwnership = (sessionId: string): boolean => {
            if (!sessionId || !validateSessionId(sessionId)) return false;
            const session = sessions.getForUser(sessionId, userId);
            return !!session;
          };

          if (msg.type === "subscribe_session") {
            const sessionId = msg.sessionId;
            if (sessionId && validateSessionId(sessionId) && sessions.getForUser(sessionId, userId)) {
              wsManager.subscribeClientToSession(ws.data.id, sessionId);
            }
          } else if (msg.type === "user_input") {
            if (assertSessionOwnership(msg.sessionId)) {
              kory.handleUserInput(msg.sessionId, msg.selection, msg.text);
            }
          } else if (msg.type === "session.accept_changes") {
            if (assertSessionOwnership(msg.sessionId)) {
              kory.handleSessionResponse(msg.sessionId, true);
            }
          } else if (msg.type === "session.reject_changes") {
            if (assertSessionOwnership(msg.sessionId)) {
              kory.handleSessionResponse(msg.sessionId, false);
            }
          } else if (msg.type === "toggle_yolo") {
            kory.setYoloMode(!!msg.enabled);
          }
        } catch (err) {
          handleError(err, { event: "ws.message", clientId: ws?.data?.id, raw: String(message).slice(0, 500) });
        }
      },

      close(ws: ServerWebSocket<WSClientData>) {
        wsManager.remove(ws);
        serverLog.info({ clients: wsManager.clientCount }, "WS client disconnected");
      },
    },
  });

  serverLog.info({ host: config.server.host, port: config.server.port }, "Server running");
  serverLog.info({ url: `ws://${config.server.host}:${config.server.port}/ws` }, "WebSocket ready");
  serverLog.info({ url: `http://${config.server.host}:${config.server.port}/api/events` }, "SSE fallback ready");

  if (telegram && process.env.TELEGRAM_POLLING === "true") {
    await telegram.startPolling();
  }

  // ─── Graceful Shutdown ──────────────────────────────────────────────────

  let isShuttingDown = false;

  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
      serverLog.warn("Shutdown already in progress, forcing exit");
      process.exit(1);
    }

    isShuttingDown = true;
    serverLog.info({ signal }, "Received shutdown signal, starting graceful shutdown");

    try {
      // 1. Stop accepting new connections
      server.stop(true);
      serverLog.info("Server stopped accepting new connections");

      // 2. Cancel all running agents
      kory.cancel();
      serverLog.info("Cancelled all running agents");

      // 3. Close WebSocket connections gracefully
      wsManager.broadcast({
        type: "system.info",
        payload: { message: "Server shutting down" },
        timestamp: Date.now(),
      });
      serverLog.info("Notified WebSocket clients");

      // 4. Wait a moment for final messages to send
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 5. Shut down pub/sub broker
      wsBroker.shutdown();

      // 5b. Stop messaging gateway
      messagingGateway.stop();

      // 6. Clean up rate limiter
      rateLimiter.destroy();

      serverLog.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      serverLog.error(err, "Error during graceful shutdown");
      process.exit(1);
    }
  }

  // Register shutdown handlers
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    serverLog.fatal(err, "Uncaught exception");
    gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    serverLog.error({ reason }, "Unhandled promise rejection (server will continue)");
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data: APIResponse, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

/** Merge CORS headers into a Response so cross-origin clients (e.g. dev frontend) can read it. */
function withCors(res: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

/** Parse JSON body with size limit; on failure return 400 Response. Caller must merge corsHeaders. */
async function parseJson<T>(req: Request, corsHeaders: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_JSON_BODY_BYTES) {
    return { ok: false, res: json({ ok: false, error: "Request body too large" }, 413, corsHeaders) };
  }
  try {
    const data = await req.json() as T;
    return { ok: true, data };
  } catch {
    return { ok: false, res: json({ ok: false, error: "Invalid or missing JSON body" }, 400, corsHeaders) };
  }
}

/**
 * Load local plugins from valid plugin directories
 */
async function loadPlugins(registry: ToolRegistry) {
  const candidates = [
    join(BACKEND_ROOT, "src", "plugins"),
    join(PROJECT_ROOT, "plugins"),
  ];

  const loaded = new Set<string>();

  for (const pluginsDir of candidates) {
    if (!existsSync(pluginsDir)) continue;

    try {
      const files = readdirSync(pluginsDir);

      for (const file of files) {
        if ((file.endsWith(".ts") || file.endsWith(".js")) && !file.endsWith(".d.ts")) {
          try {
            const modulePath = join(pluginsDir, file);
            const module = await import(modulePath);
            const ToolClass = module.default;

            if (ToolClass && typeof ToolClass === 'function') {
              const toolInstance = new ToolClass();
              if (toolInstance.name && typeof toolInstance.run === 'function') {
                if (loaded.has(toolInstance.name)) continue;
                registry.register(toolInstance);
                loaded.add(toolInstance.name);
                serverLog.debug({ plugin: toolInstance.name, path: pluginsDir }, "Loaded local plugin");
              }
            }
          } catch (err) {
            serverLog.warn({ file, err }, "Failed to load plugin");
          }
        }
      }
    } catch (err) {
      serverLog.warn({ pluginsDir, err }, "Error scanning plugins directory");
    }
  }

  if (loaded.size > 0) {
    serverLog.info({ count: loaded.size }, "Loaded local plugins");
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

main().catch((err) => serverLog.fatal(err, "Server startup failed"));
