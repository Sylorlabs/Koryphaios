// Server Configuration and Initialization
// Domain: Environment setup and core service initialization
// Extracted from server.ts lines 44-220

import { join } from "node:path";
import { serverLog } from "../logger";
import { validateEnvironment, loadConfig, loadEnvFromProject, addCorsOrigins } from "../runtime/config";
import { initDb } from "../db/sqlite";
import { initCreditAccountant } from "../credit-accountant";
import { initializeEncryption } from "../security";
import { getOrCreateLocalUser, createUser } from "../auth";
import { ProviderRegistry } from "../providers";
import { ToolRegistry } from "../tools";
import {
  BashTool,
  ShellManageTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  DeleteFileTool,
  MoveFileTool,
  DiffTool,
  PatchTool,
  GrepTool,
  GlobTool,
  LsTool,
  WebSearchTool,
  WebFetchTool,
  AskUserTool,
  AskManagerTool,
  DelegateToWorkerTool,
} from "../tools/implementations";
import { loadPlugins } from "../plugins";
import { MCPManager } from "../mcp";
import { SessionStore } from "../stores/session-store";
import { MessageStore } from "../stores/message-store";
import { KoryManager } from "../kory/manager";
import { WSManager } from "../ws/ws-manager";
import { wsBroker } from "../pubsub";
import { TelegramBridge, messagingGateway, Bot, TelegramAdapter } from "../messaging";
import { VERSION, PROJECT_ROOT } from "../constants";
import type { KoryphaiosConfig } from "@koryphaios/shared";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ServerInitializationResult {
  config: KoryphaiosConfig;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  kory: KoryManager;
  wsManager: WSManager;
  sessions: SessionStore;
  messages: MessageStore;
  telegram?: TelegramBridge;
}

export interface ServerConfigDeps {
  projectRoot: string;
}

// ─── Server Configuration Class ─────────────────────────────────────────────────

export class ServerConfigurator {
  private projectRoot: string;

  constructor(deps: ServerConfigDeps) {
    this.projectRoot = deps.projectRoot;
  }

  /**
   * Initialize all server services and configuration.
   * This is the main initialization sequence for the Koryphaios server.
   *
   * @returns ServerInitializationResult with all initialized services
   */
  async initialize(): Promise<ServerInitializationResult> {
    this.logBanner();

    // 1. Environment and configuration
    this.validateEnvironment();
    const config = await this.loadConfiguration();

    // 2. Database and persistence
    const db = await this.initializeDatabase(config);
    const creditAccountant = this.initializeCreditAccountant(config);

    // 3. Encryption and security
    await this.initializeEncryption();

    // 4. User management
    await this.initializeUsers(config);

    // 5. Providers and tools
    const providers = await this.initializeProviders(config);
    const tools = await this.initializeTools();
    const mcpManager = await this.initializeMCP(config, tools);

    // 6. Session management
    const sessions = new SessionStore();
    const messages = new MessageStore();

    // 7. Core orchestration
    const kory = this.initializeKory(providers, tools, sessions, messages, config);

    // 8. Real-time communication
    const wsManager = this.initializeWebSocket(kory);

    // 9. Optional services
    const telegram = await this.initializeTelegram(config, kory);

    return {
      config,
      providers,
      tools,
      kory,
      wsManager,
      sessions,
      messages,
      telegram,
    };
  }

  /**
   * Log server startup banner.
   */
  private logBanner(): void {
    serverLog.info("═══════════════════════════════════════");
    serverLog.info(`       KORYPHAIOS v${VERSION}`);
    serverLog.info("  AI Agent Orchestration Dashboard");
    serverLog.info("═══════════════════════════════════════");
  }

  /**
   * Validate environment variables.
   */
  private validateEnvironment(): void {
    validateEnvironment();
  }

  /**
   * Load and process server configuration.
   */
  private async loadConfiguration(): Promise<KoryphaiosConfig> {
    const config = loadConfig(this.projectRoot);

    // Load .env so persisted provider API keys are available after server restart
    loadEnvFromProject(this.projectRoot);

    // Register any extra CORS origins from config
    if (config.corsOrigins?.length) {
      addCorsOrigins(config.corsOrigins);
      serverLog.info({ origins: config.corsOrigins }, "Registered extra CORS origins");
    }

    return config;
  }

  /**
   * Initialize SQLite database.
   */
  private async initializeDatabase(config: KoryphaiosConfig) {
    const dbPath = join(this.projectRoot, config.dataDirectory);
    await initDb(dbPath);
    serverLog.info({ dbPath }, "Database initialized");
  }

