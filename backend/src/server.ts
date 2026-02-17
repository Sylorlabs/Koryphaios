// Koryphaios Backend Server — Bun HTTP + WebSocket server.
// This is the main entry point that wires everything together.

import type { WSMessage, APIResponse, SendMessageRequest, CreateSessionRequest, StoredMessage, ProviderName } from "@koryphaios/shared";
import type { ServerWebSocket } from "bun";
import { ProviderRegistry, PROVIDER_AUTH_MODE } from "./providers";
import { startCopilotDeviceAuth, pollCopilotDeviceAuth } from "./providers/copilot";
import { ToolRegistry, BashTool, ShellManageTool, ReadFileTool, WriteFileTool, EditFileTool, GrepTool, GlobTool, LsTool, WebSearchTool, WebFetchTool, DeleteFileTool, MoveFileTool, DiffTool, PatchTool } from "./tools";
import { shellManager } from "./tools/shell-manager";
import { AskUserTool, AskManagerTool } from "./tools/interaction";
import { KoryManager } from "./kory/manager";
import { TelegramBridge } from "./telegram/bot";
import { MCPManager } from "./mcp/client";
import { wsBroker } from "./pubsub";
import { serverLog } from "./logger";
import { getCorsHeaders, validateSessionId, validateProviderName, sanitizeString, encryptApiKey, RateLimiter } from "./security";
import { requireSessionAuth, generateSessionToken, extractTokenFromRequest } from "./auth";
import { ValidationError, SessionError, handleError, generateCorrelationId } from "./errors";
import { SESSION, MESSAGE, ID, RATE_LIMIT } from "./constants";
import { validateEnvironment } from "./config-schema";
import { nanoid } from "nanoid";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { GoogleAuthManager, googleAuth } from "./providers/google-auth";
import { cliAuth } from "./providers/cli-auth";
import { initDb } from "./db/sqlite";
import { PROJECT_ROOT, BACKEND_ROOT } from "./runtime/paths";
import { loadConfig } from "./runtime/config";
import { persistEnvVar, clearEnvVar } from "./runtime/env";
import { SessionStore } from "./stores/session-store";
import { MessageStore } from "./stores/message-store";
import { WSManager, type WSClientData } from "./ws/ws-manager";

// ─── Configuration Loading ──────────────────────────────────────────────────

// ─── Main Server ────────────────────────────────────────────────────────────

