// OpenCode CLI provider — runs the official `opencode` binary as an ACP agent.
//
// Mirrors the Claude Code / Grok Build pattern (claude-code.ts, grok-build.ts):
// the OpenCode CLI owns its own auth and model routing (integrations connect via
// `opencode auth login`; providers and per-model reasoning ladders come from the
// CLI's authenticated catalog), so this provider never holds a credential — it
// shells out to the locally installed, logged-in `opencode` CLI and translates its
// ACP (Agent Client Protocol, protocolVersion 1) stream into Koryphaios
// ProviderEvents. Koryphaios remains the single owner of its own tool loop.
//
// Machine surface (verified live against opencode 2.0.32):
//   opencode acp                    JSON-RPC 2.0 over stdio (see opencode-acp.ts)
//   opencode api model.list         Authenticated live catalog: real ids,
//                                   limit.context / limit.output, reasoning
//                                   effort variants, capabilities, per-1M-token
//                                   cost — this is the model picker source.
//   opencode api --standalone ...   Same catalog without the background service.
//   opencode models                 Bare "provider/model" id list (last resort).
//
// Real-data contract:
//   - contextWindow comes from the CLI catalog's limit.context (contextVerified),
//     never from a bundled table.
//   - reasoningLevels come from catalog variants carrying settings.reasoningEffort.
//   - turn usage comes from the ACP `usage_update` notification (used/size) and the
//     final session/prompt receipt (inputTokens/outputTokens/totalTokens).
//
// Tool boundary:
//   - Host actions go through the Kory MCP bridge: when a session-scoped grant
//     exists, the `kory` stdio MCP server is passed to the ACP session via
//     session/new's mcpServers. Every kory__* call is proxied through Kory's
//     ToolRegistry → permission check → sandbox policy — identical to every
//     other managed CLI harness. The bridge is passed per session, so no file
//     is ever written into the user's workspace or ~/.config/opencode.
//   - OpenCode's NATIVE tools (write/shell/…) remain governed by the user's own
//     OpenCode permission configuration, exactly like running opencode
//     themselves. Anything the configuration asks about is vetoed at the ACP
//     layer (session/request_permission): read-like kinds are allowed, native
//     edit/delete/move/execute are rejected — those must flow through kory__*
//     where Kory's permission UX applies.
//   - research-only turns get a read-only ACP session (mode "plan") and no Kory
//     MCP bridge; nativeToolsDisabled turns run in a private temp workspace.
//
// Environment: local turns run with the user's real HOME (the CLI must resolve
// the same ~/.config/opencode and ~/.local/share/opencode the user's own
// opencode uses). Sandboxed turns run under the OS jail with opencode's config,
// data, state, and cache directories bind-mounted read-write and nothing else
// of the user's machine exposed.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  buildSoftJail,
  inferenceSandboxPolicy,
  wrapCommand,
} from '../collaboration/sandbox-runner';
import {
  type LifecycleCapabilities,
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderLifecycle,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { detectOpenCodeCLILogin } from './auth-utils';
import { whichBinary } from './cli-detection';
import { providerLog } from '../logger';
import { isModelListCacheFresh } from './model-list-cache';
import { getCliBridge, KORY_HARNESS_NOTE } from './cli-bridges';
import {
  koryBridgeUnavailableError,
  resolveKoryBridgeScript,
} from './kory-cli-mcp-config';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { recordProviderModelPricing } from '../pricing';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import { buildProviderCliEnv } from './cli-environment';
import { recordedToolName, recordedToolOutput } from './recorded-tool';
import {
  OpenCodeAcpClient,
  type AcpPromptBlock,
  type AcpSessionEvent,
  type AcpStdioMcpServer,
} from './opencode-acp';

const OPENCODE_STREAM_TIMEOUT_MS = 300_000;
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_STANDALONE_TIMEOUT_MS = 45_000;

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let modelRefreshPromise: Promise<void> | null = null;
let lastDiscoveryError: string | undefined;

export function opencodeCapabilityBoundary(profile: StreamRequest['capabilityProfile']) {
  const researchOnly = profile === 'research-only';
  return {
    researchOnly,
    wireKoryMcp: !researchOnly,
    exposeWorkspace: !researchOnly,
    readOnly: researchOnly,
  } as const;
}

export class OpenCodeCliProvider implements Provider {
  readonly imageInputTransport = 'native' as const;
  readonly name = 'opencode' as const;
  /** ACP sessions are created fresh per request; stale transcripts never resume. */
  readonly supportsFreshConversation = true;
  /**
   * Lifecycle evidence (verified against this file and opencode-acp.ts):
   * - interrupt: true. `onAbort` (~line 542) and the timeout (~line 551) call `client.cancel`,
   *   which sends the ACP `session/cancel` notification (opencode-acp.ts `cancel()`). The
   *   prompt response then carries the stop reason, which is captured in `acpStopReason`.
   *   Caveat: on abort the generator returns without a yield (~line 580), so the interrupted
   *   outcome is not emitted as a stream event. The caller's own abort is the signal.
   * - resume / resumeAfterRestart: false. `client.newSession` runs on every turn (~line 350).
   *   The ACP `loadSession` capability is advertised by opencode, but `session/load` is never
   *   sent (grep finds no use), so nothing resumes a prior session.
   * - steerInFlight: false. The only in-turn input is the `session/prompt` call; there is no
   *   steer path.
   * - rollback: true. Each turn builds its prompt from request.messages (`buildPrompt`,
   *   ~line 240), and the ACP session is fresh, so no provider-side history outlives a turn.
   *   This is the same guarantee as the `supportsFreshConversation = true` declaration above.
   * - fork: false. ACP `session/fork` is not used.
   * - terminalStatusQuality: strong. The `session/prompt` JSON-RPC response is the terminal
   *   signal, and a failed request becomes `promptError`.
   * - resumeHandle: null. The ACP session id is held only in a local variable and is never
   *   stored, because nothing reads it while resume is false.
   */
  readonly lifecycle: ProviderLifecycle = {
    capabilities: (): LifecycleCapabilities => ({
      version: 1,
      interrupt: true,
      resume: false,
      resumeAfterRestart: false,
      steerInFlight: false,
      rollback: true,
      fork: false,
      terminalStatusQuality: 'strong',
    }),
    resumeHandle: () => null,
  };

  // spawnChild is the process seam for the ACP child; replay tests inject a transcript.
  constructor(
    readonly config: ProviderConfig,
    private readonly spawnChild: typeof spawn = spawn,
  ) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Either the user explicitly connected (opt-in marker stored as authToken) or
    // the OpenCode CLI has its own login material on this machine. The CLI owns
    // the real credential; the marker only says "use the CLI harness".
    const available = !!this.config.authToken || detectOpenCodeCLILogin();
    if (available && !isModelListCacheFresh(cachedModelsAt)) {
      refreshModelsInBackground();
    }
    return available;
  }

  listModels(): ModelDef[] {
    if (cachedModels && cachedModels.length > 0 && isModelListCacheFresh(cachedModelsAt)) {
      return cachedModels;
    }
    refreshModelsInBackground();
    return cachedModels ?? [];
  }

  getModelDiscoveryError(): string | undefined {
    return lastDiscoveryError;
  }

  isModelCatalogAuthoritative(): boolean {
    return cachedModels !== null;
  }

  refreshModels(forceRefresh = false): Promise<void> {
    if (forceRefresh) {
      cachedModels = null;
      cachedModelsAt = 0;
      lastDiscoveryError = undefined;
    }
    return refreshModelsInBackground();
  }

  private resolveCatalogModelId(model: string | undefined): string | undefined {
    const requested = model?.trim();
    if (!requested) return undefined;
    const models = this.listModels();
    const exact = models.find((m) => m.id === requested || m.apiModelId === requested);
    if (exact) return exact.apiModelId ?? exact.id;
    // Bare local id: resolve "<provider>/<id>" for any catalog provider that
    // owns it. Prefer an exact provider-prefixed catalog match if one exists.
    const bare = requested.includes('/')
      ? undefined
      : models.find((m) => m.id.endsWith(`/${requested}`) || m.apiModelId?.endsWith(`/${requested}`));
    return bare?.apiModelId ?? bare?.id ?? requested;
  }

  /** Native CLI commands advertised by the installed CLI (verified against
   *  `opencode` 2.0.32's ACP `available_commands_update` payload). */
  getCliCommands() {
    return [
      { name: 'init', description: 'guided AGENTS.md setup', category: 'builtin' as const },
      {
        name: 'review',
        description: 'review changes [commit|branch|pr], defaults to uncommitted',
        category: 'builtin' as const,
      },
      { name: 'compact', description: 'Compact the session', category: 'builtin' as const },
    ];
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const bin = whichBinary('opencode');
    if (!bin) {
      yield {
        type: 'error',
        error:
          'OpenCode CLI not found on PATH. Install it from https://opencode.ai, run "opencode auth login", then reconnect.',
      };
      return;
    }

    const capabilityBoundary = opencodeCapabilityBoundary(request.capabilityProfile);
    const researchOnly = capabilityBoundary.researchOnly;
    const nativeToolsDisabled = request.nativeToolsDisabled === true;
    // Qualification-only text mode: no Kory bridge, private workspace, plan mode.
    const wireKoryMcp = capabilityBoundary.wireKoryMcp && !nativeToolsDisabled;

    // The note advertises the kory bridge; only include it when the bridge will
    // actually be wired this turn (needs a session, so buildKoryCliMcpConfig
    // returns a server), otherwise plain turns tell the model it has no tools.
    const includeHarnessNote = wireKoryMcp && !!request.sessionId;
    const prompt = buildPrompt(request.systemPrompt, request.messages, includeHarnessNote);
    const imageBlocks = collectImageBlocks(request.messages);
    if (!prompt.trim() && imageBlocks.length === 0) {
      yield { type: 'error', error: 'OpenCode: empty prompt' };
      return;
    }

    const workingDirectory = request.workingDirectory?.trim() || process.cwd();
    const sessionCwd = nativeToolsDisabled
      ? mkdtempSync(join(tmpdir(), 'kory-opencode-private-'))
      : workingDirectory;

    // ── Wire the Kory MCP bridge (session-scoped, passed per ACP session) ────
    const bridge = getCliBridge('opencode');
    const bridgeGrantLease =
      wireKoryMcp && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'opencode' as const,
      role: request.harnessRole ?? ('manager' as const),
      sandbox: request.sandbox,
      workingDirectory: sessionCwd,
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
      bridgeGrantLease,
    };
    const mcpServers: AcpStdioMcpServer[] = wireKoryMcp
      ? (bridge?.buildMcpConfig(bridgeCtx) ?? [])
      : [];
    // Fail closed: a session-scoped turn expecting the bridge that cannot
    // resolve its script must not spawn the CLI silently tool-less.
    if (
      wireKoryMcp &&
      request.sessionId &&
      mcpServers.length === 0 &&
      !resolveKoryBridgeScript()
    ) {
      bridgeGrantLease?.cleanup();
      yield { type: 'error', error: koryBridgeUnavailableError('opencode') };
      return;
    }

    // ── Environment and sandbox ─────────────────────────────────────────────
    const realHome = homedir();
    const baseEnv = buildProviderCliEnv('opencode', {
      HOME: realHome,
      USERPROFILE: realHome,
    });

    let jail: ReturnType<typeof buildSoftJail> | null = null;
    let spawnEnv = baseEnv;
    let spawnCommand = bin;
    let spawnArgs = ['acp'];
    if (request.sandbox) {
      // Bind opencode's own config/state/cache into a private HOME view so the
      // jailed child resolves the same login and catalog without exposing the
      // rest of the machine.
      const opencodeDirs = [
        join(realHome, '.config', 'opencode'),
        join(realHome, '.local', 'share', 'opencode'),
        join(realHome, '.local', 'state', 'opencode'),
        join(realHome, '.cache', 'opencode'),
      ].filter((dir) => existsSync(dir));
      jail = buildSoftJail(
        baseEnv,
        [],
        {
          '.config/opencode': join(realHome, '.config', 'opencode'),
          '.local/share/opencode': join(realHome, '.local', 'share', 'opencode'),
          '.local/state/opencode': join(realHome, '.local', 'state', 'opencode'),
          '.cache/opencode': join(realHome, '.cache', 'opencode'),
        },
      );
      spawnEnv = jail.env;
      const mounts = [jail.env.HOME as string, ...opencodeDirs];
      const policy = inferenceSandboxPolicy(request.sandbox);
      const wrapped = wrapCommand(bin, ['acp'], {
        cwd: sessionCwd,
        homeDir: jail.env.HOME,
        configDirs: mounts,
        policy,
      });
      spawnCommand = wrapped.command;
      spawnArgs = wrapped.args;
    }

    const client = new OpenCodeAcpClient({
      command: spawnCommand,
      args: spawnArgs,
      cwd: sessionCwd,
      env: spawnEnv,
      spawnChild: this.spawnChild,
    });

    // ── ACP handshake ───────────────────────────────────────────────────────
    try {
      await client.connect();
    } catch (err) {
      bridgeGrantLease?.cleanup();
      jail?.cleanup();
      if (nativeToolsDisabled) rmSync(sessionCwd, { recursive: true, force: true });
      const diagnostic = safeProviderDiagnostic(
        'opencode',
        'spawn',
        err instanceof Error ? err.message : String(err),
      );
      providerLog.warn(diagnostic, 'OpenCode ACP server did not start');
      yield {
        type: 'error',
        error: safeProviderFailureMessage('opencode', diagnostic, {
          authenticationAction:
            'Make sure `opencode acp` runs on this machine, then reconnect.',
        }),
      };
      return;
    }

    // ── Session negotiation ─────────────────────────────────────────────────
    let sessionId: string;
    try {
      const session = await client.newSession({
        cwd: sessionCwd,
        mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      });
      sessionId = session.sessionId;

      // Model selection: the Kory model id is exactly the catalog id
      // ("provider/model"), which the ACP session config accepts verbatim. Bare
      // ids passed by other paths are resolved back through the catalog.
      const requestedModel = this.resolveCatalogModelId(request.model);
      if (requestedModel) {
        await client.setConfigOption(sessionId, 'model', requestedModel);
      }

      // Effort selection — only when the catalog says the model supports it.
      if (request.reasoningLevel) {
        const model = this.listModels().find((m) => m.id === requestedModel);
        const level = request.reasoningLevel.toLowerCase().trim();
        const supported = (model?.reasoningLevels ?? []).map((l) => l.toLowerCase());
        if (supported.includes(level)) {
          await client.setConfigOption(sessionId, 'effort', level);
        }
      }

      // Interaction mode: research-only / native-tools-denied turns run in the
      // CLI's read-only plan agent.
      if (researchOnly || nativeToolsDisabled) {
        await client.setConfigOption(sessionId, 'mode', 'plan');
      }
    } catch (err) {
      bridgeGrantLease?.cleanup();
      jail?.cleanup();
      if (nativeToolsDisabled) rmSync(sessionCwd, { recursive: true, force: true });
      await client.disconnect();
      const diagnostic = safeProviderDiagnostic(
        'opencode',
        'configuration',
        err instanceof Error ? err.message : String(err),
      );
      providerLog.warn(diagnostic, 'OpenCode ACP session negotiation failed');
      yield {
        type: 'error',
        error: safeProviderFailureMessage('opencode', diagnostic),
      };
      return;
    }

    // ── Turn ────────────────────────────────────────────────────────────────
    const queue: ProviderEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    const wake = () => {
      resolveWaiter?.();
      resolveWaiter = null;
    };

    // Per-turn state for tool_call → file_edit/tool_executed mapping.
    const pendingToolCalls = new Map<
      string,
      {
        name: string;
        kind?: string;
        rawInput?: Record<string, unknown>;
        locations?: Array<{ path?: string }>;
      }
    >();
    let reportedCostUsd: number | undefined;
    let sawContent = false;
    let sawThinking = false;
    let acpStopReason: string | undefined;
    let usageFromTurn:
      | { inputTokens?: number; outputTokens?: number; totalTokens?: number; thoughtTokens?: number }
      | undefined;
    let promptError: string | undefined;
    let promptDone = false;

    const onSessionEvent = (event: AcpSessionEvent) => {
      switch (event.type) {
        case 'agent_message_chunk':
          sawContent = true;
          queue.push({ type: 'content_delta', content: event.text });
          break;
        case 'agent_thought_chunk':
          sawThinking = true;
          queue.push({ type: 'thinking_delta', thinking: event.text });
          break;
        case 'tool_call':
          pendingToolCalls.set(event.toolCallId, {
            name: event.name,
            kind: event.kind,
            rawInput: event.rawInput,
            locations: event.locations,
          });
          break;
        case 'tool_call_update': {
          const pending = pendingToolCalls.get(event.toolCallId);
          const status = event.status ?? 'unknown';
          const name = event.name ?? pending?.name ?? '';
          const kind = event.kind ?? pending?.kind;
          const rawInput = event.rawInput ?? pending?.rawInput;
          const locations = event.locations ?? pending?.locations;
          if (status === 'completed' || status === 'failed') {
            pendingToolCalls.delete(event.toolCallId);
            if (isKoryBridgeMetaExec(event.rawOutput)) {
              // kory__* calls are executed and reported by the Kory bridge
              // itself; surfacing them here again would duplicate every
              // bridge action in the feed.
              wake();
              return;
            }
            const failed = status === 'failed';
            const toolOutput = extractToolOutput(event);
            const inputPath =
              typeof rawInput?.path === 'string'
                ? rawInput.path
                : typeof rawInput?.file_path === 'string'
                  ? rawInput.file_path
                  : locations?.find((loc) => typeof loc.path === 'string')?.path;
            if (
              !failed &&
              kind === 'edit' &&
              typeof inputPath === 'string' &&
              typeof rawInput?.content === 'string'
            ) {
              queue.push({
                type: 'file_edit',
                filePath: inputPath,
                fileContent: rawInput.content,
                fileOperation: /^write$/i.test(name) ? 'create' : 'edit',
              });
            } else {
              queue.push({
                type: 'tool_executed',
                toolCallId: event.toolCallId,
                toolName: recordedToolName({ name }) ?? name,
                toolInput: safeToolInputJson(rawInput),
                toolOutput: recordedToolOutput(toolOutput).slice(0, 8_000),
                isError: failed,
              });
            }
          } else {
            pendingToolCalls.set(event.toolCallId, { name, kind, rawInput, locations });
          }
          break;
        }
        case 'usage_update': {
          if (typeof event.cost?.amount === 'number') {
            reportedCostUsd = event.cost.amount;
          }
          queue.push({
            type: 'usage_update',
            tokensIn: event.used,
            usagePrecision: 'provider-reported',
            // Live occupancy snapshot reported by the CLI, not a turn total.
            estimated: false,
            reportedCostUsd,
          });
          break;
        }
        case 'available_commands_update':
          break;
        case 'unknown':
          providerLog.debug(
            { sessionUpdate: event.sessionUpdate },
            'opencode acp: ignoring unsupported session/update kind',
          );
          break;
      }
      wake();
    };

    const promptBlocks = toPromptBlocks(prompt, imageBlocks);
    const promptPromise = client
      .prompt(sessionId, promptBlocks, onSessionEvent)
      .then((result) => {
        acpStopReason = result.stopReason;
        usageFromTurn = result.usage;
      })
      .catch((err) => {
        promptError = safeProviderFailureMessage(
          'opencode',
          safeProviderDiagnostic(
            'opencode',
            'stream',
            err instanceof Error ? err.message : String(err),
          ),
        );
      })
      .finally(() => {
        promptDone = true;
        wake();
      });

    const onAbort = () => {
      providerLog.debug({ sessionId }, 'opencode acp: abort requested');
      client.cancel(sessionId);
      wake();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'opencode' }, 'OpenCode harness timed out — cancelling ACP turn');
      client.cancel(sessionId);
      const killer = setTimeout(() => void client.disconnect(), 5_000);
      killer.unref?.();
      wake();
    }, OPENCODE_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    while (true) {
      while (queue.length > 0) {
        if (request.signal?.aborted) break;
        yield queue.shift()!;
      }
      if (request.signal?.aborted) break;
      if (promptDone && queue.length === 0) break;
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        setTimeout(resolve, 100);
      });
    }
    while (queue.length > 0) yield queue.shift()!;

    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onAbort);
    await promptPromise;
    await client.disconnect();
    bridgeGrantLease?.cleanup();
    jail?.cleanup();
    if (nativeToolsDisabled) rmSync(sessionCwd, { recursive: true, force: true });

    if (request.signal?.aborted) return;

    // ── Finish ──────────────────────────────────────────────────────────────
    if (reportedCostUsd !== undefined || usageFromTurn) {
      yield {
        type: 'usage_update',
        // Billing evidence only: cumulative across the turn's internal requests,
        // never live occupancy — Kory clamps it and withholds it from auto-compact.
        estimated: true,
        billingTokensIn: usageFromTurn?.inputTokens,
        billingTokensOut: usageFromTurn?.outputTokens,
        usagePrecision: 'provider-reported',
        reportedCostUsd,
      };
    }

    if (promptError) {
      yield { type: 'error', error: promptError, errorTransient: isLikelyTransient(promptError) };
      return;
    }

    if (!sawContent && !sawThinking) {
      const diagnostic = safeProviderDiagnostic(
        'opencode',
        'spawn',
        `Turn ended with stopReason=${acpStopReason ?? 'unknown'} and no content`,
      );
      yield {
        type: 'error',
        error: safeProviderFailureMessage('opencode', diagnostic, {
          authenticationAction: 'Run "opencode" in your terminal to check the CLI, then reconnect.',
        }),
      };
      return;
    }

    yield {
      type: 'complete',
      finishReason:
        acpStopReason === 'tool_use'
          ? 'tool_use'
          : acpStopReason === 'max_tokens'
            ? 'max_tokens'
            : 'end_turn',
    };
  }
}