  /**
   * Initialize credit accountant for cost tracking.
   */
  private initializeCreditAccountant(config: KoryphaiosConfig) {
    const dataPath = join(this.projectRoot, config.dataDirectory);
    initCreditAccountant(dataPath, {
      openaiApiKey: process.env.OPENAI_API_KEY,
      githubEnterpriseId: process.env.GITHUB_ENTERPRISE_ID,
      githubToken: process.env.GITHUB_TOKEN,
    });
    serverLog.info("Credit accountant initialized");
  }

  /**
   * Initialize envelope encryption.
   */
  private async initializeEncryption(): Promise<void> {
    try {
      await initializeEncryption();
      serverLog.info("Envelope encryption initialized");
    } catch (err: any) {
      serverLog.warn({ err: err?.message }, "Envelope encryption unavailable; API keys will use legacy encryption");
    }
  }

  /**
   * Initialize user accounts.
   */
  private async initializeUsers(config: KoryphaiosConfig): Promise<void> {
    // Ensure local system user exists (no sign-in required)
    try {
      await getOrCreateLocalUser();
      serverLog.info("Local system user ready (no sign-in required)");
    } catch (err: any) {
      serverLog.error({ err }, "Failed to create local system user");
      throw err;
    }

    // Create default admin user only when explicitly enabled
    const createDefaultAdmin = process.env.CREATE_DEFAULT_ADMIN === "true";
    if (createDefaultAdmin) {
      const { getDb } = await import("../db/sqlite");
      const userCount = (getDb().query("SELECT COUNT(*) as count FROM users").get() as any)?.count ?? 0;
      if (userCount === 0) {
        const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
        if (!adminPassword || adminPassword.length < 12) {
          throw new Error(
            "ADMIN_INITIAL_PASSWORD must be set (min 12 chars) to create the default admin user. " +
            "Use: openssl rand -base64 18"
          );
        }
        const adminUser = await createUser("admin", adminPassword, true);
        if ("id" in adminUser) {
          serverLog.info("Created default admin user (username: admin)");
          serverLog.warn("Change the admin password after first login.");
        }
      }
    }
  }

  /**
   * Initialize LLM provider registry.
   */
  private async initializeProviders(config: KoryphaiosConfig): Promise<ProviderRegistry> {
    const providers = new ProviderRegistry(config);
    await providers.initializeEncryptedCredentials();
    serverLog.info("Provider registry initialized");
    return providers;
  }

  /**
   * Initialize tool registry with all standard tools.
   */
  private async initializeTools(): Promise<ToolRegistry> {
    const tools = new ToolRegistry();

    // Register core tools
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

    serverLog.info("Tool registry initialized");
    return tools;
  }

  /**
   * Initialize MCP (Model Context Protocol) connections.
   */
  private async initializeMCP(config: KoryphaiosConfig, tools: ToolRegistry): Promise<MCPManager> {
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

    return mcpManager;
  }

  /**
   * Initialize Kory manager agent.
   */
  private initializeKory(
    providers: ProviderRegistry,
    tools: ToolRegistry,
    sessions: SessionStore,
    messages: MessageStore,
    config: KoryphaiosConfig
  ): KoryManager {
    const kory = new KoryManager(providers, tools, this.projectRoot, config, sessions, messages);
    serverLog.info("Kory manager initialized");
    return kory;
  }

  /**
   * Initialize WebSocket manager and pub/sub bridge.
   */
  private initializeWebSocket(kory: KoryManager): WSManager {
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
        serverLog.error({ err }, "WebSocket pub/sub reader error");
      }
    })();

    serverLog.info("WebSocket manager initialized");
    return wsManager;
  }

  /**
   * Initialize Telegram bridge (optional).
   */
  private async initializeTelegram(config: KoryphaiosConfig, kory: KoryManager): Promise<TelegramBridge | undefined> {
    if (!config.telegram?.botToken || !config.telegram?.adminId) {
      return undefined;
    }

    messagingGateway.start();
    const bot = new Bot(config.telegram.botToken);
    const telegramAdapter = new TelegramAdapter(bot);
    const telegram = new TelegramBridge(
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
    return telegram;
  }
}

// ─── Convenience Function ────────────────────────────────────────────────────────

/**
 * Initialize all server services.
 * This is the main entry point for server initialization.
 *
 * @param projectRoot - Root directory of the project
 * @returns ServerInitializationResult with all initialized services
 */
export async function initializeServer(projectRoot: string): Promise<ServerInitializationResult> {
  const configurator = new ServerConfigurator({ projectRoot });
  return configurator.initialize();
}
