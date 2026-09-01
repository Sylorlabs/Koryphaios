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
  ManageMcpServerTool,
  FetchContextTool,
  PruneContextTool,
  LoadSkillDetailTool,
  ListWorkflowsTool,
  StartWorkflowTool,
  UpdateWorkflowTool,
  CreateWorkflowDraftTool,
  GetResourceBudgetTool,
} from './tools';
import { initMCP } from './mcp/client';
import { serverLog } from './logger';
import { applyModeIntegration } from './kory/manager-mode-integration';
import { initWSBroker } from './ws/broker';
import { WSManager } from './ws/ws-manager';
import { loadPlugins } from './server/plugins';
import { setContext, type AppContext } from './context';
import { getModeManager } from './mode';
import { TimeTravelService } from './services/timetravel';
import { startBackgroundCleanup } from './memory/background-cleanup';
import { GoalDriveService } from './kory/goal-drive-service';
import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { cliResearchBoundary, hasResearchCitation } from './providers/cli-research';
import { initEnforcedSpendCapsTable } from './security/spend-caps-enforced';
import { recoverInterruptedSessionErasures } from './services/session-erasure-service';
import { SessionRunStore } from './runs/session-run-store';
import { SessionRunCoordinator } from './runs/session-run-coordinator';

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
  await initEnforcedSpendCapsTable();
  initCreditAccountant(join(PROJECT_ROOT, config.dataDirectory), {
    openaiApiKey: process.env.OPENAI_API_KEY,
    githubEnterpriseId: process.env.GITHUB_ENTERPRISE_ID,
    githubToken: process.env.GITHUB_TOKEN,
  });
  // Reconcile any crash-interrupted delete before providers, Goal recovery,
  // process supervision, WebSockets, or HTTP readiness can revive the session.
  await recoverInterruptedSessionErasures();

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
    } catch (err: unknown) {
      serverLog.debug(
        { provider: providerName, modelId, err: err instanceof Error ? err.message : String(err) },
        'Live model resolver lookup failed',
      );
      return undefined;
    }
  });

  const tools = await initTools(providers);

  // MCP Connections
  const mcpManager = await initMCP(config, tools);

  // Stores & Core
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const goals = new GoalStore();
  const timeTravel = new TimeTravelService(PROJECT_ROOT, messages);

  // The WebSocket manager is a projection sink, not the lifecycle owner.
  // Initialize it before Kory so SessionRun can commit transitions to its
  // transactional outbox and publish/recover them through one boundary.
  const wsManager = new WSManager();
  initWSBroker(wsManager);
  const runs = new SessionRunCoordinator(new SessionRunStore(), (sessionId, message) =>
    wsManager.broadcastToSession(sessionId, message),
  );
  await runs.drainOutbox();
  const orphanedWaits = await runs.recoverOrphanedWaits();
  if (orphanedWaits > 0) {
    serverLog.error(
      { count: orphanedWaits },
      'Failed closed orphaned authoritative session-run waits',
    );
  }
  const interruptedRuns = await runs.recoverInterruptedRuns();
  if (interruptedRuns > 0) {
    serverLog.warn({ count: interruptedRuns }, 'Recovered interrupted authoritative session runs');
  }
  runs.startOutboxPump();

  const kory = new KoryManager(
    providers,
    tools,
    PROJECT_ROOT,
    config,
    sessions,
    messages,
    tasks,
    timeTravel,
    runs,
  );
  applyModeIntegration(kory);

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
    runs,
  };

  setContext(context);
  // Kory subscribed during construction; initialize only after the WebSocket
  // broker and AppContext exist so restart-recovery terminal events can be
  // surfaced and drained without racing bootstrap dependencies.
  await processSupervisor.initialize();
  const recoveredProcessWaits = await kory.recoverDurableProcessWaits();
  if (
    recoveredProcessWaits.queued > 0 ||
    recoveredProcessWaits.preserved > 0 ||
    recoveredProcessWaits.cancelled > 0 ||
    recoveredProcessWaits.failed > 0
  ) {
    serverLog.info(recoveredProcessWaits, 'Reconciled durable background-process waits');
  }
  const recoveredQuestionHandoffs = await kory.recoverDurableQuestionHandoffs();
  if (recoveredQuestionHandoffs.requeued > 0 || recoveredQuestionHandoffs.queued > 0) {
    serverLog.info(
      recoveredQuestionHandoffs,
      'Reconciled durable answered-question handoffs',
    );
  }
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
      'Envelope encryption unavailable; credential writes and legacy migrations are disabled until secure key management is restored',
    );
  }
}