// ─── Model catalog ───────────────────────────────────────────────────────────

function refreshModelsInBackground(): Promise<void> {
  if (modelRefreshPromise) return modelRefreshPromise;
  const bin = whichBinary('opencode');
  if (!bin) return Promise.resolve();

  modelRefreshPromise = (async () => {
    const result = await fetchCatalog(bin);
    if (result.models.length > 0) {
      cachedModels = result.models;
      cachedModelsAt = Date.now();
      lastDiscoveryError = undefined;
      providerLog.debug(
        { provider: 'opencode', models: result.models.length, source: result.source },
        'OpenCode model catalog refreshed',
      );
      return;
    }
    // Negative cache: keep the previous catalog for one TTL so a failing probe
    // cannot re-spawn the CLI on every status render.
    lastDiscoveryError = result.error ?? 'OpenCode reported an empty model catalog';
    cachedModelsAt = Date.now();
    providerLog.warn(
      { provider: 'opencode', error: lastDiscoveryError },
      'OpenCode model catalog refresh failed',
    );
  })().finally(() => {
    modelRefreshPromise = null;
  });
  return modelRefreshPromise;
}

interface CatalogFetch {
  models: ModelDef[];
  source: 'api' | 'api-standalone' | 'models';
  error?: string;
}

async function fetchCatalog(bin: string): Promise<CatalogFetch> {
  const api = await execOpenCode(bin, ['api', 'model.list'], CATALOG_TIMEOUT_MS);
  if (api.ok) {
    const models = parseModelCatalogJson(api.stdout);
    if (models.length > 0) return { models, source: 'api' };
    return { models: [], source: 'api', error: 'OpenCode model.list returned no usable models' };
  }
  const standalone = await execOpenCode(
    bin,
    ['api', '--standalone', 'model.list'],
    CATALOG_STANDALONE_TIMEOUT_MS,
  );
  if (standalone.ok) {
    const models = parseModelCatalogJson(standalone.stdout);
    if (models.length > 0) return { models, source: 'api-standalone' };
    return {
      models: [],
      source: 'api-standalone',
      error: 'OpenCode --standalone model.list returned no usable models',
    };
  }
  const bare = await execOpenCode(bin, ['models'], CATALOG_TIMEOUT_MS);
  if (bare.ok) {
    return { models: parseOpenCodeModelsOutput(bare.stdout), source: 'models' };
  }
  return {
    models: [],
    source: 'api',
    error: api.error ?? standalone.error ?? bare.error ?? 'OpenCode catalog probe failed',
  };
}

