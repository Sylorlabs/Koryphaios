/**
 * Koryphaios Backend Bootstrap Module
 * Handles initialization of databases, tools, supervisors, bots, and configs.
 */

import { join } from 'node:path';
import { ProviderRegistry } from './providers';
import { registerLiveModelResolver } from './providers/models';
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
  ViewImageTool,
  WriteFileTool,
  EditFileTool,
  BatchEditTool,
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
  DelegateToJulesTool,
  MCPDetectErrorsTool,
  MCPAnalyzeErrorTool,
  MCPSuggestFixesTool,
  FetchContextTool,
  PruneContextTool,
} from './tools';
import { initMCP } from './mcp/client';
import { serverLog } from './logger';
import { applyModeIntegration } from './kory/manager-mode-integration';
import { initWSBroker } from './ws/broker';
import { WSManager, setWsManager } from './ws/ws-manager';
import { loadPlugins } from './server/plugins';
import { setContext, type AppContext } from './context';
import { getModeManager } from './mode';
import { TimeTravelService } from './services/timetravel';
import { startBackgroundCleanup } from './memory/background-cleanup';

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

  // Wire live model metadata (CLI/API-discovered context windows, verified
  // flags) into context resolution — designed for this but never registered,
  // which left every CLI model's context window "unknown".
  registerLiveModelResolver((modelId, providerName) => {
    try {
      const p = providers.get(providerName);
      if (!p?.listModels) return undefined;
      return p
        .listModels()
        .find((m) => m.id === modelId || m.apiModelId === modelId || m.name === modelId);
    } catch {
      return undefined;
    }
  });

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
  };

  setContext(context);
  startBackgroundCleanup(kory, wsManager);
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

import { registerGitTools } from './tools';
import { noteTools } from './tools/notes';

async function initTools() {
  const tools = new ToolRegistry();
  const defaultTools = [
    new BashTool(),
    new ShellManageTool(),
    new ReadFileTool(),
    new ViewImageTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new BatchEditTool(),
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
    new DelegateToWorkerTool(),
    new DelegateToJulesTool(),
    new MCPDetectErrorsTool(),
    new MCPAnalyzeErrorTool(),
    new MCPSuggestFixesTool(),
    new FetchContextTool(),
    new PruneContextTool(),
  ];

  for (const tool of defaultTools) {
    tools.register(tool);
  }

  registerGitTools(tools);

  for (const tool of noteTools) {
    tools.register(tool);
  }

  return tools;
}
