/**
 * Koryphaios Backend Bootstrap Module
 * Handles initialization of databases, tools, supervisors, bots, and configs.
 */

import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ProviderRegistry } from './providers';
import { ToolRegistry } from './tools';
import { KoryManager } from './kory/manager';
import { SessionStore } from './stores/session-store';
import { MessageStore } from './stores/message-store';
import { TaskStore } from './stores/task-store';
import { GoalStore } from './stores/goal-store';
import { ChecklistStore } from './stores/checklist-store';
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
  GenerateVideoTool,
  RememberTool,
  RecallTool,
  ForgetTool,
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
  RenameSessionTool,
  ForkChatTool,
  AskManagerTool,
  DelegateToWorkerTool,
  ManageReviewAgentsTool,
  ManageAgentsTool,
  SendAgentMessageTool,
  RequestManagerRelayTool,
  ListAgentMessagesTool,
  ListSessionsTool,
  ReadSessionTool,
  IsolateChatTool,
  MergeChatBackTool,
  MCPDetectErrorsTool,
  MCPAnalyzeErrorTool,
  MCPSuggestFixesTool,
  ManageMcpServerTool,
  ListMcpToolsTool,
  InvokeMcpTool,
  FetchContextTool,
  PruneContextTool,
  ManageContextTool,
  LoadSkillDetailTool,
  ManageSkillFeedingTool,
  ListWorkflowsTool,
  StartWorkflowTool,
  UpdateWorkflowTool,
  CreateWorkflowDraftTool,
  GetResourceBudgetTool,
  ScheduleMonitorTool,
} from './tools';
import { initMCP } from './mcp/client';
import { serverLog } from './logger';
import { initWSBroker } from './ws/broker';
import { WSManager } from './ws/ws-manager';
import { loadPlugins } from './server/plugins';
import { setContext, type AppContext } from './context';
import { TimeTravelService } from './services/timetravel';
import { startBackgroundCleanup } from './memory/background-cleanup';
import { startCatalogRefresh } from './providers/catalog-refresh';
import { GoalDriveService } from './kory/goal-drive-service';
import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { ListLinkedDevicesTool, ControlLinkedDeviceTool } from './tools/devices';
import { cliResearchBoundary, hasResearchCitation } from './providers/cli-research';
import { createPromptCachePlan } from './providers/prompt-cache';
import { initEnforcedSpendCapsTable } from './security/spend-caps-enforced';
import { recoverInterruptedSessionErasures } from './services/session-erasure-service';
import { SessionRunStore } from './runs/session-run-store';
import { SessionRunCoordinator } from './runs/session-run-coordinator';
import { applyBridgeEnvironment } from './runtime/standalone';
import { reportStartupPhase } from './runtime/startup-status';

export async function bootstrap(): Promise<AppContext> {
  reportStartupPhase('configuration');
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  const finishPhase = (phase: string) => {
    const now = performance.now();
    serverLog.info(
      {
        phase,
        durationMs: Math.round(now - phaseStartedAt),
        elapsedMs: Math.round(now - startedAt),
      },
      'Backend startup phase completed',
    );
    phaseStartedAt = now;
  };
  // Load environment and validate
  loadEnvFromProject(PROJECT_ROOT);
  validateEnvironment();

  // ── Wire CLI deep-integration bridge scripts ────────────────────────────
  applyBridgeEnvironment();

  const config = loadConfig(PROJECT_ROOT);

  finishPhase('configuration');

  reportStartupPhase('database-and-erasure-recovery', 'Opening and migrating the database');
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
  finishPhase('database-and-erasure-recovery');

  // The 0059 compaction defers its one-time VACUUM to the next startup so a
  // multi-minute rebuild never freezes /api/health on a live server. It runs
  // here — synchronous, before the port binds — with the startup-phase marker
  // telling the desktop the process is alive and working.
  {
    const { runPendingStartupVacuum } = await import('./notes/notes-compaction');
    reportStartupPhase('database-vacuum', 'Compacting the database (one-time)');
    if (runPendingStartupVacuum()) finishPhase('database-vacuum');
  }

  reportStartupPhase('encryption');
  // Initialize Encryption
  await initEncryption();
  finishPhase('encryption');

  reportStartupPhase('providers');
  // Providers & Tools
  const providers = new ProviderRegistry(config);
  await providers.initializeEncryptedCredentials();
  finishPhase('providers');

  reportStartupPhase('tools');
  const tools = await initTools(providers);
  finishPhase('tools');

  reportStartupPhase('mcp-connections');
  // MCP Connections
  // Scope MCP clients — and their OAuth grants — to the same project root the
  // settings API resolves, so a token stored via the UI is found at connect time.
  const mcpManager = await initMCP(config, tools, PROJECT_ROOT);
  finishPhase('mcp-connections');

  reportStartupPhase('session-runtime');
  // Stores & Core
  const sessions = new SessionStore();
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const goals = new GoalStore();
  const checklists = new ChecklistStore();
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

  // Steering commands parked behind a run outlive the process that queued
  // them. Requeue any claim interrupted mid-dispatch, then resume the drains
  // for sessions holding live queue rows so a parked send is not stranded.
  {
    const { agentSteeringStore } = await import('./stores/agent-steering-store');
    const reclaimed = await agentSteeringStore.resetInterruptedClaims();
    if (reclaimed > 0) {
      serverLog.info({ count: reclaimed }, 'Requeued interrupted steering claims');
    }
    for (const steeringSessionId of await agentSteeringStore.listSessionIdsWithActive()) {
      kory.resumeSessionSteering(steeringSessionId);
    }
  }

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
    checklists,
    goalDriver,
    kory,
    wsManager,
    timeTravel,
    runs,
  };

  setContext(context);
  configureAgentMail({ kory, sessions });
  configureSessionsDirectory({ kory, sessions, messages });
  configureChatIsolation({ kory, sessions });
  finishPhase('session-runtime');
  reportStartupPhase('process-and-goal-recovery');
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
    serverLog.info(recoveredQuestionHandoffs, 'Reconciled durable answered-question handoffs');
  }
  await goalDriver.recover();
  // Arm persisted monitors only after recovery has settled, so a due monitor
  // cannot race startup recovery with a new session turn.
  await configureMonitors({
    kory,
    sessions,
    storagePath: resolve(PROJECT_ROOT, config.dataDirectory, 'monitors.json'),
  });
  finishPhase('process-and-goal-recovery');
  reportStartupPhase('background-services');
  startBackgroundCleanup(kory, wsManager);
  // File-backed notes compaction (migration 0059) is deliberately NOT started
  // here: its first batch must never run before the HTTP server is listening.
  // server.ts kicks it off after Bun.serve binds the port.
  // Keep enabled providers' model catalogs warm in the background. Cadence is
  // per-provider by discovery cost and stretches when the user is idle, so new
  // models appear without burning requests or spawning CLIs for a session that
  // is not happening. A changed catalog is pushed to connected clients so the
  // picker updates on its own.
  startCatalogRefresh(providers, {
    onCatalogsChanged: () => {
      try {
        wsManager.broadcastEphemeral({
          type: 'provider.status',
          payload: { providers: providers.getStatus() },
          timestamp: Date.now(),
        });
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to broadcast refreshed provider status',
        );
      }
    },
  });
  finishPhase('background-services');
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