function execOpenCode(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail =
            appendPrivateDiagnostic('', Buffer.from(String(stderr ?? ''))).trim() ||
            error.message;
          resolve({ ok: false, stdout: '', error: detail });
          return;
        }
        resolve({ ok: true, stdout: String(stdout) });
      },
    );
    child.stdin?.end();
  });
}

interface RawCatalogEntry {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
  status?: string;
  enabled?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  capabilities?: {
    tools?: boolean;
    input?: string[];
    output?: string[];
    temperature?: boolean;
  };
  variants?: Array<{ id?: string; settings?: { reasoningEffort?: string } }>;
  cost?: Array<{
    tier?: { type?: string; size?: number };
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  }>;
  time?: { released?: number };
}

/** Parse the `opencode api model.list` payload into Kory model definitions.
 *  Exported for tests. */
export function parseModelCatalogJson(raw: string): ModelDef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: ModelDef[] = [];
  for (const entry of data as RawCatalogEntry[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;
    const providerID = typeof entry.providerID === 'string' ? entry.providerID.trim() : '';
    const modelID =
      typeof entry.modelID === 'string'
        ? entry.modelID.trim()
        : typeof entry.id === 'string'
          ? entry.id.trim()
          : '';
    if (!providerID || !modelID) continue;
    const apiId = `${providerID}/${modelID}`;
    const limitContext = numberValue(entry.limit?.context);
    const limitOutput = numberValue(entry.limit?.output);
    const variants = Array.isArray(entry.variants) ? entry.variants : [];
    const reasoningLevels = [
      ...new Set(
        variants
          .map((variant) => variant?.settings?.reasoningEffort)
          .filter(
            (effort): effort is string => typeof effort === 'string' && effort.trim().length > 0,
          )
          .map((effort) => effort.trim().toLowerCase()),
      ),
    ];
    const inputCaps = Array.isArray(entry.capabilities?.input) ? entry.capabilities.input : [];
    const outputCaps = Array.isArray(entry.capabilities?.output) ? entry.capabilities.output : [];
    const baseCost = Array.isArray(entry.cost)
      ? (entry.cost.find((cost) => !cost?.tier) ?? entry.cost[0])
      : undefined;
    const costPerMInput = numberValue(baseCost?.input);
    const costPerMOutput = numberValue(baseCost?.output);
    if (costPerMInput !== undefined || costPerMOutput !== undefined) {
      recordProviderModelPricing('opencode', apiId, {
        pricing: {
          prompt: (costPerMInput ?? 0) / 1_000_000,
          completion: (costPerMOutput ?? 0) / 1_000_000,
          ...(numberValue(baseCost?.cache?.read) !== undefined
            ? { input_cache_read: (baseCost!.cache!.read as number) / 1_000_000 }
            : {}),
          ...(numberValue(baseCost?.cache?.write) !== undefined
            ? { input_cache_write: (baseCost!.cache!.write as number) / 1_000_000 }
            : {}),
        },
      });
    }
    models.push({
      id: apiId,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : apiId,
      provider: 'opencode',
      apiModelId: apiId,
      contextWindow: limitContext ?? 0,
      maxOutputTokens: limitOutput ?? 0,
      contextVerified: limitContext !== undefined,
      canReason: reasoningLevels.length > 0,
      reasoningLevels: reasoningLevels.length > 0 ? reasoningLevels : undefined,
      supportsAttachments: inputCaps.some((cap) =>
        ['image', 'pdf', 'video', 'audio'].includes(cap),
      ),
      supportsStreaming: true,
      costPerMInputTokens: costPerMInput,
      costPerMOutputTokens: costPerMOutput,
      costPerMInputCached: numberValue(baseCost?.cache?.read),
      vision: inputCaps.includes('image') || undefined,
      functionCall: entry.capabilities?.tools === true || undefined,
      outputModalities:
        outputCaps.length > 0 ? outputCaps.map((cap) => cap.toLowerCase()) : undefined,
      deprecated: entry.status === 'deprecated',
      beta: entry.status === 'beta' || entry.status === 'alpha',
    });
  }
  return models;
}

