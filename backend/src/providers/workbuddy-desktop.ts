// WorkBuddy Desktop provider — drives the installed WorkBuddy AI desktop app's
// own host runtime as a Koryphaios CLI provider.
//
// This is deliberately NOT the standalone `codebuddy` CLI on PATH. The
// WorkBuddy AI desktop app (com.workbuddy.workbuddy-ai) is a separate product
// from the CodeBuddy CLI: it hosts its agent runtime inside the app (sidecar
// + `codebuddy --serve` with the app's Electron binary as the Node runtime)
// and that runtime runs with the desktop app's environment — its user
// settings, its product config, and its auth context — which carries the
// desktop app's limits rather than the standalone CLI's.
//
// Turn flow:
//   1. Locate the installed app and resolve its runtime (Electron binary +
//      bundled CLI + config dir).
//   2. Ensure a runtime process for the turn's working directory (long-lived,
//      idle-reaped; the desktop app keeps its host runtime warm the same way).
//   3. Open an ACP connection (connect → initialize), create a session, pin
//      the model/mode/reasoning dial, and stream the turn's events.
//   4. The Koryphaios MCP bridge (kory__* tools) is injected into the runtime
//      via --mcp-config, exactly like the desktop app injects its own agent
//      MCP config — so every Koryphaios feature (context providers, notes,
//      delegation, …) is available to the runtime as kory__ MCP tools.
//
// The model catalog is read live from the bundled CLI's product.json — the
// same file the runtime itself selects models from — so a desktop app update
// that changes the catalog is picked up on refresh.

import type { ModelDef, ProviderConfig, ProviderName } from '@koryphaios/shared';
import { homedir } from 'node:os';
import { existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { providerLog } from '../logger';
import { safeProviderDiagnostic, safeProviderFailureMessage } from './provider-diagnostics';
import { createCliAttachmentScope, type CliAttachmentScope } from './cli-attachments';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { resolveProductContextBudget } from './product-context-window';
import { buildProviderCliEnv } from './cli-environment';
import { wrapCommand, inferenceSandboxPolicy } from '../collaboration/sandbox-runner';
import { getCliBridge } from './cli-bridges';
import { koryBridgeUnavailableError, resolveKoryBridgeScript } from './kory-cli-mcp-config';
import {
  createDesktopRuntimeSession,
  desktopRuntimeTmpDir,
  findRunningDesktopSidecar,
  locateWorkBuddyDesktopApp,
  SidecarControlClient,
  readWorkBuddyDesktopModels,
  removeMcpConfigFile,
  resolveWorkBuddyDesktopRuntime,
  safeRm,
  spawnDesktopRuntime,
  type DesktopRuntimeHandle,
  type WorkBuddyDesktopApp,
  type WorkBuddyDesktopRuntimePaths,
} from './workbuddy-desktop-runtime';
import {
  WorkBuddyDesktopAcpClient,
  type AcpConfigOption,
  type AcpPromptResult,
  type AcpSessionUpdate,
} from './workbuddy-desktop-acp';
import type { CliCommand, Provider, ProviderEvent, ProviderMessage, StreamRequest } from './types';

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const RUNTIME_IDLE_REAP_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 30 * 60_000;

// ── Model cache (shared across provider instances) ──────────────────────────

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let refreshInProgress = false;
let refreshPromise: Promise<void> | null = null;

export function __resetWorkBuddyDesktopModelCacheForTesting(): void {
  cachedModels = null;
  cachedModelsAt = 0;
  refreshInProgress = false;
  refreshPromise = null;
}

function refreshModelsInBackground(): Promise<void> {
  if (refreshInProgress) return refreshPromise ?? Promise.resolve();
  refreshInProgress = true;
  refreshPromise = (async () => {
    // Stamp the attempt before discovery: an uninstalled (or half-installed)
    // app must not be re-probed on every status render either.
    cachedModelsAt = Date.now();
    const app = locateWorkBuddyDesktopApp();
    const runtime = app ? resolveWorkBuddyDesktopRuntime(app) : null;
    if (!runtime) return;
    const models = readWorkBuddyDesktopModels(runtime);
    // Negative cache: an unreadable product file must not be re-probed on
    // every status render.
    cachedModelsAt = Date.now();
    if (models.length > 0) cachedModels = models;
    else if (!cachedModels) cachedModels = [];
  })()
    .catch((err: unknown) => {
      cachedModelsAt = Date.now();
      providerLog.warn(
        safeProviderDiagnostic('workbuddy-desktop', 'configuration', err),
        'WorkBuddy Desktop model list refresh failed',
      );
    })
    .finally(() => {
      refreshInProgress = false;
      refreshPromise = null;
    });
  return refreshPromise;
}

// ── Runtime pool (keyed by working directory, idle-reaped) ──────────────────

interface ManagedRuntime {
  handle: DesktopRuntimeHandle;
  lastUsedAt: number;
}

const runtimePool = new Map<string, ManagedRuntime>();
// Runtimes hosted by the running desktop app's sidecar (the authenticated
// launch path). Same reaping contract as the direct-spawn pool.
const sidecarRuntimePool = new Map<string, ManagedRuntime>();
let idleReaperStarted = false;

function ensureIdleReaper(): void {
  if (idleReaperStarted) return;
  idleReaperStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [cwd, entry] of runtimePool) {
      if (now - entry.lastUsedAt > RUNTIME_IDLE_REAP_MS) {
        entry.handle.kill();
        runtimePool.delete(cwd);
      }
    }
    for (const [cwd, entry] of sidecarRuntimePool) {
      if (now - entry.lastUsedAt > RUNTIME_IDLE_REAP_MS) {
        entry.handle.kill();
        sidecarRuntimePool.delete(cwd);
      }
    }
  }, 60_000);
  timer.unref?.();
}

