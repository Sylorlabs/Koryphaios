/**
 * Koryphaios Backend Bootstrap Module
 * Handles initialization of databases, tools, supervisors, bots, and configs.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ProviderRegistry } from './providers';
import { registerLiveModelResolver } from './providers/models';
import { ToolRegistry } from './tools';
import { KoryManager } from './kory/manager';
import { SessionStore } from './stores/session-store';
import { MessageStore } from './stores/message-store';
import { TaskStore } from './stores/task-store';
import { GoalStore } from './stores/goal-store';
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
  LoadSkillDetailTool,
  StartWorkflowTool,
  UpdateWorkflowTool,
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
import { GoalDriveService } from './kory/goal-drive-service';

export async function bootstrap(): Promise<AppContext> {
  // Load environment and validate
  loadEnvFromProject(PROJECT_ROOT);
  validateEnvironment();

  // ── Wire CLI deep-integration bridge scripts ────────────────────────────
  // The CLI bridges (cli-bridges.ts, devin-bridge.ts) read these env vars to
  // spawn the kory MCP server + hook bridge as subprocesses of each native CLI
  // (claude, codex, devin, grok, cursor, cline, antigravity). Without them,
  // MCP/hooks wiring silently no-ops and CLIs lose access to kory__ tools.
  // Resolve the bundled scripts relative to this module so they work in both
  // dev (ts) and packaged (compiled) layouts.
  if (!process.env.KORY_MCP_BRIDGE_SCRIPT) {
    const devScript = join(import.meta.dir, 'providers', 'kory-mcp-bridge.ts');
    const builtScript = join(import.meta.dir, 'providers', 'kory-mcp-bridge.js');
    process.env.KORY_MCP_BRIDGE_SCRIPT = existsSync(devScript)
      ? devScript
      : existsSync(builtScript)
        ? builtScript
        : '';
  }
  if (!process.env.KORY_HOOK_BRIDGE_SCRIPT) {
    const devScript = join(import.meta.dir, 'providers', 'kory-hook-bridge.ts');
    const builtScript = join(import.meta.dir, 'providers', 'kory-hook-bridge.js');
    process.env.KORY_HOOK_BRIDGE_SCRIPT = existsSync(devScript)
      ? devScript
      : existsSync(builtScript)
        ? builtScript
        : '';
  }
  // The MCP bridge spawns via `node <script>`; ensure the command is set.
  if (!process.env.KORY_MCP_BRIDGE_COMMAND) {
    process.env.KORY_MCP_BRIDGE_COMMAND = process.execPath;
  }

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
  const goals = new GoalStore();
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
  const goalDriver = new GoalDriveService(goals, sessions, kory, wsManager);

  const context: AppContext = {
    config,
    providers,
    tools,
    mcpManager,
    sessions,
    messages,
    tasks,
    goals,
    goalDriver,
    kory,
    wsManager,
    timeTravel,
  };

  setContext(context);
  await goalDriver.recover();
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
import { CreateGoalTool, UpdateGoalTool } from './tools/goals';
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
    new CreateGoalTool(),
    new UpdateGoalTool(),
    new LoadSkillDetailTool(),
    new StartWorkflowTool(),
    new UpdateWorkflowTool(),
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
