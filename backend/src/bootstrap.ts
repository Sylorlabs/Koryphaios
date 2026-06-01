/**
 * Koryphaios Backend Bootstrap Module
 * Handles initialization of databases, tools, supervisors, bots, and configs.
 */

import { join } from 'node:path';
import { Bot } from 'grammy';
import { ProviderRegistry } from './providers';
import { ToolRegistry } from './tools';
import { KoryManager } from './kory/manager';
import { SessionStore } from './stores/session-store';
import { MessageStore } from './stores/message-store';
import { TaskStore } from './stores/task-store';
import { loadConfig } from './runtime/config';
import { PROJECT_ROOT } from './runtime/paths';
import { loadEnvFromProject, validateEnvironment } from './runtime/env';
import { initDb } from './db';
import { processSupervisor } from './process-supervisor/supervisor';
import { initCreditAccountant } from './credit-accountant';
import { initializeEncryption } from './security';
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
  MCPDetectErrorsTool,
  MCPAnalyzeErrorTool,
  MCPSuggestFixesTool,
} from './tools';
import { initMCP } from './mcp/client';
import { serverLog } from './logger';
import {
  TelegramAdapter,
  DiscordAdapter,
  SlackAdapter,
} from './messaging';
import { MessagingGateway } from './messaging/gateway';
import { TelegramBridge } from './telegram/bot';
import { DiscordBridge } from './discord/bot';
import { Client as DiscordClient, GatewayIntentBits } from 'discord.js';
import { WebClient } from '@slack/web-api';
import { SlackBridge } from './slack/bot';
import { applyModeIntegration } from './kory/manager-mode-integration';
import { initWSBroker } from './ws/broker';
import { WSManager, setWsManager } from './ws/ws-manager';
import { loadPlugins } from './server/plugins';
import { setContext, type AppContext } from './context';
import { getModeManager } from './mode';
import { TimeTravelService } from './services/timetravel';

export async function bootstrap(): Promise<AppContext> {
  // Load environment and validate
  loadEnvFromProject(PROJECT_ROOT);
  validateEnvironment();

  const config = loadConfig(PROJECT_ROOT);

  // Initialize ModeManager early with config mode
  getModeManager({ mode: config.mode });

  // Initialize DB, Supervisor, and CreditAccountant
  await initDb();
  await processSupervisor.initialize();
  initCreditAccountant(join(PROJECT_ROOT, config.dataDirectory), {
    openaiApiKey: process.env.OPENAI_API_KEY,
    githubEnterpriseId: process.env.GITHUB_ENTERPRISE_ID,
    githubToken: process.env.GITHUB_TOKEN,
  });

  // Initialize Encryption
  await initEncryption();

  // Providers & Tools
  const providers = new ProviderRegistry(config);
  await providers.initializeEncryptedCredentials();

  const tools = await initTools();

  // MCP Connections
  const mcpManager = await initMCP(config, tools);

  // Stores & Core
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const timeTravel = new TimeTravelService(PROJECT_ROOT, messages);

  const kory = new KoryManager(
    providers,
    tools,
    PROJECT_ROOT,
    config,
    sessions,
    messages,
    tasks,
    timeTravel,
  );
  applyModeIntegration(kory);

  const wsManager = new WSManager();
  setWsManager(wsManager);
  initWSBroker(wsManager);

  // Bridges (Telegram, Discord, Slack)
  const bridges = await initBridges(config, kory);

  const context: AppContext = {
    config,
    providers,
    tools,
    mcpManager,
    sessions,
    messages,
    tasks,
    kory,
    wsManager,
    timeTravel,
    ...bridges,
  };

  setContext(context);
  return context;
}

async function initEncryption() {
  try {
    await initializeEncryption();
    serverLog.info('Envelope encryption initialized');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV === 'production') {
      serverLog.fatal({ err: message }, 'Envelope encryption failed in production mode');
      throw new Error(
        `Encryption initialization failed: ${message}. Set up an external KMS provider.`,
      );
    }
    serverLog.warn(
      { err: message },
      'Envelope encryption unavailable; API keys will use legacy encryption',
    );
  }
}

async function initTools() {
  const tools = new ToolRegistry();
  const defaultTools = [
    new BashTool(),
    new ShellManageTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new DeleteFileTool(),
    new MoveFileTool(),
    new DiffTool(),
    new PatchTool(),
    new GrepTool(),
    new GlobTool(),
    new LsTool(),
    new WebSearchTool(),
    new WebFetchTool(),
    new AskUserTool(),
    new AskManagerTool(),
    new MCPDetectErrorsTool(),
    new MCPAnalyzeErrorTool(),
    new MCPSuggestFixesTool(),
  ];

  for (const tool of defaultTools) {
    tools.register(tool);
  }

  return tools;
}

async function initBridges(config: any, kory: KoryManager) {
  const messagingGateway = new MessagingGateway();

  let telegram: TelegramBridge | undefined;
  let discord: DiscordBridge | undefined;
  let slack: SlackBridge | undefined;

  if (config.telegram?.enabled && config.telegram?.botToken) {
    telegram = new TelegramBridge(
      {
        botToken: config.telegram.botToken,
        adminId: config.telegram.adminId ?? 0,
      },
      kory,
      messagingGateway,
      new TelegramAdapter(new Bot(config.telegram.botToken)),
    );
    serverLog.info('Telegram bridge enabled');
  }

  if (config.discord?.enabled && config.discord?.botToken) {
    const client = new DiscordClient({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    discord = new DiscordBridge(
      {
        botToken: config.discord.botToken,
        allowedUserIds: config.discord.allowedUserIds,
      },
      kory,
      messagingGateway,
      new DiscordAdapter(client),
    );
    serverLog.info('Discord bridge enabled');
  }

  if (config.slack?.enabled && config.slack?.botToken && config.slack?.appToken) {
    slack = new SlackBridge(
      {
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        allowedUserIds: config.slack.allowedUserIds,
      },
      kory,
      messagingGateway,
      new SlackAdapter(new WebClient(config.slack.botToken)),
    );
    serverLog.info('Slack bridge enabled');
  }

  return { telegram, discord, slack };
}