import { registerGitTools, registerCheckpointTools } from './tools';
import { CreateGoalTool, UpdateGoalTool } from './tools/goals';
import { noteTools } from './tools/notes';

/** Build the authoritative runtime tool registry without starting the backend. */
export async function initTools(providers: ProviderRegistry) {
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
    new WebSearchTool(async ({ query, maxResults, context }) => {
      const researchSandbox = {
        ...SANDBOX_PRESETS.readonly,
        allowNetwork: true,
        allowWebSearch: true,
      };
      const supported = ['grok', 'claude', 'devin'] as const;
      const preferred =
        context.activeProvider &&
        supported.includes(context.activeProvider as (typeof supported)[number])
          ? (context.activeProvider as (typeof supported)[number])
          : null;
      const candidates = [...new Set([preferred, ...supported].filter(Boolean))] as Array<
        (typeof supported)[number]
      >;

      for (const providerName of candidates) {
        if (!cliResearchBoundary(providerName).eligible) continue;
        const provider = providers.get(providerName);
        if (!provider?.isAvailable()) continue;
        await provider.refreshModels?.(true);
        const model = provider.listModels()[0];
        if (!model) continue;
        let output = '';
        let failed = false;
        for await (const event of providers.executeWithRetry(
          {
            model: model.id,
            systemPrompt:
              'Perform web research only. Use the provider native web search/fetch capability. Do not inspect local files, run shell commands, modify anything, call MCP tools, or delegate. Return concise results with source URLs.',
            messages: [
              {
                role: 'user',
                content: `Search the web for: ${query}\nReturn at most ${maxResults} useful results with title, URL, and a short factual snippet.`,
              },
            ],
            tools: [],
            maxTokens: 4_000,
            signal: context.signal,
            sessionId: `${context.sessionId}:web-search:${providerName}`,
            harnessRole: 'critic',
            permissionMode: 'plan',
            sandbox: researchSandbox,
            capabilityProfile: 'research-only',
          },
          providerName,
        )) {
          if (event.type === 'content_delta') output += event.content ?? '';
          if (event.type === 'error') {
            failed = true;
            serverLog.debug(
              { provider: providerName, error: event.error },
              'CLI web search candidate failed',
            );
          }
        }
        if (!failed && hasResearchCitation(output)) {
          return `Provider: ${providerName}\n\n${output.trim()}`;
        }
        if (!failed && output.trim()) {
          serverLog.debug(
            { provider: providerName },
            'CLI web search candidate returned no source URL',
          );
        }
      }
      return null;
    }),
    new WebFetchTool(),
    new AskUserTool(),
    new AskManagerTool(),
    new DelegateToWorkerTool(),
    new DelegateToJulesTool(),
    new MCPDetectErrorsTool(),
    new MCPAnalyzeErrorTool(),
    new MCPSuggestFixesTool(),
    new ManageMcpServerTool(),
    new FetchContextTool(),
    new PruneContextTool(),
    new CreateGoalTool(),
    new UpdateGoalTool(),
    new LoadSkillDetailTool(),
    new ListWorkflowsTool(),
    new StartWorkflowTool(),
    new UpdateWorkflowTool(),
    new CreateWorkflowDraftTool(),
    new GetResourceBudgetTool(providers),
  ];

  for (const tool of defaultTools) {
    tools.register(tool);
  }

  registerGitTools(tools);
  registerCheckpointTools(tools);

  for (const tool of noteTools) {
    tools.register(tool);
  }

  return tools;
}