/** Parse `opencode models` stdout ("provider/model" per line). Fallback path
 *  when the authenticated catalog cannot be reached; context windows stay
 *  unknown rather than invented. Exported for tests. */
export function parseOpenCodeModelsOutput(raw: string): ModelDef[] {
  const models: ModelDef[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const id = line.trim();
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) continue;
    if (!/^[A-Za-z0-9_.~/-]+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      provider: 'opencode',
      apiModelId: id,
      contextWindow: 0,
      maxOutputTokens: 0,
      supportsAttachments: false,
      supportsStreaming: true,
    });
  }
  return models;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ─── Prompt construction ─────────────────────────────────────────────────────

const OPENCODE_HARNESS_NOTE =
  KORY_HARNESS_NOTE +
  ' Note: this OpenCode session exposes MCP tools through its code-execution namespace ' +
  'as tools.kory.<tool>() (e.g. await tools.kory.probe_ping({})), discovered via its MCP ' +
  'tool search/list built-ins — call them from there rather than looking for them in the ' +
  'static catalog.';

function buildPrompt(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
  includeHarnessNote: boolean,
): string {
  const lines: string[] = [];
  // Without a wired Kory bridge there are no kory__ tools to advertise — and the
  // shared harness note would tell the model its (working) native tools are
  // disabled with nothing to replace them. Plain turns stay plain.
  if (includeHarnessNote) {
    lines.push(
      systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${OPENCODE_HARNESS_NOTE}` : OPENCODE_HARNESS_NOTE,
      '',
    );
  } else if (systemPrompt?.trim()) {
    lines.push(systemPrompt.trim(), '');
  }
  const turns = messages.filter((m) => m.role !== 'system');

  for (const m of turns) {
    const text = flattenContent(m.content);
    if (!text.trim()) continue;
    const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}

function flattenContent(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use')
      parts.push(`[tool call: ${block.toolName ?? 'tool'} ${JSON.stringify(block.toolInput ?? {})}]`);
    else if (block.type === 'tool_result')
      parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    else if (block.type === 'image') parts.push('[image attachment included]');
    else if (block.type === 'audio')
      parts.push('[audio attachment omitted — OpenCode harness is text/image-only]');
    else if (block.type === 'video')
      parts.push('[video attachment omitted — OpenCode harness is text/image-only]');
  }
  return parts.join('\n');
}

function collectImageBlocks(messages: ProviderMessage[]): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (
        block.type === 'image' &&
        typeof block.imageData === 'string' &&
        block.imageData.length > 0 &&
        typeof block.imageMimeType === 'string' &&
        block.imageMimeType.startsWith('image/')
      ) {
        blocks.push({ type: 'image', mimeType: block.imageMimeType, data: block.imageData });
      }
    }
  }
  return blocks;
}

function toPromptBlocks(prompt: string, images: AcpPromptBlock[]): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = [];
  if (prompt.trim()) blocks.push({ type: 'text', text: prompt });
  blocks.push(...images);
  return blocks;
}

// ─── Tool-call mapping helpers ───────────────────────────────────────────────

function extractToolOutput(event: {
  content?: Array<{ type: string; content?: { type: string; text?: string } }>;
  rawOutput?: unknown;
}): string {
  const parts: string[] = [];
  for (const entry of event.content ?? []) {
    const text = entry.content?.text;
    if (typeof text === 'string' && text) parts.push(text);
  }
  if (parts.length > 0) return parts.join('\n');
  if (event.rawOutput === undefined) return '';
  try {
    return typeof event.rawOutput === 'string'
      ? event.rawOutput
      : JSON.stringify(event.rawOutput);
  } catch {
    return String(event.rawOutput);
  }
}

/** OpenCode dispatches MCP calls through its code-mode `execute` meta-tool;
 *  kory__* calls are reported by the Kory bridge itself. Detect that shape so we
 *  do not double-count them in the feed. */
export function isKoryBridgeMetaExec(rawOutput: unknown): boolean {
  if (!rawOutput || typeof rawOutput !== 'object') return false;
  const metadata = (rawOutput as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const toolCalls = (metadata as Record<string, unknown>).toolCalls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  return toolCalls.every(
    (call) =>
      typeof call === 'object' &&
      call !== null &&
      typeof (call as Record<string, unknown>).tool === 'string' &&
      /^kory([._]|$)/i.test(String((call as Record<string, unknown>).tool)),
  );
}

function safeToolInputJson(input: Record<string, unknown> | undefined): string {
  if (!input) return '{}';
  try {
    return JSON.stringify(input).slice(0, 32_000);
  } catch {
    return '{}';
  }
}

const TRANSIENT_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|overloaded|rate.?limit|429|502|503|504|temporar|timeout|try again/i;

function isLikelyTransient(message: string): boolean {
  return TRANSIENT_RE.test(message);
}