async function acquireRuntime(
  runtime: WorkBuddyDesktopRuntimePaths,
  cwd: string,
  mcpConfigPath: string | undefined,
  env: NodeJS.ProcessEnv,
  sandbox: StreamRequest['sandbox'],
): Promise<DesktopRuntimeHandle> {
  ensureIdleReaper();
  const existing = runtimePool.get(cwd);
  if (existing) {
    const exited = await Promise.race([
      existing.handle.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 0).unref?.()),
    ]);
    if (!exited) {
      existing.lastUsedAt = Date.now();
      return existing.handle;
    }
    runtimePool.delete(cwd);
  }

  // Host-imposed OS jail for remote agentic turns: the runtime runs on the
  // host, so the spawn is wrapped. The desktop runtime confines its own
  // commands internally (product policy allowUnsandboxedCommands: false);
  // the OS jail additionally confines the runtime process itself.
  let command = runtime.electronBin;
  let prefixArgs: string[] = [];
  if (sandbox) {
    const wrapped = wrapCommand(runtime.electronBin, [], {
      cwd,
      homeDir: env.HOME,
      configDirs: [runtime.configDir, env.HOME ?? '', desktopRuntimeTmpDir()],
      policy: inferenceSandboxPolicy(sandbox),
    });
    command = wrapped.command;
    prefixArgs = wrapped.args;
  }

  const handle = await spawnDesktopRuntime({
    runtime,
    cwd,
    mcpConfigPath,
    env,
    command,
    prefixArgs,
  });
  runtimePool.set(cwd, { handle, lastUsedAt: Date.now() });
  return handle;
}

// ── Built-in CLI commands (Claude-Code-fork command surface) ────────────────

const WORKBUDDY_DESKTOP_BUILTIN_COMMANDS: Record<string, string> = {
  compact: 'Compress conversation history to save context window space',
  clear: 'Clear conversation history and start fresh',
  cost: 'Show token usage and cost for this session',
  help: 'Show available commands and usage help',
  init: 'Initialize the workspace for WorkBuddy',
  model: 'Switch AI model for this session',
  permissions: 'View or update tool permissions',
  status: 'Show current session status and configuration',
  mcp: 'Manage MCP server connections',
};

// ── Prompt construction ─────────────────────────────────────────────────────

function buildPrompt(
  messages: ProviderMessage[],
  attachments: CliAttachmentScope,
): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const turns = messages.filter((m) => m.role !== 'system');
  const images: Array<{ data: string; mimeType: string }> = [];
  const lines: string[] = [];
  for (const m of turns) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'image' && block.imageData) {
          images.push({ data: block.imageData, mimeType: block.imageMimeType ?? 'image/png' });
        }
      }
    }
    const text = attachments.renderContent(m.content);
    if (!text.trim()) continue;
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return { text: lines.join('\n\n'), images };
}

// ── Event mapping ───────────────────────────────────────────────────────────

interface ToolCallState {
  toolName: string;
  input: unknown;
}

function updateText(update: Record<string, unknown>): string {
  const content = update.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const c = content as { type?: string; text?: unknown };
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof update.text === 'string') return update.text;
  return '';
}