import { registerGitTools, registerCheckpointTools, RequestCriticReviewTool } from './tools';
import { CreateGoalTool, UpdateGoalTool, EditGoalChecklistTool } from './tools/goals';
import { noteTools } from './tools/notes';
import { createComputerUseTools } from './computer-use/tools';
import { checklistTools } from './tools/checklists';
import { configureAgentMail } from './kory/services/agent-mail-service';
import { configureSessionsDirectory } from './tools/sessions-directory';
import { configureChatIsolation } from './tools/chat-isolation';
import { configureMonitors } from './kory/services/monitor-service';

/** Build the authoritative runtime tool registry without starting the backend. */
export async function initTools(providers: ProviderRegistry) {
  const tools = new ToolRegistry();
  const defaultTools = [
    new ListLinkedDevicesTool(),
    new ControlLinkedDeviceTool(),
    ...createComputerUseTools(),
    new BashTool(),
    new ShellManageTool(),
    new ReadFileTool(),
    new ViewImageTool(),
    new GenerateVideoTool(),
    new RememberTool(),
    new RecallTool(),
    new ForgetTool(),
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
        const researchSystemPrompt =
          'Perform web research only. Use the provider native web search/fetch capability. Do not inspect local files, run shell commands, modify anything, call MCP tools, or delegate. Return concise results with source URLs.';
        let output = '';
        let failed = false;
        for await (const event of providers.executeWithRetry(
          {
            model: model.id,
            systemPrompt: researchSystemPrompt,
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
            interactionMode: 'plan',
            sandbox: researchSandbox,
            capabilityProfile: 'research-only',
            promptCache: createPromptCachePlan({
              stableSystemPrompt: researchSystemPrompt,
              providerAdapter: providerName,
              role: 'research',
              workspaceScope: context.workingDirectory,
            }),
            promptCacheKeepaliveMode: 'off',
            cacheLaneKind: 'research',
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
    new RequestCriticReviewTool(),
    new RenameSessionTool(),
    new ForkChatTool(),
    new AskManagerTool(),
    new DelegateToWorkerTool(),
    new ManageReviewAgentsTool(),
    new ManageAgentsTool(),
    new SendAgentMessageTool(),
    new RequestManagerRelayTool(),
    new ListAgentMessagesTool(),
    new ListSessionsTool(),
    new ReadSessionTool(),
    new IsolateChatTool(),
    new MergeChatBackTool(),
    new MCPDetectErrorsTool(),
    new MCPAnalyzeErrorTool(),
    new MCPSuggestFixesTool(),
    new ManageMcpServerTool(),
    new ListMcpToolsTool(tools),
    new InvokeMcpTool(tools),
    new FetchContextTool(),
    new PruneContextTool(),
    new ManageContextTool(),
    new CreateGoalTool(),
    new UpdateGoalTool(),
    new EditGoalChecklistTool(),
    new LoadSkillDetailTool(),
    new ManageSkillFeedingTool(),
    new ListWorkflowsTool(),
    new StartWorkflowTool(),
    new UpdateWorkflowTool(),
    new CreateWorkflowDraftTool(),
    new GetResourceBudgetTool(providers),
    new ScheduleMonitorTool(),
  ];

  for (const tool of defaultTools) {
    tools.register(tool);
  }

  registerGitTools(tools);
  registerCheckpointTools(tools);

  for (const tool of noteTools) {
    tools.register(tool);
  }

  for (const tool of checklistTools) {
    tools.register(tool);
  }

  return tools;
}
