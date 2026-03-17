// Koryphaios Backend Server — Bun HTTP + WebSocket server (Refactored)
// Uses Router for request handling instead of inline route matching

import type { Server, ServerWebSocket } from "bun";
import { ProviderRegistry } from "./providers";
import { ToolRegistry, BashTool, ShellManageTool, ReadFileTool, WriteFileTool, EditFileTool, GrepTool, GlobTool, LsTool, WebSearchTool, WebFetchTool, DeleteFileTool, MoveFileTool, DiffTool, PatchTool } from "./tools";
import { AskUserTool, AskManagerTool, DelegateToWorkerTool } from "./tools/interaction";
import { KoryManager } from "./kory/manager";
import { applyModeIntegration } from "./kory/manager-mode-integration";
import { Bot } from "grammy";
import { TelegramBridge } from "./telegram/bot";
import { DiscordBridge, createDiscordClient } from "./discord/bot";
import { SlackBridge } from "./slack/bot";
import { messagingGateway } from "./messaging";
import { TelegramAdapter, DiscordAdapter, SlackAdapter } from "./messaging";
import { MCPManager } from "./mcp/client";
import { wsBroker } from "./pubsub";
import { serverLog } from "./logger";
import { getCorsHeaders, addCorsOrigins, getSecurityHeaders, encryptForStorage, initializeEncryption } from "./security";
import { RateLimiter } from "./security/rate-limit";
import { handleError, generateCorrelationId } from "./errors";
import { RATE_LIMIT, VERSION } from "./constants";
import { validateEnvironment } from "./config-schema";
import { nanoid } from "nanoid";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initDb } from "./db/sqlite";
import { initCreditAccountant, stopCreditPolling } from "./credit-accountant";
import { PROJECT_ROOT, BACKEND_ROOT } from "./runtime/paths";
import { loadConfig } from "./runtime/config";
import { loadEnvFromProject, persistEnvVar } from "./runtime/env";
import { SessionStore } from "./stores/session-store";
import { MessageStore } from "./stores/message-store";
import { WSManager, type WSClientData } from "./ws/ws-manager";
import { createWebSocketHandlers } from "./server/websocket-handler";
import { Router, authMiddleware } from "./routes";
import { getMetricsRegistry } from "./metrics";
import { initializeSessionMemory, deleteSessionMemory } from "./memory/unified-memory";
import { ID } from "./constants";
import type { WSMessage, APIResponse } from "@koryphaios/shared";
import type { RouteDependencies } from "./routes/types";
import { findAvailablePort, writePortFile, cleanupPortFile } from "./utils/port-utils";

// ─── Helper Functions ───────────────────────────────────────────────────────

function json(data: APIResponse, status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
    });
}