function toolCallOutput(update: Record<string, unknown>): string {
  const content = update.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as {
        type?: string;
        content?: { type?: string; text?: unknown };
        text?: unknown;
      };
      if (typeof e.text === 'string') parts.push(e.text);
      else if (e.content && typeof e.content === 'object') {
        const inner = e.content as { text?: unknown };
        if (typeof inner.text === 'string') parts.push(inner.text);
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'string') return content;
  return '';
}

function toolCallDiff(
  update: Record<string, unknown>,
): { path?: string; oldText?: string; newText?: string } | null {
  const content = update.content;
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { type?: string; path?: unknown; oldText?: unknown; newText?: unknown };
    if (e.type === 'diff') {
      return {
        path: typeof e.path === 'string' ? e.path : undefined,
        oldText: typeof e.oldText === 'string' ? e.oldText : undefined,
        newText: typeof e.newText === 'string' ? e.newText : undefined,
      };
    }
  }
  return null;
}

// ── Refusal diagnostics ─────────────────────────────────────────────────────

/** The runtime reports a refused turn as `stopReason: "refusal"` with the
 *  failure detail nested in `_meta["codebuddy.ai/errorMessage"]` (a JSON
 *  string). Surface a clean, actionable message — the auth case is by far the
 *  most common (an unauthenticated runtime refuses every prompt). */
/**
 * Translate a raw gateway refusal string into an actionable message. The
 * WorkBuddy model gateway rejects turns server-side for two common reasons:
 * a backend the account cannot reach (e.g. the Tencent TokenHub "maas"
 * gateway) or an exhausted quota / credit balance. Both are account/model
 * access issues, not a Koryphaios defect, so say so plainly.
 */
function translateGatewayRefusal(details: string): string {
  if (/backend\s*\[?maas\]?|is not supported/i.test(details)) {
    return (
      `This is a WorkBuddy account/plan limitation, not a Koryphaios problem. ` +
      `WorkBuddy Desktop: the selected model's backend (maas) is not available for this ` +
      `WorkBuddy account. (gateway said: "${details}") ` +
      'Pick a different model (e.g. a Hunyuan model) or check your WorkBuddy plan / maas access, then retry.'
    );
  }
  if (/quota|credit|429|rate.?limit|frequency limit/i.test(details)) {
    return (
      `This is a WorkBuddy account/plan limitation, not a Koryphaios problem. ` +
      `WorkBuddy Desktop: the model request was rejected by WorkBuddy's gateway ` +
      `(quota or rate limit). (gateway said: "${details}") ` +
      'Try again later or choose a model with available quota.'
    );
  }
  // Unknown refusal from the WorkBuddy runtime/gateway. It originates on the
  // WorkBuddy side, so still disclaim Koryphaios to avoid confusing the user.
  return `WorkBuddy Desktop refused the request (this is on WorkBuddy's side, not Koryphaios): ${details}`;
}

function refusalMessage(result: { _meta?: Record<string, unknown> }): string {
  const raw = result._meta?.['codebuddy.ai/errorMessage'];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as {
        message?: unknown;
        data?: { details?: unknown; category?: unknown };
      };
      const details =
        typeof parsed.data?.details === 'string'
          ? parsed.data.details
          : typeof parsed.message === 'string'
            ? parsed.message
            : '';
      if (parsed.data?.category === 'auth' || /auth|login|sign in/i.test(details)) {
        return (
          `WorkBuddy Desktop runtime is not signed in: ${details || 'authentication required'}. ` +
          "Sign in to the WorkBuddy AI desktop app (or run the bundled CLI's /login), then retry."
        );
      }
      if (details) return translateGatewayRefusal(details);
    } catch {
      /* fall through to the generic message */
    }
  }
  return 'WorkBuddy Desktop refused the request.';
}

// ── Provider ────────────────────────────────────────────────────────────────