async function main() {
  serverLog.info("═══════════════════════════════════════");
  serverLog.info("       KORYPHAIOS v0.1.0");
  serverLog.info("  AI Agent Orchestration Dashboard");
  serverLog.info("═══════════════════════════════════════");

  // Validate environment variables
  validateEnvironment();

  const config = loadConfig(PROJECT_ROOT);

  // Initialize SQLite Database
  initDb(join(PROJECT_ROOT, config.dataDirectory));

  // Initialize providers (auth hub)
  const providers = new ProviderRegistry(config);

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

  // In-memory store for pending auth sessions
  const pendingAntigravityAuth = new Map<string, Promise<{ success: boolean; token?: string; error?: string }>>();

  // Wire up pub/sub → WebSocket broadcast
  const wsStream = wsBroker.subscribe();
  const wsReader = wsStream.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await wsReader.read();
        if (done) break;

        const msg = value.payload as WSMessage;
        if (msg.sessionId) {
          wsManager.broadcastToSession(msg.sessionId, msg);
        } else {
          wsManager.broadcast(msg);
        }
      }
    } catch (err) {
      serverLog.error({ err }, "WebSocket pub/sub reader error");
    }
  })();

  // Initialize Telegram bridge (optional)
  let telegram: TelegramBridge | undefined;
  if (config.telegram?.botToken && config.telegram.adminId) {
    telegram = new TelegramBridge(
      {
        botToken: config.telegram.botToken,
        adminId: config.telegram.adminId,
        secretToken: config.telegram.secretToken,
      },
      kory,
    );
    serverLog.info({ adminId: config.telegram.adminId }, "Telegram bridge enabled");
  }

  // ─── Generate & Display Root Token ────────────────────────────────────────

  const rootSessionId = nanoid(ID.SESSION_ID_LENGTH);
  const rootToken = generateSessionToken(rootSessionId);

  const boxWidth = 62;
  const tokenLine = ` ${rootToken} `;
  const padding = Math.max(0, boxWidth - tokenLine.length - 2);
  const paddedToken = `│${tokenLine}${" ".repeat(padding)}│`;

  console.log("\n╭" + "─".repeat(boxWidth) + "╮");
  console.log("│" + "  AUTHENTICATION REQUIRED".padStart(Math.floor(boxWidth / 2) + 12).padEnd(boxWidth) + "│");
  console.log("│" + " ".repeat(boxWidth) + "│");
  console.log("│" + " Use this token to authenticate with the API / Frontend: ".padEnd(boxWidth) + "│");
  console.log("│" + " ".repeat(boxWidth) + "│");
  console.log(paddedToken);
  console.log("│" + " ".repeat(boxWidth) + "│");
  console.log("╰" + "─".repeat(boxWidth) + "╯\n");


  // ─── HTTP + WebSocket Server ────────────────────────────────────────────

  const rateLimiter = new RateLimiter(RATE_LIMIT.MAX_REQUESTS, RATE_LIMIT.WINDOW_MS);

  const server = Bun.serve<{ id: string; sessionId?: string }>({
    port: config.server.port,
    hostname: config.server.host,

    async fetch(req, server) {
      const url = new URL(req.url);
      const method = req.method;
      const origin = req.headers.get("origin");
      const requestId = generateCorrelationId();

      // CORS — origin allowlist (not *)
      const corsHeaders = getCorsHeaders(origin);

      try {
        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Rate limiting
        const clientIp = req.headers.get("x-forwarded-for") ?? "local";
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
          return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
        }

        // ── Public Routes ──

        if (url.pathname === "/api/health") {
          return json({
            ok: true,
            data: {
              version: "0.1.0",
              uptime: process.uptime(),
              providers: providers.getAvailable().length,
              wsClients: wsManager.clientCount,
              memory: process.memoryUsage(),
            },
          }, 200, corsHeaders);
        }

        // Kubernetes-style health endpoints
        if (url.pathname === "/health/live") {
          return json({ ok: true, status: "alive" }, 200, corsHeaders);
        }

        if (url.pathname === "/health/ready") {
          // Check if critical systems are ready
          const providerCount = providers.getAvailable().length;
          return json({
            ok: providerCount > 0,
            status: providerCount > 0 ? "ready" : "degraded",
            checks: {
              providers: providerCount > 0 ? "ok" : "no providers configured",
              database: "ok", // SQLite is always available after initDb
            },
          }, providerCount > 0 ? 200 : 503, corsHeaders);
        }

        if (url.pathname === "/api/auth/session" && method === "POST") {
          // Require root token to create new sessions
          const body = await req.json().catch(() => ({})) as { rootToken?: string };
          const providedToken = body.rootToken ?? req.headers.get("X-Root-Token");
          if (!providedToken || providedToken !== rootToken) {
            return json({ ok: false, error: "Invalid or missing root token" }, 401, corsHeaders);
          }
          const sessionId = nanoid(ID.SESSION_ID_LENGTH);
          const token = generateSessionToken(sessionId);
          return json({ ok: true, data: { token, sessionId } }, 200, corsHeaders);
        }

        // Telegram webhook (uses its own secret token in header)
        if (url.pathname === "/api/telegram/webhook" && telegram) {
          try {
            const handler = telegram.getWebhookHandler();
            return await handler(req);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        // ── Authentication Middleware ──

        // Everything below this line requires a valid session token.
        // For WebSocket upgrade, we check the token in the query param or header.

        let authenticatedSessionId: string;

        // WebSocket Upgrade Auth Check
        if (url.pathname === "/ws") {
          let sessionId: string;
          try {
            sessionId = requireSessionAuth(req);
          } catch (err) {
             serverLog.warn({ ip: clientIp, error: String(err) }, "WS connection attempt rejected due to auth error");
             return json({ ok: false, error: "Invalid session token" }, 401, corsHeaders);
          }

          const upgraded = server.upgrade(req, {
            data: { id: nanoid(ID.WS_CLIENT_ID_LENGTH), sessionId },
          });
          if (upgraded) return undefined;
          return json({ ok: false, error: "WebSocket upgrade failed" }, 400, corsHeaders);
        }

        // REST API Auth Check
        try {
          authenticatedSessionId = requireSessionAuth(req);
        } catch (err: any) {
          serverLog.debug({ path: url.pathname, error: err.message }, "Auth failed");
          return json({ ok: false, error: "Unauthorized: Invalid or missing session token" }, 401, corsHeaders);
        }

        serverLog.debug({ requestId, method, path: url.pathname, session: authenticatedSessionId }, "Authenticated request");

        // ── Authenticated Routes ──

        // Agent steering
        if (url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/cancel") && method === "POST") {
          const agentId = url.pathname.replace("/api/agents/", "").replace("/cancel", "");
          kory.cancelWorker(agentId);
          return json({ ok: true }, 200, corsHeaders);
        }

        // Sessions
        if (url.pathname === "/api/sessions" && method === "GET") {
          return json({ ok: true, data: sessions.list() }, 200, corsHeaders);
        }

        if (url.pathname === "/api/sessions" && method === "POST") {
          const body = await req.json() as CreateSessionRequest;
          const title = sanitizeString(body.title, SESSION.MAX_TITLE_LENGTH);
          const session = sessions.create(title ?? undefined, body.parentSessionId);
          return json({ ok: true, data: session }, 201, corsHeaders);
        }

        // Session by ID routes
        if (url.pathname.startsWith("/api/sessions/")) {
          const segments = url.pathname.split("/");
          const id = segments[3];
          const subResource = segments[4];

          if (!id) return json({ ok: false, error: "Session ID required" }, 400, corsHeaders);
          const validatedId = validateSessionId(id);
          if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400, corsHeaders);

          // GET /api/sessions/:id/messages
          if (subResource === "messages" && method === "GET") {
            const sessionMessages = messages.getAll(validatedId);
            return json({ ok: true, data: sessionMessages }, 200, corsHeaders);
          }

          // POST /api/sessions/:id/changes/apply
          if (subResource === "changes" && segments[5] === "apply" && method === "POST") {
            const body = await req.json() as {
              acceptAll?: boolean;
              rejectAll?: boolean;
              acceptPaths?: string[];
              rejectPaths?: string[];
            };
            const result = await kory.applySessionChanges(validatedId, {
              acceptAll: !!body.acceptAll,
              rejectAll: !!body.rejectAll,
              acceptPaths: Array.isArray(body.acceptPaths) ? body.acceptPaths : [],
              rejectPaths: Array.isArray(body.rejectPaths) ? body.rejectPaths : [],
            });

            if (!result.ok) {
              return json({ ok: false, error: result.error ?? "Failed to apply changes" }, 400, corsHeaders);
            }

            if ((result.remaining?.length ?? 0) > 0) {
              wsManager.broadcast({
                type: "session.changes",
                payload: { changes: result.remaining },
                timestamp: Date.now(),
                sessionId: validatedId,
              } satisfies WSMessage);
            } else {
              wsManager.broadcast({
                type: "session.accept_changes",
                payload: {},
                timestamp: Date.now(),
                sessionId: validatedId,
              } satisfies WSMessage);
            }

            return json({ ok: true, data: result }, 200, corsHeaders);
          }

          // POST /api/sessions/:id/auto-title
          if (subResource === "auto-title" && method === "POST") {
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

          // No sub-resource
          if (!subResource) {
            if (method === "GET") {
              const session = sessions.get(validatedId);
              if (!session) return json({ ok: false, error: "Session not found" }, 404, corsHeaders);
              return json({ ok: true, data: session }, 200, corsHeaders);
            }

            if (method === "PATCH") {
              const body = await req.json() as { title?: string };
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
              kory.cancelSessionWorkers(validatedId);
              sessions.delete(validatedId);
              wsManager.broadcast({
                type: "session.deleted",
                payload: { sessionId: id },
                timestamp: Date.now(),
                sessionId: validatedId,
              } satisfies WSMessage);
              return json({ ok: true }, 200, corsHeaders);
            }
          }

          if (subResource === "running" && method === "GET") {
            return json({ ok: true, data: { running: kory.isSessionRunning(validatedId) } }, 200, corsHeaders);
          }
        }

        // Send message
        if (url.pathname === "/api/messages" && method === "POST") {
          const body = await req.json() as SendMessageRequest;

          const sessionId = validateSessionId(body.sessionId);
          const content = sanitizeString(body.content, MESSAGE.MAX_CONTENT_LENGTH);

          if (!sessionId || !content) {
            return json({ ok: false, error: "Valid sessionId and content are required" }, 400, corsHeaders);
          }

          // Ensure session exists
          let session = sessions.get(sessionId);
          let activeSessionId = sessionId;
          if (!session) {
            session = sessions.create(SESSION.DEFAULT_TITLE);
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

          // Increment message count
          const currentCount = session.messageCount ?? 0;
          sessions.update(activeSessionId, {
            messageCount: currentCount + 1,
          });

          // AUTO-TITLE: If this was the first message or it's still the default title
          if (currentCount === 0 || session.title === SESSION.DEFAULT_TITLE) {
            const rawTitle = content.replace(/\n/g, " ").trim();
            const newTitle = rawTitle.length > 50
              ? rawTitle.slice(0, 47) + "..."
              : rawTitle;

            const updated = sessions.update(activeSessionId, { title: newTitle });
            if (updated) {
              wsManager.broadcast({
                type: "session.updated",
                payload: { session: updated },
                timestamp: Date.now(),
                sessionId: activeSessionId,
              } satisfies WSMessage);
            }
          }

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

        // Provider status
        if (url.pathname === "/api/providers" && method === "GET") {
          return json({ ok: true, data: await providers.getStatus() }, 200, corsHeaders);
        }

        // Copilot auth start
        if (url.pathname === "/api/providers/copilot/device/start" && method === "POST") {
          try {
            const start = await startCopilotDeviceAuth();
            return json({ ok: true, data: start }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message ?? "Failed to start Copilot auth" }, 400, corsHeaders);
          }
        }

        // Copilot auth poll
        if (url.pathname === "/api/providers/copilot/device/poll" && method === "POST") {
          requireSessionAuth(req);
          const body = await req.json() as { deviceCode?: string };
          const deviceCode = sanitizeString(body.deviceCode, 300);
          if (!deviceCode) {
            return json({ ok: false, error: "deviceCode is required" }, 400, corsHeaders);
          }

          try {
            const poll = await pollCopilotDeviceAuth(deviceCode);
            if (poll.error) {
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

            persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar("copilot", "authToken"), encryptApiKey(poll.accessToken));
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

        // Google/Gemini Auth Routes
        if (url.pathname === "/api/providers/google/auth/cli" && method === "POST") {
          requireSessionAuth(req);
          try {
            const result = await googleAuth.startGeminiCLIAuth();
            return json({ ok: true, data: result }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        if (url.pathname === "/api/providers/google/auth/antigravity" && method === "POST") {
          requireSessionAuth(req);
          try {
            const startResult = await googleAuth.startAntigravityAuth();
            const authId = nanoid();
            pendingAntigravityAuth.set(authId, googleAuth.waitForAntigravityCallback());
            setTimeout(() => pendingAntigravityAuth.delete(authId), 360_000);
            return json({ ok: true, data: { ...startResult, authId } }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        if (url.pathname === "/api/providers/google/auth/antigravity/poll" && method === "GET") {
          requireSessionAuth(req);
          const authId = url.searchParams.get("authId");
          if (!authId || !pendingAntigravityAuth.has(authId)) {
            return json({ ok: false, error: "Invalid or expired auth session" }, 404, corsHeaders);
          }
          try {
            const result = await pendingAntigravityAuth.get(authId);
            pendingAntigravityAuth.delete(authId);
            if (result?.success && result.token) {
              const authToken = `cli:antigravity:${result.token}`;

              const setResult = providers.setCredentials("google", { authToken });
              if (!setResult.success) {
                return json({ ok: false, error: setResult.error || "Failed to configure provider" }, 400, corsHeaders);
              }

              const verification = await providers.verifyConnection("google", { authToken });
              if (!verification.success) {
                providers.removeApiKey("google");
                return json({ ok: false, error: verification.error || "Antigravity verification failed" }, 400, corsHeaders);
              }

              persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar("google", "authToken"), authToken);

              wsManager.broadcast({
                type: "provider.status",
                payload: { providers: await providers.getStatus() },
                timestamp: Date.now(),
              } satisfies WSMessage);

              return json({ ok: true, data: { success: true, status: "connected" } }, 200, corsHeaders);
            } else {
              return json({ ok: false, error: result?.error || "Authentication failed" }, 400, corsHeaders);
            }
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        if (url.pathname === "/api/providers/anthropic/auth/cli" && method === "POST") {
          requireSessionAuth(req);
          try {
            const result = await cliAuth.authenticateClaude();
            return json({ ok: true, data: result }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        if (url.pathname === "/api/providers/openai/auth/codex" && method === "POST") {
          requireSessionAuth(req);
          try {
            const result = await cliAuth.authenticateCodex();
            return json({ ok: true, data: result }, 200, corsHeaders);
          } catch (err: any) {
            return json({ ok: false, error: err.message }, 500, corsHeaders);
          }
        }

        // Set provider credentials
        if (url.pathname.startsWith("/api/providers/") && method === "PUT") {
          requireSessionAuth(req);
          const rawName = url.pathname.split("/")[3];
          const providerName = validateProviderName(rawName);
          if (!providerName) {
            return json({ ok: false, error: "Invalid provider name" }, 400, corsHeaders);
          }

          const body = await req.json() as { apiKey?: string; authToken?: string; baseUrl?: string; selectedModels?: string[]; hideModelSelector?: boolean; authMode?: string };
          const apiKey = sanitizeString(body.apiKey, 500);
          const authToken = sanitizeString(body.authToken, 1000);
          const baseUrl = sanitizeString(body.baseUrl, 500);
          const authMode = sanitizeString(body.authMode, 50);

          if (authMode === "codex" || authMode === "cli" || authMode === "antigravity" || authMode === "claude_code") {
            const cliName = authMode === "codex" ? "codex" : authMode === "claude_code" ? "claude" : "gcloud";
            const targetProvider = (authMode === "codex" ? "codex" : authMode === "claude_code" ? "anthropic" : "google") as ProviderName;

            const whichProc = Bun.spawnSync(["which", cliName], { stdout: "pipe", stderr: "pipe" });
            if (whichProc.exitCode !== 0) {
              return json({ ok: false, error: `${cliName} CLI not found in PATH. Install it first.` }, 400, corsHeaders);
            }

            const authValue = authMode === "antigravity" ? "cli:antigravity" : `cli:${cliName}`;
            const verification = await providers.verifyConnection(targetProvider, { authToken: authValue });
            if (!verification.success) {
              return json({ ok: false, error: verification.error || `${cliName} CLI auth failed` }, 400, corsHeaders);
            }

            const result = providers.setCredentials(targetProvider, { authToken: authValue });
            if (!result.success) {
              return json({ ok: false, error: result.error }, 400, corsHeaders);
            }

            persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(targetProvider, "authToken"), authValue);
            wsManager.broadcast({ type: "provider.status", payload: { providers: await providers.getStatus() }, timestamp: Date.now() } satisfies WSMessage);
            return json({ ok: true, data: { provider: targetProvider, status: "connected", authMode } }, 200, corsHeaders);
          }

          const isPreferencesOnlyUpdate = !apiKey && !authToken && !baseUrl && (body.selectedModels !== undefined || body.hideModelSelector !== undefined);
          const result = providers.setCredentials(providerName, {
            ...(apiKey && { apiKey }),
            ...(authToken && { authToken }),
            ...(baseUrl && { baseUrl }),
            ...(body.selectedModels && { selectedModels: body.selectedModels }),
            ...(body.hideModelSelector !== undefined && { hideModelSelector: body.hideModelSelector }),
          });

          if (!result.success) return json({ ok: false, error: result.error }, 400, corsHeaders);

          if (!isPreferencesOnlyUpdate) {
            const verification = await providers.verifyConnection(providerName, { ...(apiKey && { apiKey }), ...(authToken && { authToken }), ...(baseUrl && { baseUrl }) });
            if (!verification.success) {
              providers.removeApiKey(providerName);
              return json({ ok: false, error: verification.error ?? "Provider verification failed" }, 400, corsHeaders);
            }
          }

          if (apiKey) persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "apiKey"), encryptApiKey(apiKey));
          if (authToken) persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "authToken"), encryptApiKey(authToken));
          if (baseUrl) persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "baseUrl"), baseUrl);

          wsManager.broadcast({ type: "provider.status", payload: { providers: await providers.getStatus() }, timestamp: Date.now() } satisfies WSMessage);
          return json({ ok: true, data: { provider: providerName, status: "connected" } }, 200, corsHeaders);
        }

        // Git Integration
        if (url.pathname === "/api/git/status" && method === "GET") {
          const status = await kory.git.getStatus();
          const branch = await kory.git.getBranch();
          const { ahead, behind } = await kory.git.getAheadBehind();
          return json({ ok: true, data: { status, branch, ahead, behind } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/git/diff" && method === "GET") {
          const file = url.searchParams.get("file");
          const staged = url.searchParams.get("staged") === "true";
          if (!file) return json({ ok: false, error: "file parameter required" }, 400, corsHeaders);
          const diff = await kory.git.getDiff(file, staged);
          return json({ ok: true, data: { diff } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/git/file" && method === "GET") {
          const file = url.searchParams.get("path");
          if (!file) return json({ ok: false, error: "path parameter required" }, 400, corsHeaders);
          const content = await kory.git.getFileContent(file);
          return json({ ok: content !== null, data: { content } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/git/stage" && method === "POST") {
          const body = await req.json() as { file: string; unstage?: boolean };
          if (!body.file) return json({ ok: false, error: "file required" }, 400, corsHeaders);
          const success = body.unstage ? await kory.git.unstageFile(body.file) : await kory.git.stageFile(body.file);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        if (url.pathname === "/api/git/restore" && method === "POST") {
          const body = await req.json() as { file: string };
          if (!body.file) return json({ ok: false, error: "file required" }, 400, corsHeaders);
          const success = await kory.git.restoreFile(body.file);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        if (url.pathname === "/api/git/commit" && method === "POST") {
          const body = await req.json() as { message: string };
          if (!body.message) return json({ ok: false, error: "message required" }, 400, corsHeaders);
          const success = await kory.git.commit(body.message);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        if (url.pathname === "/api/git/branches" && method === "GET") {
          const branches = await kory.git.getBranches();
          return json({ ok: true, data: { branches } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/git/checkout" && method === "POST") {
          const body = await req.json() as { branch: string; create?: boolean };
          if (!body.branch) return json({ ok: false, error: "branch required" }, 400, corsHeaders);
          const success = await kory.git.checkout(body.branch, body.create);
          return json({ ok: success }, success ? 200 : 500, corsHeaders);
        }

        if (url.pathname === "/api/git/merge" && method === "POST") {
          const body = await req.json() as { branch: string };
          if (!body.branch) return json({ ok: false, error: "branch required" }, 400, corsHeaders);
          const result = await kory.git.merge(body.branch);
          const conflicts = result.hasConflicts ? await kory.git.getConflicts() : [];
          return json({ ok: result.success, data: { output: result.output, conflicts, hasConflicts: result.hasConflicts } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/git/push" && method === "POST") {
          const result = await kory.git.push();
          return json({ ok: result.success, error: result.output }, result.success ? 200 : 500, corsHeaders);
        }

        if (url.pathname === "/api/git/pull" && method === "POST") {
          const result = await kory.git.pull();
          const hasConflicts = result.output.includes("CONFLICT") || result.output.includes("Automatic merge failed");
          const conflicts = hasConflicts ? await kory.git.getConflicts() : [];
          return json({ ok: result.success, data: { output: result.output, conflicts, hasConflicts } }, 200, corsHeaders);
        }

        // Assignments
        if (url.pathname === "/api/assignments" && method === "GET") {
          return json({ ok: true, data: { assignments: config.assignments ?? {} } }, 200, corsHeaders);
        }

        if (url.pathname === "/api/assignments" && method === "PUT") {
          const body = await req.json() as { assignments: Record<string, string> };
          if (!body.assignments || typeof body.assignments !== "object") {
            return json({ ok: false, error: "assignments object is required" }, 400, corsHeaders);
          }
          config.assignments = { ...config.assignments, ...body.assignments };
          const configPath = join(PROJECT_ROOT, "koryphaios.json");
          try {
            let currentConfig: Record<string, unknown> = {};
            if (existsSync(configPath)) currentConfig = JSON.parse(readFileSync(configPath, "utf-8"));
            currentConfig.assignments = config.assignments;
            writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
            serverLog.info("Updated worker assignments in koryphaios.json");
          } catch (err) {
            serverLog.warn({ err }, "Failed to persist assignments to koryphaios.json");
          }
          return json({ ok: true, data: { assignments: config.assignments } }, 200, corsHeaders);
        }

        // Remove provider API key
        if (url.pathname.startsWith("/api/providers/") && method === "DELETE") {
          requireSessionAuth(req);
          const rawName = url.pathname.split("/")[3];
          const providerName = validateProviderName(rawName);
          if (!providerName) return json({ ok: false, error: "Invalid provider name" }, 400, corsHeaders);

          providers.removeApiKey(providerName);
          clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "apiKey"));
          clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "authToken"));
          clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName, "baseUrl"));

          try {
            config.providers = config.providers ?? {};
            const existing = config.providers[providerName as keyof typeof config.providers] ?? { name: providerName };
            config.providers[providerName as keyof typeof config.providers] = { ...existing, name: providerName, apiKey: undefined, authToken: undefined, baseUrl: undefined, disabled: true } as typeof existing;

            const configPath = join(PROJECT_ROOT, "koryphaios.json");
            if (existsSync(configPath)) {
              const currentConfig = JSON.parse(readFileSync(configPath, "utf-8"));
              currentConfig.providers = currentConfig.providers ?? {};
              currentConfig.providers[providerName] = { ...(currentConfig.providers[providerName] ?? {}), name: providerName, disabled: true };
              delete currentConfig.providers[providerName].apiKey;
              delete currentConfig.providers[providerName].authToken;
              delete currentConfig.providers[providerName].baseUrl;
              writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
            }
          } catch (err) {
            serverLog.warn({ provider: providerName, err }, "Failed to persist provider disconnect state");
          }
          wsManager.broadcast({ type: "provider.status", payload: { providers: await providers.getStatus() }, timestamp: Date.now() } satisfies WSMessage);
          return json({ ok: true }, 200, corsHeaders);
        }

        if (url.pathname === "/api/auth/logout" && method === "POST") {
          sessions.clear();
          return json({ ok: true, message: "Session cleared" }, 200, corsHeaders);
        }

        if (url.pathname === "/api/providers/disconnect-all" && method === "POST") {
          requireSessionAuth(req);
          const providerNames = Object.keys(PROVIDER_AUTH_MODE);
          for (const name of providerNames) {
            try {
              const validated = validateProviderName(name);
              if (!validated) continue;
              providers.removeApiKey(validated);
              clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(validated, "apiKey"));
              clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(validated, "authToken"));
              clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(validated, "baseUrl"));
            } catch {}
          }
          wsManager.broadcast({ type: "provider.status", payload: { providers: await providers.getStatus() }, timestamp: Date.now() } satisfies WSMessage);
          return json({ ok: true, message: "All providers disconnected" }, 200, corsHeaders);
        }

        // Agent status
        if (url.pathname === "/api/agents/status" && method === "GET") {
          return json({ ok: true, data: { workers: kory.getStatus() } }, 200, corsHeaders);
        }

        // Cancel all
        if (url.pathname === "/api/agents/cancel" && method === "POST") {
          kory.cancel();
          return json({ ok: true }, 200, corsHeaders);
        }

        // Debug: Log frontend errors
        if (url.pathname === "/api/debug/log-error" && method === "POST") {
          try {
            const body = await req.json() as { errors: Array<{timestamp: number; type: string; message: string; stack?: string}> };
            for (const error of body.errors) {
              const timestamp = new Date(error.timestamp).toISOString();
              serverLog.error({
                source: 'frontend',
                timestamp,
                type: error.type,
                message: error.message,
                stack: error.stack
              }, `Frontend ${error.type}: ${error.message}`);
            }
            return json({ ok: true }, 200, corsHeaders);
          } catch (err) {
            return json({ ok: false, error: 'Invalid error log format' }, 400, corsHeaders);
          }
        }

        // SSE fallback
        if (url.pathname === "/api/events") {
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
              // Clean up subscriber when client disconnects
              abortController.abort();
              reader.cancel().catch(() => {});
            },
          });
          return new Response(stream, {
            headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }

        return json({ ok: false, error: "Not found" }, 404, corsHeaders);
      } catch (err) {
        const handled = handleError(err, { requestId, method, path: url.pathname, query: url.search });
        const corsHeaders = getCorsHeaders(origin);
        return json({ ok: false, error: `${handled.message} (requestId=${requestId})` }, handled.statusCode, corsHeaders);
      }
    },

    websocket: {
      open(ws: ServerWebSocket<WSClientData>) {
        try {
          wsManager.add(ws);
          serverLog.info({ clientId: ws.data.id, clients: wsManager.clientCount }, "WS client connected");
          void providers.getStatus().then((initialStatus) => {
            ws.send(JSON.stringify({ type: "provider.status", payload: { providers: initialStatus }, timestamp: Date.now() } satisfies WSMessage));
          }).catch((err) => handleError(err, { event: "ws.open.init_status", clientId: ws?.data?.id }));
        } catch (err) {
          handleError(err, { event: "ws.open", clientId: ws?.data?.id });
        }
      },

      message(ws: ServerWebSocket<WSClientData>, message: string | Buffer) {
        try {
          const msg = JSON.parse(String(message));
          if (msg.type === "pong") { wsManager.handlePong(ws.data.id); return; }
          if (msg.type === "subscribe_session") { wsManager.subscribeClientToSession(ws.data.id, msg.sessionId); }
          else if (msg.type === "user_input") { kory.handleUserInput(msg.sessionId, msg.selection, msg.text); }
          else if (msg.type === "session.accept_changes") { kory.handleSessionResponse(msg.sessionId, true); }
          else if (msg.type === "session.reject_changes") { kory.handleSessionResponse(msg.sessionId, false); }
          else if (msg.type === "toggle_yolo") { kory.setYoloMode(!!msg.enabled); }
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

      // 5. Clean up background shell processes
      shellManager.cleanup();
      serverLog.info("Cleaned up background shell processes");

      // 6. Shut down pub/sub broker
      wsBroker.shutdown();

      // 7. Clean up rate limiter
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

  process.on("unhandledRejection", (reason, promise) => {
    serverLog.fatal({ reason, promise }, "Unhandled promise rejection");
    gracefulShutdown("unhandledRejection");
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
