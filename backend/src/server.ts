// Koryphaios Backend Server — Bun HTTP + WebSocket server.
// This is the main entry point that wires everything together.

import type { WSMessage, APIResponse, SendMessageRequest, CreateSessionRequest, StoredMessage } from "@koryphaios/shared";
import { ProviderRegistry } from "./providers";
import { startCopilotDeviceAuth, pollCopilotDeviceAuth } from "./providers/copilot";
import { ToolRegistry, BashTool, ReadFileTool, WriteFileTool, EditFileTool, GrepTool, GlobTool, LsTool, WebSearchTool, WebFetchTool, DeleteFileTool, MoveFileTool, DiffTool, PatchTool } from "./tools";
import { AskUserTool, AskManagerTool } from "./tools/interaction";
import { KoryManager } from "./kory/manager";
import { TelegramBridge } from "./telegram/bot";
import { MCPManager } from "./mcp/client";
import { wsBroker } from "./pubsub";
import { serverLog } from "./logger";
import { getCorsHeaders, validateSessionId, validateProviderName, sanitizeString, encryptApiKey, RateLimiter } from "./security";
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
import { WSManager } from "./ws/ws-manager";

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

  // Wire up pub/sub → WebSocket broadcast
  const wsStream = wsBroker.subscribe();
  const wsReader = wsStream.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await wsReader.read();
        if (done) break;
        wsManager.broadcast(value.payload);
      }
    } catch {}
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

  // ─── HTTP + WebSocket Server ────────────────────────────────────────────

  const rateLimiter = new RateLimiter(RATE_LIMIT.MAX_REQUESTS, RATE_LIMIT.WINDOW_MS);

  const server = Bun.serve<{ id: string }>({
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
        const corsHeaders = getCorsHeaders(origin);

        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Rate limiting
        const clientIp = req.headers.get("x-forwarded-for") ?? "local";
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
          return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
        }

      // ── WebSocket upgrade ──
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: nanoid(ID.WS_CLIENT_ID_LENGTH) },
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

      // Session by ID routes — parse path segments
      if (url.pathname.startsWith("/api/sessions/")) {
        const segments = url.pathname.split("/");
        const id = segments[3];
        const subResource = segments[4]; // "messages", "auto-title", or undefined

        if (!id) return json({ ok: false, error: "Session ID required" }, 400, corsHeaders);
        const validatedId = validateSessionId(id);
        if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400, corsHeaders);

        // GET /api/sessions/:id/messages — fetch message history
        if (subResource === "messages" && method === "GET") {
          const sessionMessages = messages.getAll(validatedId);
          return json({ ok: true, data: sessionMessages }, 200, corsHeaders);
        }

        // POST /api/sessions/:id/auto-title — generate title from first message
        if (subResource === "auto-title" && method === "POST") {
          const sessionMessages = messages.getAll(validatedId);
          const firstUserMsg = sessionMessages.find(m => m.role === "user");
          if (firstUserMsg) {
            // Simple title: first 50 chars of first message, cleaned up
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

        // GET /api/sessions/:id/running — check if session is running workers
        if (subResource === "running" && method === "GET") {
          return json({ ok: true, data: { running: kory.isSessionRunning(validatedId) } }, 200, corsHeaders);
        }
      }

      // Send message (trigger Kory)
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

      // Provider status
      if (url.pathname === "/api/providers" && method === "GET") {
        return json({ ok: true, data: await providers.getStatus() }, 200, corsHeaders);
      }

      // Start Copilot browser device auth flow
      if (url.pathname === "/api/providers/copilot/device/start" && method === "POST") {
        try {
          const start = await startCopilotDeviceAuth();
          return json({ ok: true, data: start }, 200, corsHeaders);
        } catch (err: any) {
          return json({ ok: false, error: err.message ?? "Failed to start Copilot auth" }, 400, corsHeaders);
        }
      }

      // Poll Copilot device auth and finalize connection
      if (url.pathname === "/api/providers/copilot/device/poll" && method === "POST") {
        const body = await req.json() as { deviceCode?: string };
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
        try {
          const result = await googleAuth.startGeminiCLIAuth();
          return json({ ok: true, data: result }, 200, corsHeaders);
        } catch (err: any) {
          return json({ ok: false, error: err.message }, 500, corsHeaders);
        }
      }

      // In-memory store for pending auth sessions
      const pendingAntigravityAuth = new Map<string, Promise<{ success: boolean; token?: string; error?: string }>>();

      if (url.pathname === "/api/providers/google/auth/antigravity" && method === "POST") {
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
        const authId = url.searchParams.get("authId");
        if (!authId || !pendingAntigravityAuth.has(authId)) {
          return json({ ok: false, error: "Invalid or expired auth session" }, 404, corsHeaders);
        }

        try {
          const result = await pendingAntigravityAuth.get(authId);
          pendingAntigravityAuth.delete(authId);
          
          if (result?.success) {
            return json({ ok: true, data: { success: true, token: result.token } }, 200, corsHeaders);
          } else {
            return json({ ok: false, error: result?.error || "Authentication failed" }, 400, corsHeaders);
          }
        } catch (err: any) {
          return json({ ok: false, error: err.message }, 500, corsHeaders);
        }
      }

      if (url.pathname === "/api/providers/anthropic/auth/cli" && method === "POST") {
        try {
          const result = await cliAuth.authenticateClaude();
          return json({ ok: true, data: result }, 200, corsHeaders);
        } catch (err: any) {
          return json({ ok: false, error: err.message }, 500, corsHeaders);
        }
      }

      if (url.pathname === "/api/providers/openai/auth/codex" && method === "POST") {
        try {
          const result = await cliAuth.authenticateCodex();
          return json({ ok: true, data: result }, 200, corsHeaders);
        } catch (err: any) {
          return json({ ok: false, error: err.message }, 500, corsHeaders);
        }
      }

      // Set provider credentials
      if (url.pathname.startsWith("/api/providers/") && method === "PUT") {
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

        // Handle special CLI auth modes (codex, gemini cli, antigravity, claude code)
        if (authMode === "codex" || authMode === "cli" || authMode === "antigravity" || authMode === "claude_code") {
          const cliName = authMode === "codex" ? "codex" : authMode === "claude_code" ? "claude" : "gemini";
          const targetProvider =
            authMode === "codex" ? "codex" :
            authMode === "claude_code" ? "anthropic" :
            // For unified Google card, store CLI auth directly on the canonical google provider
            "google";

          // Verify CLI is installed and accessible
          const whichProc = Bun.spawnSync(["which", cliName], { stdout: "pipe", stderr: "pipe" });
          if (whichProc.exitCode !== 0) {
            return json({ ok: false, error: `${cliName} CLI not found in PATH. Install it first.` }, 400, corsHeaders);
          }

          // Mark provider as CLI-authenticated temporarily to verify
          const authValue = authMode === "antigravity" ? "cli:antigravity" : `cli:${cliName}`;
          
          const verification = await providers.verifyConnection(targetProvider as any, {
            authToken: authValue
          });

          if (!verification.success) {
            return json({ ok: false, error: verification.error || `${cliName} CLI auth failed` }, 400, corsHeaders);
          }

          // Verification passed, set and persist
          const result = providers.setCredentials(targetProvider as any, {
            authToken: authValue,
          });
          
          if (!result.success) {
            return json({ ok: false, error: result.error }, 400, corsHeaders);
          }

          persistEnvVar(
            PROJECT_ROOT,
            providers.getExpectedEnvVar(targetProvider as any, "authToken"),
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

        const result = providers.setCredentials(providerName as any, {
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
          const verification = await providers.verifyConnection(providerName as any, {
            ...(apiKey && { apiKey }),
            ...(authToken && { authToken }),
            ...(baseUrl && { baseUrl }),
          });
          if (!verification.success) {
            providers.removeApiKey(providerName as any);
            return json({ ok: false, error: verification.error ?? "Provider verification failed" }, 400, corsHeaders);
          }
        }

        if (apiKey) {
          persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "apiKey"), encryptApiKey(apiKey));
        }
        if (authToken) {
          persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "authToken"), encryptApiKey(authToken));
        }
        if (baseUrl) {
          persistEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "baseUrl"), baseUrl);
        }

        // Broadcast updated provider status via WebSocket
        wsManager.broadcast({
          type: "provider.status",
          payload: { providers: await providers.getStatus() },
          timestamp: Date.now(),
        } satisfies WSMessage);

        return json({ ok: true, data: { provider: providerName, status: "connected" } }, 200, corsHeaders);
      }

      // ─── Git Integration ───
      
      // Status
      if (url.pathname === "/api/git/status" && method === "GET") {
        const status = await kory.git.getStatus();
        const branch = await kory.git.getBranch();
        return json({ ok: true, data: { status, branch } }, 200, corsHeaders);
      }

      // Diff
      if (url.pathname === "/api/git/diff" && method === "GET") {
        const file = url.searchParams.get("file");
        const staged = url.searchParams.get("staged") === "true";
        if (!file) return json({ ok: false, error: "file parameter required" }, 400, corsHeaders);
        const diff = await kory.git.getDiff(file, staged);
        return json({ ok: true, data: { diff } }, 200, corsHeaders);
      }

      // Stage/Unstage
      if (url.pathname === "/api/git/stage" && method === "POST") {
        const body = await req.json() as { file: string; unstage?: boolean };
        if (!body.file) return json({ ok: false, error: "file required" }, 400, corsHeaders);
        const success = body.unstage 
          ? await kory.git.unstageFile(body.file)
          : await kory.git.stageFile(body.file);
        return json({ ok: success }, success ? 200 : 500, corsHeaders);
      }

      // Restore (Discard)
      if (url.pathname === "/api/git/restore" && method === "POST") {
        const body = await req.json() as { file: string };
        if (!body.file) return json({ ok: false, error: "file required" }, 400, corsHeaders);
        const success = await kory.git.restoreFile(body.file);
        return json({ ok: success }, success ? 200 : 500, corsHeaders);
      }

      // Commit
      if (url.pathname === "/api/git/commit" && method === "POST") {
        const body = await req.json() as { message: string };
        if (!body.message) return json({ ok: false, error: "message required" }, 400, corsHeaders);
        const success = await kory.git.commit(body.message);
        return json({ ok: success }, success ? 200 : 500, corsHeaders);
      }

      // Branches
      if (url.pathname === "/api/git/branches" && method === "GET") {
        const { output } = (kory.git as any).runGit(["branch", "--format=%(refname:short)"]);
        const branches = output.split("\n").filter(Boolean);
        return json({ ok: true, data: { branches } }, 200, corsHeaders);
      }

      // Checkout
      if (url.pathname === "/api/git/checkout" && method === "POST") {
        const body = await req.json() as { branch: string; create?: boolean };
        if (!body.branch) return json({ ok: false, error: "branch required" }, 400, corsHeaders);
        const success = await kory.git.checkout(body.branch, body.create);
        return json({ ok: success }, success ? 200 : 500, corsHeaders);
      }

      // Merge
      if (url.pathname === "/api/git/merge" && method === "POST") {
        const body = await req.json() as { branch: string };
        if (!body.branch) return json({ ok: false, error: "branch required" }, 400, corsHeaders);
        const result = await kory.git.merge(body.branch);
        const conflicts = result.hasConflicts ? await kory.git.getConflicts() : [];
        return json({ ok: result.success, data: { output: result.output, conflicts, hasConflicts: result.hasConflicts } }, 200, corsHeaders);
      }

      // Push
      if (url.pathname === "/api/git/push" && method === "POST") {
        const result = await kory.git.push();
        return json({ ok: result.success, error: result.output }, result.success ? 200 : 500, corsHeaders);
      }

      // Pull
      if (url.pathname === "/api/git/pull" && method === "POST") {
        const result = await kory.git.pull();
        const hasConflicts = result.output.includes("CONFLICT") || result.output.includes("Automatic merge failed");
        const conflicts = hasConflicts ? await kory.git.getConflicts() : [];
        return json({ ok: result.success, data: { output: result.output, conflicts, hasConflicts } }, 200, corsHeaders);
      }

      // Set worker assignments
      if (url.pathname === "/api/assignments" && method === "GET") {
        return json({ ok: true, data: { assignments: config.assignments ?? {} } }, 200, corsHeaders);
      }

      if (url.pathname === "/api/assignments" && method === "PUT") {
        const body = await req.json() as { assignments: Record<string, string> };
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

      // Remove provider API key
      if (url.pathname.startsWith("/api/providers/") && method === "DELETE") {
        const rawName = url.pathname.split("/")[3];
        const providerName = validateProviderName(rawName);
        if (!providerName) {
          return json({ ok: false, error: "Invalid provider name" }, 400, corsHeaders);
        }
        providers.removeApiKey(providerName as any);
        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "apiKey"));
        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "authToken"));
        clearEnvVar(PROJECT_ROOT, providers.getExpectedEnvVar(providerName as any, "baseUrl"));

        // Persist provider disconnect state so auto-detected CLI/env auth does not
        // immediately re-enable on next restart unless user explicitly reconnects.
        try {
          config.providers = config.providers ?? {};
          const existing = config.providers[providerName as keyof typeof config.providers] ?? { name: providerName as any };
          config.providers[providerName as keyof typeof config.providers] = {
            ...existing,
            name: providerName as any,
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

      // Agent status
      if (url.pathname === "/api/agents/status" && method === "GET") {
        return json({ ok: true, data: { workers: kory.getStatus() } }, 200, corsHeaders);
      }

      // Cancel all
      if (url.pathname === "/api/agents/cancel" && method === "POST") {
        kory.cancel();
        return json({ ok: true }, 200, corsHeaders);
      }

      // Health check
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          data: {
            version: "0.1.0",
            uptime: process.uptime(),
            providers: providers.getAvailable().length,
            wsClients: wsManager.clientCount,
          },
        }, 200, corsHeaders);
      }

      // SSE endpoint for clients that don't support WebSocket
      if (url.pathname === "/api/events") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const sub = wsBroker.subscribe();
            const reader = sub.getReader();

            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const data = `data: ${JSON.stringify(value.payload)}\n\n`;
                  controller.enqueue(encoder.encode(data));
                }
              } catch {
                controller.close();
              }
            })();
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
      open(ws: any) {
        try {
          wsManager.add(ws);
          serverLog.info({ clientId: ws.data.id, clients: wsManager.clientCount }, "WS client connected");

          // Send initial state
          void providers.getStatus()
            .then((initialStatus) => {
              ws.send(JSON.stringify({
                type: "provider.status",
                payload: { providers: initialStatus },
                timestamp: Date.now(),
              } satisfies WSMessage));
            })
            .catch((err) => {
              handleError(err, { event: "ws.open.init_status", clientId: ws?.data?.id });
            });
        } catch (err) {
          handleError(err, { event: "ws.open", clientId: ws?.data?.id });
        }
      },

      message(ws: any, message: string | Buffer) {
        try {
          const msg = JSON.parse(String(message));

          // Handle client commands
          if (msg.type === "subscribe_session") {
            wsManager.subscribeClientToSession(ws.data.id, msg.sessionId);
          } else if (msg.type === "user_input") {
            kory.handleUserInput(msg.sessionId, msg.selection, msg.text);
          } else if (msg.type === "session.accept_changes") {
            kory.handleSessionResponse(msg.sessionId, true);
          } else if (msg.type === "session.reject_changes") {
            kory.handleSessionResponse(msg.sessionId, false);
          } else if (msg.type === "toggle_yolo") {
            kory.setYoloMode(!!msg.enabled);
          }
        } catch (err) {
          handleError(err, { event: "ws.message", clientId: ws?.data?.id, raw: String(message).slice(0, 500) });
        }
      },

      close(ws: any) {
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

      // 5. Stop Telegram bot if running
      if (telegram && typeof (telegram as any).stop === "function") {
        (telegram as any).stop();
        serverLog.info("Stopped Telegram bot");
      }

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