export class WorkBuddyDesktopProvider implements Provider {
  readonly imageInputTransport = 'file' as const;
  readonly name = 'workbuddy-desktop' as const;
  readonly supportsFreshConversation = true;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // The desktop app owns its auth; the provider is usable whenever the app
    // is installed (its runtime inherits the desktop login context).
    const available = locateWorkBuddyDesktopApp() !== null;
    if (available && Date.now() - cachedModelsAt > MODELS_CACHE_TTL_MS) {
      refreshModelsInBackground();
    }
    return available;
  }

  listModels(): ModelDef[] {
    if (cachedModels && Date.now() - cachedModelsAt < MODELS_CACHE_TTL_MS) return cachedModels;
    refreshModelsInBackground();
    if (cachedModels && cachedModels.length > 0) return cachedModels;
    return [];
  }

  refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh) return refreshModelsInBackground();
    cachedModels = null;
    cachedModelsAt = 0;
    // A refresh already in flight may have started before the cache was
    // cleared; let it settle, then read once more so the forced refresh
    // always reflects the catalog currently on disk.
    const pending = refreshInProgress ? (refreshPromise ?? Promise.resolve()) : null;
    return (pending ?? Promise.resolve()).then(() => refreshModelsInBackground());
  }

  getCliCommands(): CliCommand[] {
    return Object.entries(WORKBUDDY_DESKTOP_BUILTIN_COMMANDS).map(([name, description]) => ({
      name,
      description,
      category: 'builtin' as const,
    }));
  }

  private resolveCliModel(modelId: string): string | undefined {
    const models = this.listModels();
    const model = models.find((m) => m.id === modelId || m.apiModelId === modelId);
    if (model?.apiModelId) return model.apiModelId;
    return models[0]?.apiModelId;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    if (request.capabilityProfile === 'research-only') {
      yield {
        type: 'error',
        error:
          'WorkBuddy Desktop does not support the research-only capability profile. ' +
          'Use the CodeBuddy CLI provider for narrow research subprocesses.',
      };
      return;
    }

    const app: WorkBuddyDesktopApp | null = locateWorkBuddyDesktopApp();
    if (!app) {
      yield {
        type: 'error',
        error:
          'WorkBuddy Desktop app was not found. Install WorkBuddy AI (or set ' +
          'WORKBUDDY_DESKTOP_APP_PATH to its install root), then reconnect.',
      };
      return;
    }
    const runtime = resolveWorkBuddyDesktopRuntime(app);
    if (!runtime) {
      yield {
        type: 'error',
        error:
          'WorkBuddy Desktop app was found but its runtime could not be resolved ' +
          '(missing bundled CLI). Reinstall the app, then reconnect.',
      };
      return;
    }

    const cliModel = this.resolveCliModel(request.model);
    if (!cliModel) {
      yield { type: 'error', error: 'WorkBuddy Desktop did not report an available model.' };
      return;
    }

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const attachmentScope = createCliAttachmentScope();
    const { text: promptText, images } = buildPrompt(request.messages, attachmentScope);
    if (!promptText.trim() && images.length === 0) {
      attachmentScope.cleanup();
      yield { type: 'error', error: 'WorkBuddy Desktop: empty prompt' };
      return;
    }

    // ── Kory MCP bridge wiring ─────────────────────────────────────────────
    // The kory__* tools are injected via --mcp-config, the same mechanism the
    // desktop app uses for its own agent MCP config. --strict-mcp-config then
    // keeps every other MCP source out of Koryphaios turns.
    const buddyBridge = getCliBridge('workbuddy-desktop');
    const hasTools = (request.tools?.length ?? 0) > 0;
    const bridgeGrantLease =
      hasTools && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'workbuddy-desktop' as ProviderName,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: cwd,
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
      bridgeGrantLease,
    };

    let mcpConfigPath: string | undefined;
    // ACP session-scoped MCP servers (the runtime's own schema: stdio entries
    // with env as an array of {name, value}). This is the injection path that
    // works in BOTH attach mode (the desktop's already-authenticated runtime
    // was not spawned with our --mcp-config) and spawn mode.
    const sessionMcpServers: Array<{
      type?: 'stdio';
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }> = [];
    if (hasTools) {
      try {
        const mcpConfigs = buddyBridge?.buildMcpConfig(bridgeCtx);
        if (
          bridgeCtx.sessionId &&
          (!mcpConfigs || mcpConfigs.length === 0) &&
          !resolveKoryBridgeScript()
        ) {
          yield { type: 'error', error: koryBridgeUnavailableError('workbuddy-desktop') };
          return;
        }
        if (mcpConfigs && mcpConfigs.length > 0) {
          const servers: Record<string, unknown> = {};
          for (const srv of mcpConfigs) {
            servers[srv.name] = {
              command: srv.command,
              args: srv.args,
              env: srv.env ?? {},
              type: 'stdio',
            };
            if (srv.transport === 'stdio') {
              sessionMcpServers.push({
                // Matches the `type` the runtime's own mcp config file uses; a
                // runtime that rejects it is retried without it in sessionNew().
                type: 'stdio',
                name: srv.name,
                command: srv.command,
                args: srv.args,
                env: Object.entries(srv.env ?? {}).map(([name, value]) => ({
                  name,
                  value: String(value),
                })),
              });
            }
          }
          const configDir = join(getKoryphaiosWorkBuddyHome(runtime.configDir), 'mcp');
          ensureManagedCliDirectory(configDir);
          mcpConfigPath = join(
            configDir,
            `${request.sessionId ?? 'turn'}-${Date.now()}.mcp-config.json`,
          );
          writeManagedCliFile(mcpConfigPath, JSON.stringify({ mcpServers: servers }, null, 2));
        }
      } catch (mcpErr) {
        providerLog.warn(
          safeProviderDiagnostic('workbuddy-desktop', 'configuration', mcpErr),
          'Failed to write kory MCP config for WorkBuddy Desktop; continuing without kory__ tools',
        );
      }
    }

    // The bundled runtime authenticates from the WorkBuddy Desktop config
    // directory. Stage that state in an isolated home for direct-spawn mode;
    // attach mode gets the same context from the running desktop sidecar.
    const workBuddyHome = getKoryphaiosWorkBuddyHome(runtime.configDir);
    // The international endpoint (www.codebuddy.ai) is banned and its cert no
    // longer matches; "external" would produce a TLS hostname-mismatch failure.
    const requestedInternetEnvironment =
      process.env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT?.trim() || '';
    const internetEnvironment =
      !requestedInternetEnvironment || requestedInternetEnvironment === 'external'
        ? 'internal'
        : requestedInternetEnvironment;
    const env = buildProviderCliEnv('workbuddy-desktop', {
      CODEBUDDY_HOME: workBuddyHome,
      HOME: workBuddyHome,
      USERPROFILE: workBuddyHome,
      WORKBUDDY_CONFIG_DIR: runtime.configDir,
      CODEBUDDY_CONFIG_DIR: runtime.configDir,
      CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT: internetEnvironment,
    });

    // ── Acquire the runtime ────────────────────────────────────────────────
    // Preferred path: host the runtime in the running desktop app's sidecar.
    // Sidecar children receive the desktop app's credential bootstrap, so the
    // runtime authenticates exactly like the app's own runtimes — no token,
    // no login step. The gateway is pinned to none (localhost-only, and the
    // desktop's per-instance gateway password is not shareable). When the app
    // is closed, fall back to a directly spawned runtime using staged desktop
    // config/auth state.
    let handle: DesktopRuntimeHandle;
    let attachedViaSidecar = false;
    try {
      const sidecar = findRunningDesktopSidecar(runtime.configDir);
      if (sidecar) {
        attachedViaSidecar = true;
        const pooled = sidecarRuntimePool.get(cwd);
        if (pooled) {
          pooled.lastUsedAt = Date.now();
          handle = pooled.handle;
        } else {
          const session = await createDesktopRuntimeSession(sidecar, {
            runtime,
            cwd,
            env: { WORKBUDDY_DESKTOP_APP_PATH: app.appPath },
          });
          if (!session.acpEndpoint) {
            throw new Error('Sidecar session returned no ACP endpoint');
          }
          providerLog.info(
            { sessionId: session.sessionId, endpoint: session.acpEndpoint },
            'WorkBuddy Desktop: runtime hosted by the desktop app sidecar',
          );
          handle = {
            pid: session.pid,
            acpEndpoint: session.acpEndpoint,
            kill() {
              void new SidecarControlClient(sidecar.controlSocketPath)
                .request('session.kill', { sessionId: session.sessionId })
                .catch(() => {});
            },
            exited: new Promise<number | null>(() => {}),
          };
          sidecarRuntimePool.set(cwd, { handle, lastUsedAt: Date.now() });
        }
      } else {
        handle = await acquireRuntime(runtime, cwd, mcpConfigPath, env, request.sandbox);
      }
    } catch (err: unknown) {
      removeMcpConfigFile(mcpConfigPath);
      attachmentScope.cleanup();
      bridgeGrantLease?.cleanup();
      const diagnostic = safeProviderDiagnostic('workbuddy-desktop', 'spawn', err);
      providerLog.error(diagnostic, 'WorkBuddy Desktop runtime failed to start');
      yield { type: 'error', error: safeProviderFailureMessage('workbuddy-desktop', diagnostic) };
      return;
    }

    let emittedComplete = false;
    let sessionId: string | null = null;
    let timedOut = false;

    const acp = new WorkBuddyDesktopAcpClient(handle.acpEndpoint);
    // Out-of-band events that arrive outside the prompt's POST stream (the
    // runtime emits available_commands_update when the session is created).
    // They are buffered and yielded around the prompt; turn deltas always
    // come from the prompt stream itself.
    const outOfBand: ProviderEvent[] = [];

    const mapUpdate = (params: AcpSessionUpdate): ProviderEvent[] => {
      const update = params.update as Record<string, unknown>;
      const kind = params.update.sessionUpdate;
      const events: ProviderEvent[] = [];
      switch (kind) {
        case 'agent_message_chunk': {
          const text = updateText(update);
          if (text) events.push({ type: 'content_delta', content: text });
          break;
        }
        case 'agent_thought_chunk': {
          const text = updateText(update);
          if (text) events.push({ type: 'thinking_delta', thinking: text });
          break;
        }
        case 'tool_call': {
          const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
          const toolName =
            typeof update.toolName === 'string'
              ? update.toolName
              : typeof update.title === 'string'
                ? update.title
                : 'tool';
          const input = update.input ?? {};
          events.push({
            type: 'tool_use_start',
            toolCallId,
            toolName,
            toolInput: JSON.stringify(input),
          });
          const diff = toolCallDiff(update);
          if (diff?.path && update.kind === 'edit') {
            events.push({
              type: 'file_edit',
              filePath: diff.path,
              fileOldContent: diff.oldText,
              fileContent: diff.newText ?? '',
              fileOperation: diff.oldText ? 'edit' : 'create',
            });
          }
          break;
        }
        case 'tool_call_update': {
          const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
          const status = typeof update.status === 'string' ? update.status : '';
          if (status !== 'completed' && status !== 'failed') break;
          events.push({
            type: 'tool_executed',
            toolCallId,
            toolName: 'tool',
            toolInput: '{}',
            toolOutput: toolCallOutput(update),
            isError: status === 'failed',
          });
          break;
        }
        case 'available_commands_update': {
          const commands = Array.isArray(update.availableCommands)
            ? (update.availableCommands as Array<{ name?: unknown; description?: unknown }>)
            : [];
          const mapped: CliCommand[] = commands
            .filter((c) => typeof c.name === 'string')
            .map((c) => ({
              name: c.name as string,
              description: typeof c.description === 'string' ? c.description : undefined,
              category: 'builtin' as const,
            }));
          if (mapped.length > 0) events.push({ type: 'cli_commands', cliCommands: mapped });
          break;
        }
        case 'interruption_request': {
          // Koryphaios owns permissions; the harness note steers the runtime
          // to kory__ tools, so a native-tool interruption is auto-resolved
          // (allow) to keep the turn moving — the same acceptEdits posture
          // the CodeBuddy CLI provider applies headlessly. The critic role
          // stays read-only.
          const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
          if (sessionId && toolCallId) {
            void acp
              .resolveInterruption(
                sessionId,
                toolCallId,
                request.harnessRole === 'critic' ? 'deny' : 'allow',
              )
              .catch(() => {});
          }
          break;
        }
        case 'session_end': {
          const stopReason = typeof update.stopReason === 'string' ? update.stopReason : 'end_turn';
          if (stopReason === 'refusal') {
            const rawErr =
              typeof update.errorMessage === 'string'
                ? update.errorMessage
                : 'WorkBuddy Desktop refused the request.';
            // Capture the model id with gateway refusals so backend/quota
            // failures are diagnosable without re-running the turn.
            if (/backend|maas|quota|credit|not supported|429/i.test(rawErr)) {
              providerLog.warn(
                { model: request.model, cliModel, details: rawErr.slice(0, 300) },
                'WorkBuddy Desktop turn refused by gateway',
              );
            }
            const translated = translateGatewayRefusal(rawErr);
            events.push({ type: 'error', error: translated });
          } else {
            events.push({
              type: 'complete',
              finishReason: stopReason === 'cancelled' ? 'stop' : 'end_turn',
            });
          }
          break;
        }
        default:
          break;
      }
      return events;
    };

    const unsubscribe = acp.onNotification((params) => {
      if (params.update.sessionUpdate !== 'available_commands_update') return;
      for (const event of mapUpdate(params)) outOfBand.push(event);
    });

    const cleanup = () => {
      unsubscribe();
      void acp.disconnect().catch(() => {});
      removeMcpConfigFile(mcpConfigPath);
      attachmentScope.cleanup();
      bridgeGrantLease?.cleanup();
    };

    const onAbort = () => {
      if (sessionId) void acp.sessionCancel(sessionId).catch(() => {});
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const turnTimer = setTimeout(() => {
      timedOut = true;
      if (sessionId) void acp.sessionCancel(sessionId).catch(() => {});
    }, TURN_TIMEOUT_MS);
    turnTimer.unref?.();

    try {
      await acp.connect();
      await acp.initialize('koryphaios', '1.0.0');

      const session = await acp.sessionNew({
        cwd,
        mcpServers: sessionMcpServers,
      });
      sessionId = session.sessionId;

      // Model pin (per turn, like the desktop app's model switcher).
      try {
        await acp.setModel(sessionId, cliModel);
      } catch (modelErr: unknown) {
        providerLog.debug(
          safeProviderDiagnostic('workbuddy-desktop', 'configuration', modelErr),
          'workbuddy-desktop: set_model failed; runtime default stays in effect',
        );
      }

      // Permission mode: critic stays read-only (plan), manager/worker bypass —
      // Kory is the permission authority and the ACP interruption path already
      // auto-allows, so a prompt-capable mode only adds a stall risk headless.
      // The runtime reports the dial either as `modes` or as a `mode`
      // config option (real 5.8.4 runtime: configOptions id "mode" with
      // default/acceptEdits/plan/auto/dontAsk/bypassPermissions/fullAccess).
      const wantedMode = request.harnessRole === 'critic' ? 'plan' : 'bypassPermissions';
      const modes = session.modes?.availableModes ?? [];
      if (modes.length > 0) {
        const resolved =
          modes.find((m) => m.id === wantedMode)?.id ??
          (request.harnessRole === 'critic'
            ? (modes.find((m) => /read|plan/i.test(m.id))?.id ?? 'default')
            : (modes.find((m) => /bypass|accept|fullAccess|dontAsk/i.test(m.id))?.id ??
              modes[0]?.id ??
              'default'));
        try {
          await acp.setMode(sessionId, resolved);
        } catch (modeErr: unknown) {
          providerLog.debug(
            safeProviderDiagnostic('workbuddy-desktop', 'configuration', modeErr),
            'workbuddy-desktop: set_mode failed',
          );
        }
      } else {
        const modeOption = (session.configOptions ?? []).find(
          (opt: AcpConfigOption) => opt.id === 'mode' || opt.category === 'mode',
        );
        const modeValues = (modeOption?.options ?? [])
          .map((option) => option.value)
          .filter((value): value is string => typeof value === 'string');
        if (modeOption && modeValues.includes(wantedMode)) {
          try {
            await acp.request('session/set_config_option', {
              sessionId,
              configId: modeOption.id,
              value: wantedMode,
            });
          } catch (modeErr: unknown) {
            providerLog.debug(
              safeProviderDiagnostic('workbuddy-desktop', 'configuration', modeErr),
              'workbuddy-desktop: set_config_option(mode) failed',
            );
          }
        }
      }

      // Reasoning dial: the runtime exposes Deep Thinking as the
      // `thought_level` session config option whose values are the effort
      // ladder plus `disabled` (Off) and `enabled` (model default). Map
      // Koryphaios's reasoning level onto those exact values.
      const thinkingOption = (session.configOptions ?? []).find(
        (opt: AcpConfigOption) =>
          opt.id === 'thought_level' || opt.id === 'thinking' || /think/i.test(opt.id),
      );
      if (thinkingOption) {
        const level = (request.reasoningLevel ?? '').toLowerCase().trim();
        const thoughtValue =
          level === '' || level === 'none' || level === 'off' || level === '0'
            ? 'disabled'
            : level === 'on' || level === 'default'
              ? 'enabled'
              : level;
        try {
          await acp.request('session/set_config_option', {
            sessionId,
            configId: thinkingOption.id,
            value: thoughtValue,
          });
        } catch {
          /* config option is best-effort */
        }
      }

      // Context dial: the runtime exposes its real context tiers as the
      // `context_window` session config option (values are token counts as
      // strings). The vendor defaults to `defaultLength` (e.g. 300K on a
      // 1M model), so pin the maximum by default and let the provider-level
      // setting choose a smaller tier. Only send a value the runtime itself
      // advertised — an unsupported number would be rejected.
      const selectedModel = this.listModels().find(
        (m) => m.id === request.model || m.apiModelId === request.model,
      );
      const contextBudget = resolveProductContextBudget(
        this.config.contextWindow,
        selectedModel?.contextWindowOptions ?? [],
      );
      if (contextBudget !== undefined) {
        const contextOption = (session.configOptions ?? []).find(
          (opt: AcpConfigOption) =>
            opt.id === 'context_window' || opt.category === 'context_window',
        );
        const contextValues = (contextOption?.options ?? [])
          .map((option) => option.value)
          .filter((value): value is string => typeof value === 'string');
        if (contextOption && contextValues.includes(String(contextBudget))) {
          try {
            await acp.request('session/set_config_option', {
              sessionId,
              configId: contextOption.id,
              value: String(contextBudget),
            });
          } catch (contextErr: unknown) {
            providerLog.debug(
              safeProviderDiagnostic('workbuddy-desktop', 'configuration', contextErr),
              'workbuddy-desktop: set_config_option(context_window) failed',
            );
          }
        }
      }

      const prompt: Array<{ type: string; [key: string]: unknown }> = [];
      if (promptText.trim()) prompt.push({ type: 'text', text: promptText });
      for (const image of images) {
        prompt.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      }

      // Out-of-band commands discovered during session setup (the runtime
      // reports its slash-command surface this way).
      for (const event of outOfBand.splice(0, outOfBand.length)) yield event;

      // The POST response stream carries the turn's notifications, so deltas
      // are yielded as they arrive instead of buffered until the end.
      let result: AcpPromptResult = {};
      for await (const item of acp.promptStream(sessionId, prompt)) {
        if (item.update) {
          for (const event of mapUpdate(item.update)) {
            if (event.type === 'complete') emittedComplete = true;
            yield event;
          }
        }
        if (item.result) result = item.result;
      }
      for (const event of outOfBand.splice(0, outOfBand.length)) yield event;

      clearTimeout(turnTimer);
      request.signal?.removeEventListener('abort', onAbort);
      cleanup();

      if (request.signal?.aborted) return;
      if (timedOut) {
        yield { type: 'error', error: 'WorkBuddy Desktop turn timed out.' };
        return;
      }
      if (result.errorMessage) {
        yield { type: 'error', error: result.errorMessage };
        return;
      }
      if (result.stopReason === 'refusal') {
        const message = refusalMessage(result);
        // A directly spawned bundled runtime has no desktop credential
        // bootstrap, so it authenticates as nobody no matter how the rest of
        // the turn is wired. Say that precisely instead of relaying the
        // runtime's bare "Authentication required".
        yield {
          type: 'error',
          error:
            !attachedViaSidecar && /auth|login|credential|sign in/i.test(message)
              ? `${message} — Koryphaios must attach to WorkBuddy AI's own host runtime, which only exists while the app is running a chat. Open a WorkBuddy conversation (or keep one open), leave the app running, then retry.`
              : message,
        };
        return;
      }
      if (!emittedComplete) yield { type: 'complete', finishReason: 'end_turn' };
    } catch (err: unknown) {
      clearTimeout(turnTimer);
      request.signal?.removeEventListener('abort', onAbort);
      cleanup();
      if (request.signal?.aborted) return;
      if (timedOut) {
        yield { type: 'error', error: 'WorkBuddy Desktop turn timed out.' };
        return;
      }
      const diagnostic = safeProviderDiagnostic('workbuddy-desktop', 'stream', err);
      providerLog.error(diagnostic, 'WorkBuddy Desktop turn failed');
      yield { type: 'error', error: safeProviderFailureMessage('workbuddy-desktop', diagnostic) };
    }
  }
}