function withCors(res: Response, corsHeaders: Record<string, string>): Response {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function loadPlugins(tools: ToolRegistry): Promise<void> {
    const pluginsDir = join(BACKEND_ROOT, "src/plugins");
    if (!existsSync(pluginsDir)) return;

    const files = readdirSync(pluginsDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
    for (const file of files) {
        try {
            const plugin = await import(join(pluginsDir, file));
            if (plugin.default && typeof plugin.default === "function") {
                plugin.default(tools);
                serverLog.info({ plugin: file }, "Loaded plugin");
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            serverLog.error({ plugin: file, error: message }, "Failed to load plugin");
        }
    }
}

// ─── Main Server ────────────────────────────────────────────────────────────

async function main() {
    serverLog.info("═══════════════════════════════════════");
    serverLog.info(`       KORYPHAIOS v${VERSION}`);
    serverLog.info("  AI Agent Orchestration Dashboard");
    serverLog.info("═══════════════════════════════════════");

    // Load .env first so environment variables are available for validation
    loadEnvFromProject(PROJECT_ROOT);
    
    // Validate environment variables
    validateEnvironment();

    let config = loadConfig(PROJECT_ROOT);

    // ─── Dynamic Port Allocation ─────────────────────────────────────────────
    // If the configured port is in use, automatically find an available one
    const preferredPort = config.server.port;
    const actualPort = await findAvailablePort(
        preferredPort,
        29450,  // min port in range
        29500,  // max port in range
        config.server.host
    );
    
    if (actualPort !== preferredPort) {
        serverLog.warn({ 
            requestedPort: preferredPort, 
            actualPort 
        }, "Port conflict resolved - using alternative port");
        
        // Update config with the actual port
        config = {
            ...config,
            server: {
                ...config.server,
                port: actualPort,
            },
        };
    }
    
    // Write port file for desktop app discovery
    writePortFile(PROJECT_ROOT, actualPort, config.server.host);
    
    // Clean up port file on graceful shutdown
    process.on("exit", () => cleanupPortFile(PROJECT_ROOT));
    process.on("SIGINT", () => {
        cleanupPortFile(PROJECT_ROOT);
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        cleanupPortFile(PROJECT_ROOT);
        process.exit(0);
    });

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
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        serverLog.warn({ err: message }, "Envelope encryption unavailable; API keys will use legacy encryption");
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

    // Apply mode integration (sets up GitManager for mode context)
    applyModeIntegration(kory);

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
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            serverLog.error({ error: errorMessage }, "WebSocket pub/sub reader error");
        }
    })();

    // Messaging gateway + bridges (optional — each starts only if configured)
    let gatewayStarted = false;
    function ensureGateway() {
        if (!gatewayStarted) {
            messagingGateway.start();
            gatewayStarted = true;
        }
    }

    // Telegram bridge
    let telegram: TelegramBridge | undefined;
    if (config.telegram?.botToken && config.telegram.adminId) {
        ensureGateway();
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

    // Discord bridge
    let discord: DiscordBridge | undefined;
    if (config.discord?.botToken) {
        ensureGateway();
        const discordClient = createDiscordClient();
        const discordAdapter = new DiscordAdapter(discordClient);
        discord = new DiscordBridge(
            {
                botToken: config.discord.botToken,
                allowedGuildIds: config.discord.allowedGuildIds,
                allowedUserIds: config.discord.allowedUserIds,
            },
            kory,
            messagingGateway,
            discordAdapter,
        );
        serverLog.info("Discord bridge enabled");
    }

    // Slack bridge
    let slack: SlackBridge | undefined;
    if (config.slack?.botToken && config.slack.appToken) {
        ensureGateway();
        const { WebClient } = await import("@slack/web-api");
        const slackWebClient = new WebClient(config.slack.botToken);
        const slackAdapter = new SlackAdapter(slackWebClient);
        slack = new SlackBridge(
            {
                botToken: config.slack.botToken,
                appToken: config.slack.appToken,
                signingSecret: config.slack.signingSecret,
                allowedChannelIds: config.slack.allowedChannelIds,
                allowedUserIds: config.slack.allowedUserIds,
            },
            kory,
            messagingGateway,
            slackAdapter,
        );
        serverLog.info("Slack bridge enabled (Socket Mode)");
    }

    // Initialize rate limiter
    const rateLimiter = new RateLimiter(RATE_LIMIT.MAX_REQUESTS, RATE_LIMIT.WINDOW_MS);

    // Create route dependencies
    const routeDeps: RouteDependencies = {
        config,
        providers,
        tools,
        kory,
        sessions,
        messages,
        wsManager,
        telegram,
        mcpManager,
    };

    // Create router
    const router = new Router(routeDeps, { rateLimiter });
    router.use(authMiddleware());

    // ─── HTTP + WebSocket Server ────────────────────────────────────────────

    let server: Server<WSClientData>;
    try {
        server = Bun.serve<WSClientData>({
            port: config.server.port,
            hostname: config.server.host,

            async fetch(req, server) {
                const url = new URL(req.url);
                const method = req.method;
                const origin = req.headers.get("origin");
                const requestId = generateCorrelationId();

                try {
                    serverLog.debug({ requestId, method, path: url.pathname }, "Incoming request");

                    // Guard against path traversal
                    if (req.url.includes("/api/sessions/") && req.url.includes("..")) {
                        const corsHeaders = getCorsHeaders(origin);
                        return json({ ok: false, error: "Invalid session ID" }, 400, corsHeaders);
                    }

                    // Get CORS and security headers
                    const corsHeaders = { ...getCorsHeaders(origin), ...getSecurityHeaders() };

                    // Handle CORS preflight
                    if (method === "OPTIONS") {
                        return new Response(null, { status: 204, headers: corsHeaders });
                    }

                    // Rate limiting
                    const clientIp = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
                    const rateCheck = rateLimiter.check(clientIp);
                    if (!rateCheck.allowed) {
                        return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
                    }

                    // WebSocket upgrade
                    if (url.pathname === "/ws") {
                        const userId = "system";
                        const upgraded = server.upgrade(req, {
                            data: { id: nanoid(ID.WS_CLIENT_ID_LENGTH), userId },
                        });
                        if (upgraded) return undefined;
                        return json({ ok: false, error: "WebSocket upgrade failed" }, 400, corsHeaders);
                    }

                    // Telegram webhook (special handling)
                    if (url.pathname === "/api/telegram/webhook" && telegram) {
                        try {
                            const handler = telegram.getWebhookHandler();
                            return await handler(req);
                        } catch (err: unknown) {
                            const message = err instanceof Error ? err.message : String(err);
                            return json({ ok: false, error: message }, 500, corsHeaders);
                        }
                    }

                    // Let the router handle the request
                    const response = await router.handle(req);
                    return withCors(response, corsHeaders);

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

            websocket: createWebSocketHandlers({ wsManager, sessions, kory, providers }),
        });
    } catch (err: unknown) {
        // Handle port conflicts and other startup errors
        const errObj = err instanceof Error ? err : null;
        const code = (err as NodeJS.ErrnoException)?.code;
        const message = errObj?.message ?? String(err);
        if (code === "EADDRINUSE" || message.includes("port") || message.includes("address already in use")) {
            serverLog.fatal({
                port: config.server.port,
                host: config.server.host,
                error: message,
                code,
            }, `Port ${config.server.port} is already in use. Please check if another instance is running or change the port in koryphaios.json or KORYPHAIOS_PORT env var.`);
            throw new Error(`Port ${config.server.port} is already in use. Is another Koryphaios instance running?`);
        }
        throw err;
    }

    serverLog.info({ host: config.server.host, port: config.server.port }, "Server running");
    serverLog.info({ url: `ws://${config.server.host}:${config.server.port}/ws` }, "WebSocket ready");
    serverLog.info({ url: `http://${config.server.host}:${config.server.port}/api/events` }, "SSE fallback ready");

    if (telegram && process.env.TELEGRAM_POLLING === "true") {
        await telegram.startPolling();
    }

    if (discord) {
        discord.start().catch((err: Error) => {
            serverLog.error({ err }, "Discord bot failed to start");
        });
    }

    if (slack) {
        slack.start().catch((err: Error) => {
            serverLog.error({ err }, "Slack bot failed to start");
        });
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
            // Stop accepting new connections
            server.stop(true);
            serverLog.info("Server stopped accepting new connections");

            // Cancel all running agents
            kory.cancel();
            serverLog.info("Cancelled all running agents");

            // Close WebSocket connections gracefully
            wsManager.broadcast({
                type: "system.info",
                payload: { message: "Server shutting down" },
                timestamp: Date.now(),
            });
            serverLog.info("Notified WebSocket clients");

            // Wait a moment for final messages to send
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Shut down pub/sub broker
            wsBroker.shutdown();

            // Stop messaging gateway
            messagingGateway.stop();

            // Stop credit polling timer
            stopCreditPolling();

            // Clean up rate limiter
            rateLimiter.destroy();

            serverLog.info("Graceful shutdown complete");
            process.exit(0);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            serverLog.error({ error: errorMessage }, "Error during graceful shutdown");
            process.exit(1);
        }
    }

    // Register shutdown handlers
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // Handle uncaught errors
    process.on("uncaughtException", (err: Error) => {
        serverLog.fatal(err, "Uncaught exception");
        gracefulShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason: unknown) => {
        serverLog.error({ reason }, "Unhandled promise rejection (server will continue)");
    });
}

// Start the server
main().catch((err: Error) => {
    serverLog.fatal(err, "Failed to start server");
    process.exit(1);
});