// ── Isolated home for the desktop runtime ───────────────────────────────────

/**
 * Stage the WorkBuddy Desktop config/auth files in an isolated home so
 * Koryphaios sessions never commingle with the user's desktop state. The
 * files are symlinked through so a directly spawned bundled runtime reuses the
 * desktop app's login instead of starting unauthenticated.
 */
export function getKoryphaiosWorkBuddyHome(
  source = process.env.WORKBUDDY_CONFIG_DIR?.trim() || join(homedir(), '.workbuddy-ai'),
  homeRoot = homedir(),
): string {
  const dir = join(homeRoot, '.koryphaios', 'workbuddy-desktop-home');
  try {
    ensureManagedCliDirectory(dir, { root: join(homeRoot, '.koryphaios') });
    for (const file of ['settings.json', '.credentials.json', 'auth.json']) {
      const src = join(source, file);
      if (!existsSync(src)) continue;
      const dst = join(dir, file);
      try {
        if (existsSync(dst) || lstatSync(dst).isSymbolicLink?.()) rmSync(dst, { force: true });
      } catch {
        /* no existing link to remove */
      }
      try {
        symlinkSync(src, dst);
      } catch {
        /* best effort */
      }
    }
  } catch {
    providerLog.warn({}, 'workbuddy-desktop: isolated home creation failed');
  }
  return dir;
}

/** Test/runtime helper: drop every pooled runtime process. */
export function shutdownWorkBuddyDesktopRuntimesForTesting(): void {
  for (const entry of runtimePool.values()) entry.handle.kill();
  runtimePool.clear();
  for (const entry of sidecarRuntimePool.values()) entry.handle.kill();
  sidecarRuntimePool.clear();
  safeRm(desktopRuntimeTmpDir());
}
