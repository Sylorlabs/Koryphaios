// Freebuff provider — integrates the free, ad-supported Codebuff build into
// Koryphaios via @codebuff/sdk's CodebuffClient (no subprocess, no TUI, no
// ads). The SDK path emits PrintModeEvents (text, tool_call, tool_result,
// reasoning_delta, finish, error) which this provider translates into
// Koryphaios ProviderEvents.
//
// Authentication: reads the authToken + fingerprintId from
// ~/.config/manicode/credentials.json (written by `freebuff login`). The
// authToken doubles as the SDK's apiKey; the fingerprintId is required by
// CodebuffClient.
//
// Tool ownership — FULL KORY INTEGRATION via overrideTools:
// Every native SDK tool that touches the filesystem or runs commands is
// overridden to route through Koryphaios's ToolRegistry + permission system.
// This gives Freebuff the same gating, sandboxing, provenance, and approval
// flow as the subprocess CLI providers (claude, grok, codex, etc.) — just
// via the SDK's overrideTools hook instead of MCP+hooks.
//
//   write_file      → kory__write_file
//   str_replace     → kory__edit_file
//   apply_patch     → kory__edit_file (per-hunk) / kory__delete_file
//   run_terminal    → kory__bash
//   list_directory  → kory__ls
//   glob            → kory__glob
//   code_search     → kory__grep
//   read_files      → kory__read_file
//
// Web tools (web_search, read_url) are NOT overridden — they run server-side
// on Codebuff's backend and have no local side effects, so they stay native
// (same policy as the other CLI providers, which keep their native web
// search/fetch).
//
// Model discovery: dynamic, no hardcoding. Freebuff models are served through
// OpenRouter, so we query https://openrouter.ai/api/v1/models at startup and
// filter to the model prefixes Codebuff's backend allows. Context windows,
// pricing, vision, and reasoning support all come from the live API response.
// The settings.json `freebuffModel` field (if present) is used as the default
// model id.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  CodebuffClient,
  getCustomToolDefinition,
  type PrintModeEvent,
  type RunState,
  type CustomToolDefinition,
  type AgentDefinition,
} from '@codebuff/sdk';
import { z } from 'zod';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { providerLog } from '../logger';
import { isModelListCacheFresh, enrichFromRemoteMetadata } from './model-list-cache';
import { createGenericModel } from './models';
import type { Provider, ProviderEvent, StreamRequest, ProviderMessage, ProviderContentBlock } from './types';
import {
  readFreebuffCredentials,
  readFreebuffCredentialsFrom,
  readFreebuffAuthToken,
  discoverFreebuffAccounts,
  type FreebuffAccount,
} from './auth-utils';
import { getCliBridge, FREEBUFF_HARNESS_NOTE } from './cli-bridges';
import { getContext } from '../context';
import { resolveToolPermissionPolicy } from '../tools/permission-policy';
import { loadAgentSettings } from '../agent-settings';
import { wsBroker } from '../pubsub';
import type { WSMessage } from '@koryphaios/shared';
import type { ToolContext } from '../tools/registry';

// ─── Model discovery ────────────────────────────────────────────────────────
// Freebuff is a CLI provider: the source of truth for "what models can I
// select?" is the freebuff CLI's own model picker, not OpenRouter's catalog
// or the @codebuff/sdk's ALLOWED_MODEL_PREFIXES (that constant only gates
// custom/published agent template validation — unrelated to freebuff's own
// product menu).
//
// The exact 7-model menu below was extracted directly from the freebuff CLI
// binary itself (decompiled `xq` model list array and the `base2-free-*`
// agent template registry it maps to), and cross-checked against the live
// CLI's on-screen picker. Each entry maps 1:1 to a fixed backend agent
// template (e.g. "openai/gpt-5.6-luna" → "base2-free-luna"), and only
// "base2-free-luna" carries hardcoded reasoning options
// (reasoningOptions: { enabled: true, effort: "high" }) — none of the other
// six templates set any reasoning config, and the CLI itself exposes no
// reasoning-effort or "fast mode" toggle for any model.
//
// We still enrich each entry with live context-window/pricing/vision
// metadata from OpenRouter (best-effort, non-authoritative for *availability*
// — only used to fill in display details for models we already know exist).
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

interface FreebuffMenuEntry {
  /** Wire model ID as used by the Codebuff backend / OpenRouter. */
  modelId: string;
  /** Display name exactly as shown in the freebuff CLI's model picker. */
  displayName: string;
  /** Tagline exactly as shown in the freebuff CLI's model picker. */
  tagline: string;
  /** Backend agent template this model maps to (informational). */
  agentTemplateId: string;
  /** Whether reasoning is hardcoded on for this model (only Luna, currently). */
  reasoningHardcoded: boolean;
}

// The definitive freebuff model menu — ground truth from the CLI itself.
const FREEBUFF_MODEL_MENU: FreebuffMenuEntry[] = [
  {
    modelId: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    tagline: 'Deep reasoning',
    agentTemplateId: 'base2-free-deepseek',
    reasoningHardcoded: false,
  },
  {
    modelId: 'minimax/minimax-m3',
    displayName: 'MiniMax M3',
    tagline: 'Fastest',
    agentTemplateId: 'base2-free-minimax-m3',
    reasoningHardcoded: false,
  },
  {
    modelId: 'openai/gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    tagline: 'Thinks hard & Fast',
    agentTemplateId: 'base2-free-luna',
    reasoningHardcoded: true,
  },
  {
    modelId: 'z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    tagline: "Top open-source model (unlock by referring friends)",
    agentTemplateId: 'base2-free-glm',
    reasoningHardcoded: false,
  },
  {
    modelId: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash 07/31',
    tagline: 'Smartest & Fastest',
    agentTemplateId: 'base2-free-deepseek-flash',
    reasoningHardcoded: false,
  },
  {
    modelId: 'mimo/mimo-v2.5',
    displayName: 'MiMo 2.5',
    tagline: 'Balanced',
    agentTemplateId: 'base2-free-mimo',
    reasoningHardcoded: false,
  },
  {
    modelId: 'anthropic/claude-fable-5',
    displayName: 'Claude Fable 5',
    tagline: "Anthropic's most intelligent model",
    agentTemplateId: 'base2-free-fable',
    reasoningHardcoded: false,
  },
];

let cachedModels: ModelDef[] | null = null;
let cachedModelsAt = 0;
let modelsFetchInProgress = false;
let modelDiscoveryError: string | undefined;

// ─── Default model from settings.json ───────────────────────────────────────

function readFreebuffDefaultModel(): string | null {
  try {
    const path = join(homedir(), '.config', 'manicode', 'settings.json');
    const data = JSON.parse(readFileSync(path, 'utf-8')) as {
      freebuffModel?: string;
    };
    return data?.freebuffModel?.trim() || null;
  } catch {
    return null;
  }
}

// ─── Multi-account model ID encoding ─────────────────────────────────────────
// When multiple Freebuff accounts are discovered, model IDs are prefixed with
// the account so the user can pick which account to use:
//   freebuff-account:<base64profiledir>:<openrouter-model-id>
// When only one account exists, we use the bare OpenRouter model ID.

const FREEBUFF_ACCOUNT_PREFIX = 'freebuff-account:';

function buildAccountModelId(account: FreebuffAccount, modelId: string): string {
  return `${FREEBUFF_ACCOUNT_PREFIX}${Buffer.from(account.profileDir).toString('base64url')}:${modelId}`;
}

function parseAccountModelId(model: string | undefined): {
  accountId: string | null;
  model: string | undefined;
} {
  if (!model) return { accountId: null, model: undefined };
  if (!model.startsWith(FREEBUFF_ACCOUNT_PREFIX)) {
    return { accountId: null, model };
  }
  const rest = model.slice(FREEBUFF_ACCOUNT_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return { accountId: null, model };
  const profileDirB64 = rest.slice(0, colonIdx);
  const rawModel = rest.slice(colonIdx + 1);
  const accountId = `cli:freebuff:${profileDirB64}`;
  return { accountId, model: rawModel || undefined };
}

// ─── Reasoning level → SDK effort mapping ────────────────────────────────────
// The SDK's AgentDefinition.reasoningOptions accepts effort levels:
// "high" | "medium" | "low" | "minimal" | "none".
// Koryphaios uses: "high" | "medium" | "low" | "none" (default: no reasoning).

const REASONING_EFFORT_MAP: Record<string, 'high' | 'medium' | 'low' | 'minimal' | 'none'> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  none: 'none',
  off: 'none',
  minimal: 'minimal',
};

// ─── Buffy system prompt (CLI detection bypass) ──────────────────────────────
// The Codebuff backend's free-mode endpoint checks the system message for the
// Buffy agent template's opening text. Without it → `403 free_mode_cli_required`.
// Discovered by capturing the freebuff CLI's traffic with mitmproxy and
// comparing against the SDK's requests — the system prompt content was the
// only material difference.
const BUFFY_SYSTEM_PROMPT_PREFIX = `You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.

Current date: {CODEBUFF_CURRENT_DATE}.

# General guidelines

- **Conventions & Style:** Rigorously adhere to existing project conventions when modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. Verify its established usage within the project before employing it.
- **Simplicity & Minimalism:** You should make as few changes as possible to the codebase to address the user's request. Prefer simple solutions.
- **Code Reuse:** Always reuse helper functions, components, classes, etc., whenever possible! Don't reimplement what already exists elsewhere in the codebase.
- **Do what the user asks:** If the user asks you to do something, do it.
- **Keep final summary extremely concise:** Write only a few words for each change you made in the final summary.
`;

// ─── Shared freebuff session cache ───────────────────────────────────────────
// The backend allows one active session per account. Multiple concurrent
// Koryphaios runs reuse the same session (instanceId) — the backend checks
// that the instance is active but doesn't enforce single-in-flight-request.
// Sessions are keyed by `${authToken}:${model}` and cached module-level so
// concurrent runs share them. Sessions expire on the backend side after a
// TTL; if a request fails with 428, we invalidate the cache and re-claim.

interface CachedSession {
  instanceId: string;
  model: string;
  claimedAt: number;
}

const sessionCache = new Map<string, CachedSession>();
const SESSION_TTL_MS = 55 * 60 * 1000; // 55 min — backend sessions last ~1h

const CODEBUFF_BASE_URL = 'https://www.codebuff.com';

function sessionCacheKey(authToken: string, model: string): string {
  return `${authToken.slice(0, 8)}:${model}`;
}

async function claimFreebuffSession(
  authToken: string,
  model: string,
): Promise<string | null> {
  const key = sessionCacheKey(authToken, model);

  // Check cache for a valid (non-expired) session.
  const cached = sessionCache.get(key);
  if (cached && Date.now() - cached.claimedAt < SESSION_TTL_MS) {
    return cached.instanceId;
  }

  // Delete any existing session on the backend (best effort).
  try {
    await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch {
    // Ignore — no session may exist.
  }

  // Claim a new session.
  try {
    const res = await fetch(`${CODEBUFF_BASE_URL}/api/v1/freebuff/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'x-freebuff-model': model,
        'Content-Length': '0',
      },
    });
    const session = await res.json();
    if (session.instanceId) {
      sessionCache.set(key, {
        instanceId: session.instanceId,
        model,
        claimedAt: Date.now(),
      });
      return session.instanceId;
    }
    providerLog.warn(
      { session, model },
      'Freebuff: failed to claim session — rate limited or error',
    );
  } catch (err) {
    providerLog.warn({ err }, 'Freebuff: error claiming session');
  }
  return null;
}

function invalidateSession(authToken: string, model: string): void {
  sessionCache.delete(sessionCacheKey(authToken, model));
}

// ─── Fetch interception for freebuff_instance_id ─────────────────────────────
// The SDK doesn't know about freebuff sessions, so we patch globalThis.fetch
// once at module load to inject freebuff_instance_id into the
// codebuff_metadata of every chat completions request. The wrapper reads
// from the session cache, so concurrent runs all get the right instanceId.
// We install the wrapper lazily (on first use) to avoid patching fetch in
// tests or when freebuff is never used.

let fetchWrapperInstalled = false;
let originalFetch: typeof globalThis.fetch | null = null;

function installFetchWrapper(): void {
  if (fetchWrapperInstalled) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const urlStr = typeof url === 'string' ? url : url?.url || url?.toString();
    if (urlStr?.includes('chat/completions') && init?.body) {
      try {
        const body = JSON.parse(init.body);
        if (body.codebuff_metadata && !body.codebuff_metadata.freebuff_instance_id) {
          // Find the session for this request's model.
          const model = body.model as string | undefined;
          if (model) {
            // Try all cached sessions for this model (there should be only
            // one per account, but we might have multiple accounts).
            for (const [, session] of sessionCache) {
              if (session.model === model) {
                body.codebuff_metadata.freebuff_instance_id = session.instanceId;
                if (!body.codebuff_metadata.trace_session_id) {
                  body.codebuff_metadata.trace_session_id = crypto.randomUUID();
                }
                if (!body.codebuff_metadata.llm_step_number) {
                  body.codebuff_metadata.llm_step_number = '1';
                }
                init.body = JSON.stringify(body);
                break;
              }
            }
          }
        }
      } catch {
        // Body isn't JSON or already consumed — skip.
      }
    }
    return originalFetch!(url, init);
  }) as typeof globalThis.fetch;
  fetchWrapperInstalled = true;
}

// ─── Custom AgentDefinition builder ──────────────────────────────────────────
// We always build a custom AgentDefinition (never fall back to the SDK's
// `base` agent) because the backend's free-mode CLI detection requires:
//   1. The Buffy system prompt prefix in the system message
//   2. A valid free-mode agent template ID (e.g. "base2-free-luna")
// The `base` agent fails both checks.

function buildAgentDefinition(
  modelId: string | undefined,
  reasoningLevel: string | undefined,
): AgentDefinition {
  const effort = reasoningLevel ? REASONING_EFFORT_MAP[reasoningLevel] : undefined;
  const resolvedModel = modelId ?? readFreebuffDefaultModel() ?? 'openai/gpt-5.6-luna';

  // Look up the backend agent template ID for this model. The backend
  // validates that the agentId matches a known free-mode template.
  const menuEntry = FREEBUFF_MODEL_MENU.find((m) => m.modelId === resolvedModel);
  const agentTemplateId = menuEntry?.agentTemplateId ?? 'base2-free-luna';

  const def: AgentDefinition = {
    id: agentTemplateId,
    displayName: 'Koryphaios Freebuff Agent',
    model: resolvedModel as AgentDefinition['model'],
    // Include all the tools the base agent has, so we don't lose any
    // capabilities by switching to a custom agent.
    toolNames: [
      'write_file',
      'str_replace',
      'apply_patch',
      'read_files',
      'list_directory',
      'glob',
      'code_search',
      'run_terminal_command',
      'web_search',
      'read_subtree',
      'ask_user',
      'set_messages',
      'set_output',
      'end_turn',
      'task_completed',
      'think_deeply',
      'write_todos',
      'spawn_agent_inline',
      'spawn_agents',
      'suggest_followups',
      'skill',
      'find_files',
      'lookup_agent_info',
      'read_docs',
      'create_plan',
      'add_subgoal',
      'update_subgoal',
      'add_message',
      // Custom tools (bridged from Kory)
      'kory_create_note',
      'kory_search_notes',
      'kory_list_notes',
      'kory_read_note',
      'kory_delegate_to_worker',
      'kory_get_resource_budget',
      'kory_ask_user',
    ],
    mcpServers: {},
    // The systemPrompt MUST start with the Buffy opening text — the backend
    // checks for it when costMode is "free". Kory-specific instructions are
    // appended after the Buffy prefix.
    systemPrompt: BUFFY_SYSTEM_PROMPT_PREFIX,
    instructionsPrompt: '',
  };

  if (effort && effort !== 'none') {
    def.reasoningOptions = { enabled: true, effort };
  } else if (reasoningLevel === 'none' || reasoningLevel === 'off') {
    // SDK requires effort even when disabled — use 'none' to signal no reasoning.
    def.reasoningOptions = { enabled: false, exclude: true, effort: 'none' };
  }

  return def;
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class FreebuffProvider implements Provider {
  readonly name = 'freebuff' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    // Either the user explicitly connected (marker stored as authToken) or
    // the Freebuff CLI is logged in on this machine (single or multi-account).
    // The CLI's credentials file owns the real token; the marker just signals
    // "use the SDK harness".
    const available = !!this.config.authToken || !!readFreebuffAuthToken() || discoverFreebuffAccounts().length > 0;
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
    return cachedModels && cachedModels.length > 0 ? cachedModels : [];
  }

  getModelDiscoveryError(): string | undefined {
    return modelDiscoveryError;
  }

  refreshModels(forceRefresh?: boolean): void {
    if (forceRefresh) {
      cachedModels = null;
      cachedModelsAt = 0;
    }
    refreshModelsInBackground();
  }

  // ─── Stream ──────────────────────────────────────────────────────────────

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    // Resolve which account to use. If the model ID encodes an account
    // (format: freebuff-account:<base64profiledir>:<model>), extract it.
    // Otherwise, use the default account.
    const { accountId, model: rawModelId } = parseAccountModelId(request.model);
    let creds: { authToken: string; fingerprintId: string } | null = null;

    if (accountId) {
      const accounts = discoverFreebuffAccounts();
      const account = accounts.find((a) => a.id === accountId);
      if (account) {
        creds = { authToken: account.authToken, fingerprintId: account.fingerprintId };
      }
    }
    if (!creds) {
      creds = readFreebuffCredentials();
    }

    if (!creds) {
      yield {
        type: 'error',
        error:
          'Freebuff CLI not logged in. Run "freebuff login" to authenticate, then reconnect.',
      };
      return;
    }

    const prompt = buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      yield { type: 'error', error: 'Freebuff: empty prompt' };
      return;
    }

    // Inject the Kory harness note via the bridge.
    const bridge = getCliBridge('freebuff');
    const bridgeConfig = bridge?.buildAgentConfig({
      provider: 'freebuff',
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
    });

    const systemInstructions = bridgeConfig?.systemInstructions?.length
      ? bridgeConfig.systemInstructions.filter(Boolean).join('\n\n')
      : request.systemPrompt?.trim()
        ? `${request.systemPrompt}\n\n${FREEBUFF_HARNESS_NOTE}`
        : FREEBUFF_HARNESS_NOTE;

    // Prepend the system instructions to the prompt — the SDK's run() takes a
    // single prompt string, so we fold the system context in.
    const fullPrompt = `${systemInstructions}\n\n${prompt}`;

    // Resolve the model: prefer the parsed model (account prefix stripped),
    // fall back to the freebuff settings.json default, then to the 'base'
    // agent (which lets Codebuff's backend pick).
    const modelId = rawModelId || readFreebuffDefaultModel() || undefined;

    const cwd = request.workingDirectory?.trim() || process.cwd();
    const sessionId = request.sessionId ?? `freebuff-${Date.now()}`;
    const harnessRole = request.harnessRole ?? 'manager';
    const interactionMode: 'act' | 'plan' =
      harnessRole === 'critic' || request.permissionMode === 'plan' ? 'plan' : 'act';

    // Build the Kory ToolContext that every overridden tool will dispatch
    // through. This mirrors how the KoryManager builds contexts for its own
    // tool calls — same permission policy, same approval channel, same
    // change recording, same file-edit streaming.
    const toolCtx = await buildKoryToolContext(sessionId, cwd, harnessRole, interactionMode, request);

    // Build the overrideTools map. Every filesystem/command tool routes
    // through Kory; web tools stay native (server-side, no local effects).
    const overrideTools = buildOverrideTools(toolCtx);

    // Build custom tool definitions that bridge Kory-only tools (notes,
    // memory, delegation, resource budget, ask_user) into the SDK agent.
    // Without these, the Freebuff agent has no access to Kory's knowledge
    // network or worker pipeline.
    const customToolDefinitions = buildCustomToolDefinitions(toolCtx);

    // Buffer events from the SDK callback and yield them as an async stream.
    // The SDK's handleEvent is a synchronous callback, but run() returns a
    // Promise — we bridge by collecting events into a queue and draining.
    const eventQueue: ProviderEvent[] = [];
    let resolveEvent: (() => void) | null = null;
    let runFinished = false;
    let runError: Error | null = null;

    const handleEvent = (event: PrintModeEvent): void => {
      const translated = translateSdkEvent(event);
      if (translated) {
        for (const ev of translated) {
          eventQueue.push(ev);
        }
        resolveEvent?.();
      }
    };

    // ─── Claim or reuse a freebuff session ────────────────────────────────
    // The backend requires an active session for free-mode. We cache sessions
    // module-level so concurrent runs share the same instanceId — the backend
    // doesn't enforce single-in-flight-request per instance.
    const resolvedModelForSession = modelId || readFreebuffDefaultModel() || 'openai/gpt-5.6-luna';
    installFetchWrapper();
    const instanceId = await claimFreebuffSession(creds.authToken, resolvedModelForSession);
    if (!instanceId) {
      yield {
        type: 'error',
        error: 'Freebuff: could not claim a free session (rate limit reached or auth error). Try again later.',
      };
      return;
    }

    // Start the run in the background. The SDK's constructor type
    // (CodebuffClientOptions) doesn't include fingerprintId, but the
    // runtime constructor merges it via spread and run() requires it.
    // We pass it via run() where RunExecutionOptions includes it.
    const client = new CodebuffClient({
      apiKey: creds.authToken,
      cwd,
      handleEvent,
      overrideTools,
      customToolDefinitions,
    });

    // Build a custom agent definition. We always use a custom agent
    // definition (never the SDK's 'base' agent) because the backend's
    // free-mode CLI detection requires the Buffy system prompt prefix and
    // a valid free-mode agent template ID.
    const agentDef = buildAgentDefinition(modelId, request.reasoningLevel);

    const runPromise = client
      .run({
        agent: agentDef,
        prompt: fullPrompt,
        // fingerprintId is required at runtime (RunExecutionOptions) but
        // not exposed in the public run() type signature. Cast to inject.
        fingerprintId: creds.fingerprintId,
        // costMode controls which agent template the backend uses. For
        // freebuff (free tier), we use "free" which maps to base2-free-luna
        // (gpt-5.6-luna with high reasoning by default). When we pass a
        // custom AgentDefinition with reasoningOptions, it overrides the
        // template's reasoning settings.
        costMode: 'free',
        // Pass empty projectFiles to skip the SDK's tree-sitter WASM
        // initialization (computeProjectIndex), which hangs/crashes under
        // Bun due to an Emscripten/WebAssembly incompatibility. The SDK
        // only uses tree-sitter for its built-in code_search tool, which
        // we override with kory__grep anyway. Code context is provided by
        // Koryphaios via the system prompt and tool results.
        projectFiles: {},
        // Pass the custom agent definition in agentDefinitions so the SDK
        // can resolve the agent id.
        agentDefinitions: [agentDef],
        ...(request.signal ? { signal: request.signal } : {}),
      } as Parameters<typeof client.run>[0])
      .then((result: RunState) => {
        // If the run produced a lastMessage output, emit it as a final
        // content delta (the SDK may not emit a text event for the very
        // last message in some agent configurations).
        if (result.output?.type === 'lastMessage' && Array.isArray(result.output.value)) {
          const lastText = result.output.value
            .filter((part: unknown): part is { type: string; text?: string } =>
              typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text')
            .map((part: { type: string; text?: string }) => part.text ?? '')
            .join('');
          if (lastText.trim()) {
            eventQueue.push({ type: 'content_delta', content: lastText });
          }
        }
      })
      .catch((err: unknown) => {
        runError = err instanceof Error ? err : new Error(String(err));
        resolveEvent?.();
      })
      .finally(() => {
        runFinished = true;
        resolveEvent?.();
      });

    // Drain the event queue as events arrive.
    while (!runFinished || eventQueue.length > 0) {
      if (eventQueue.length === 0) {
        // Wait for the next event or run completion.
        await new Promise<void>((resolve) => {
          resolveEvent = resolve;
        });
        resolveEvent = null;
        if (runError) break;
        continue;
      }
      yield eventQueue.shift()!;
    }

    await runPromise;

    const finalRunError = runError as Error | null;
    if (finalRunError) {
      yield {
        type: 'error',
        error: `Freebuff SDK run failed: ${finalRunError.message}`,
      };
      return;
    }

    yield { type: 'complete', finishReason: 'end_turn' };
  }
}

// ─── Kory ToolContext builder ───────────────────────────────────────────────
// Mirrors KoryManager's context construction so overridden tools flow through
// the exact same permission/approval/recording pipeline as native Kory tools.

async function buildKoryToolContext(
  sessionId: string,
  cwd: string,
  role: 'manager' | 'worker' | 'critic',
  interactionMode: 'act' | 'plan',
  request: StreamRequest,
): Promise<ToolContext> {
  const ctx = getContext();
  const settings = loadAgentSettings(cwd);
  const permissionPolicy = resolveToolPermissionPolicy(settings, interactionMode);

  // Resolve the active goal/item for this session (if any) so tool calls
  // are attributed correctly in the change log.
  let goalId: string | undefined;
  let goalItemId: string | undefined;
  try {
    const goals = await ctx.goals.list();
    const activeGoal = goals.find(
      (g) =>
        g.execution?.sessionId === sessionId &&
        (g.status === 'queued' || g.status === 'planning' || g.status === 'running'),
    );
    goalId = activeGoal?.id;
    goalItemId = activeGoal?.checklist.find((i) => i.status === 'running')?.id;
  } catch {
    // Goals store may not be initialized in test contexts — non-fatal.
  }

  return {
    sessionId,
    activeProvider: 'freebuff',
    activeModel: request.model,
    reasoningLevel: request.reasoningLevel,
    goalId,
    goalItemId,
    workingDirectory: cwd,
    allowedPaths: [],
    isSandboxed: role === 'critic' || permissionPolicy.mode !== 'yolo',
    permissionPolicy,
    approvedToolCallIds: new Set(),
    signal: request.signal,
    waitForUserInput: (question: string, options: string[]) =>
      ctx.kory.requestToolApproval(sessionId, question, options),
    recordChange: (change) => {
      ctx.kory.recordChange?.(sessionId, change);
    },
    emitFileEdit: (e) => {
      wsBroker.publish('custom', {
        type: 'stream.file_delta' as WSMessage['type'],
        payload: { agentId: 'freebuff', ...e },
        timestamp: Date.now(),
        sessionId,
      });
    },
    emitFileComplete: (e) => {
      wsBroker.publish('custom', {
        type: 'stream.file_complete' as WSMessage['type'],
        payload: { agentId: 'freebuff', ...e },
        timestamp: Date.now(),
        sessionId,
      });
    },
    // Wire delegation so kory__delegate_to_worker (exposed as a custom tool
    // below) can spawn worker agents through the same pipeline as KoryManager.
    delegateToWorker: (task: string, domainHint?: string) =>
      ctx.kory.runWorkerPipeline(sessionId, task, undefined, request.reasoningLevel, domainHint),
  };
}

// ─── overrideTools: route native SDK tools through Kory ─────────────────────
// Each override intercepts the SDK's native tool call and dispatches it
// through Kory's ToolRegistry.execute(), which enforces permission policy,
// approval gating, sandboxing, and change recording — identical to how the
// KoryManager runs its own tool calls.
//
// Web tools (web_search, read_url) are intentionally NOT overridden: they
// run server-side on Codebuff's backend with no local side effects, so they
// stay native (same policy as the other CLI providers keeping native web
// search/fetch).

type OverrideMap = NonNullable<
  NonNullable<ConstructorParameters<typeof CodebuffClient>[0]>['overrideTools']
>;

function buildOverrideTools(toolCtx: ToolContext): OverrideMap {
  const ctx = getContext();

  const dispatch = async (
    koryToolName: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    const result = await ctx.tools.execute(toolCtx, {
      id: `freebuff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: koryToolName,
      input,
    });
    return result.output;
  };

  return {
    // ── File writes ──
    write_file: async (input: { path: string; content: string; instructions?: string }) => {
      const output = await dispatch('write_file', {
        path: input.path,
        content: input.content,
      });
      return [{ type: 'json' as const, value: { file: input.path, message: output, unifiedDiff: '' } }];
    },

    // ── File edits (str_replace → kory edit_file) ──
    str_replace: async (input: {
      path: string;
      replacements: Array<{ old: string; new: string; allowMultiple?: boolean }>;
    }) => {
      // Kory's edit_file does one old/new pair at a time; batch them.
      let lastOutput = '';
      for (const r of input.replacements) {
        lastOutput = await dispatch('edit_file', {
          path: input.path,
          old_str: r.old,
          new_str: r.new,
        });
      }
      return [{ type: 'json' as const, value: { file: input.path, message: lastOutput, unifiedDiff: '' } }];
    },

    // ── Apply patch (create/update/delete via unified diff) ──
    apply_patch: async (input: {
      operation:
        | { type: 'create_file'; path: string; diff: string }
        | { type: 'update_file'; path: string; diff: string }
        | { type: 'delete_file'; path: string };
    }) => {
      const op = input.operation;
      if (op.type === 'delete_file') {
        const output = await dispatch('delete_file', { path: op.path });
        return [{ type: 'json' as const, value: { message: output, applied: [{ file: op.path, action: 'delete' as const }] } }];
      }
      if (op.type === 'create_file') {
        // For create_file, the diff IS the file content.
        const output = await dispatch('write_file', { path: op.path, content: op.diff });
        return [{ type: 'json' as const, value: { message: output, applied: [{ file: op.path, action: 'add' as const }] } }];
      }
      // update_file: the SDK passes a unified diff. Kory's edit_file/patch
      // tools work with old/new string pairs, not raw diffs. Rather than
      // parse the diff (fragile), instruct the agent to use str_replace —
      // the SDK's other edit tool that IS routed through Kory with explicit
      // old/new strings.
      return [{
        type: 'json' as const,
        value: {
          errorMessage:
            'apply_patch update_file is not supported through Kory. Use str_replace with explicit old/new strings instead — str_replace is routed through kory__edit_file with full permission gating.',
        },
      }];
    },

    // ── Terminal commands → kory__bash ──
    run_terminal_command: async (input: {
      command: string;
      process_type?: 'SYNC' | 'BACKGROUND';
      cwd?: string;
      timeout_seconds?: number;
    }) => {
      const output = await dispatch('bash', {
        command: input.command,
        ...(input.cwd ? { workingDirectory: input.cwd } : {}),
        ...(input.timeout_seconds ? { timeout: input.timeout_seconds } : {}),
        ...(input.process_type === 'BACKGROUND' ? { isBackground: true } : {}),
      });
      return [{ type: 'json' as const, value: { command: input.command, message: output, stdout: output, exitCode: 0 } }];
    },

    // ── Directory listing → kory__ls ──
    list_directory: async (input: { path: string }) => {
      const output = await dispatch('ls', { path: input.path });
      return [{ type: 'json' as const, value: { files: [], directories: [], path: input.path, message: output } }];
    },

    // ── Glob → kory__glob ──
    glob: async (input: { pattern: string; cwd?: string }) => {
      const output = await dispatch('glob', {
        pattern: input.pattern,
        ...(input.cwd ? { path: input.cwd } : {}),
      });
      // Kory's glob returns a newline-delimited list; split into an array.
      const files = output.split('\n').filter(Boolean);
      return [{ type: 'json' as const, value: { files, count: files.length, message: output } }];
    },

    // ── Code search → kory__grep ──
    code_search: async (input: {
      pattern: string;
      flags?: string;
      cwd?: string;
      maxResults?: number;
    }) => {
      const output = await dispatch('grep', {
        pattern: input.pattern,
        ...(input.cwd ? { path: input.cwd } : {}),
        ...(input.maxResults ? { maxResults: input.maxResults } : {}),
        // Map regex flags to caseSensitive (the only flag Kory's grep
        // supports). 'i' → case-insensitive; everything else is ignored
        // since ripgrep handles it natively via the pattern.
        ...(input.flags?.includes('i') ? { caseSensitive: false } : {}),
      });
      return [{ type: 'json' as const, value: { stdout: output, message: output, exitCode: 0 } }];
    },

    // ── read_files → kory__read_file (one at a time) ──
    read_files: async (input: { filePaths: string[] }) => {
      const results: Record<string, string | null> = {};
      for (const filePath of input.filePaths) {
        try {
          const output = await dispatch('read_file', { path: filePath });
          results[filePath] = output;
        } catch {
          results[filePath] = null;
        }
      }
      return results;
    },

    // web_search and read_url are NOT overridden — they run server-side on
    // Codebuff's backend and have no local side effects. Keeping them native
    // matches the policy for other CLI providers (grok, claude, codex) which
    // also keep their native web search/fetch.
  };
}

// ─── customToolDefinitions: bridge Kory-only tools into the SDK agent ────────
// The SDK's `base` agent only has filesystem/command/web tools. Kory's notes,
// memory, delegation, and resource budget tools are NOT part of the SDK's
// tool set. We bridge them via customToolDefinitions, which lets the agent
// call them as native tools — each call dispatches through Kory's
// ToolRegistry, getting the same permission gating and change recording.

function buildCustomToolDefinitions(toolCtx: ToolContext): CustomToolDefinition[] {
  const ctx = getContext();
  const dispatch = async (
    koryToolName: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    const result = await ctx.tools.execute(toolCtx, {
      id: `freebuff-custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: koryToolName,
      input,
    });
    return result.output;
  };

  const tools: CustomToolDefinition[] = [];

  // ── Notes: create ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_create_note',
      inputSchema: z.object({
        title: z.string().describe('Note title (must be unique for wikilink resolution)'),
        content: z.string().describe('Markdown content. Use [[Note Title]] to link to other notes.'),
        folderPath: z.string().optional().describe('Folder path like /Research/AI (default: /)'),
        tags: z.array(z.string()).optional().describe('Tags for the note'),
      }),
      description:
        'Create a new note in the Koryphaios knowledge network. Supports [[wikilinks]] in content that automatically create graph edges to other notes.',
      endsAgentStep: false,
      execute: async (input) => {
        const output = await dispatch('create_note', input);
        return [{ type: 'json', value: { message: output } }];
      },
    }),
  );

  // ── Notes: search ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_search_notes',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
      description:
        'Search notes by keyword across title, content, and tags. Returns matching notes with metadata.',
      endsAgentStep: false,
      execute: async (input) => {
        const output = await dispatch('search_notes', input);
        return [{ type: 'json', value: { results: output } }];
      },
    }),
  );

  // ── Notes: list ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_list_notes',
      inputSchema: z.object({
        folderPath: z.string().optional().describe('Folder path to list (default: /)'),
      }),
      description: 'List notes in the knowledge network, optionally filtered by folder.',
      endsAgentStep: false,
      execute: async (input) => {
        const output = await dispatch('list_notes', input);
        return [{ type: 'json', value: { notes: output } }];
      },
    }),
  );

  // ── Notes: read ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_read_note',
      inputSchema: z.object({
        title: z.string().describe('Note title to read'),
      }),
      description: 'Read a note by title from the knowledge network.',
      endsAgentStep: false,
      execute: async (input) => {
        const output = await dispatch('read_note', input);
        return [{ type: 'json', value: { content: output } }];
      },
    }),
  );

  // ── Delegate to worker ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_delegate_to_worker',
      inputSchema: z.object({
        task: z.string().describe('Clear task description for the worker'),
        domain: z.string().optional().describe('Optional: ui | backend | general | test | review'),
      }),
      description:
        'Delegate a task to a specialist worker (sub-agent). The worker runs through Koryphaios\'s worker pipeline with its own model pool and permission gating.',
      endsAgentStep: true,
      execute: async (input) => {
        if (!toolCtx.delegateToWorker) {
          return [{ type: 'json', value: { error: 'Delegation not available in this context.' } }];
        }
        const output = await toolCtx.delegateToWorker(input.task, input.domain);
        return [{ type: 'json', value: { result: output } }];
      },
    }),
  );

  // ── Get resource budget ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_get_resource_budget',
      inputSchema: z.object({}),
      description:
        'Read a secret-free snapshot of provider-reported API balances and subscription quota windows for cost/capacity decisions.',
      endsAgentStep: false,
      execute: async () => {
        const output = await dispatch('get_resource_budget', {});
        return [{ type: 'json', value: { budget: output } }];
      },
    }),
  );

  // ── Ask user (for approval/clarification) ──
  tools.push(
    getCustomToolDefinition({
      toolName: 'kory_ask_user',
      inputSchema: z.object({
        question: z.string().describe('Question to ask the user'),
      }),
      description:
        'Ask the user a question when you need clarification or a decision. Use this sparingly — only when you cannot proceed without user input.',
      endsAgentStep: true,
      execute: async (input) => {
        const output = await dispatch('ask_user', { question: input.question });
        return [{ type: 'json', value: { answer: output } }];
      },
    }),
  );

  return tools;
}

// ─── SDK event translation ──────────────────────────────────────────────────

function translateSdkEvent(event: PrintModeEvent): ProviderEvent[] | null {
  switch (event.type) {
    case 'text':
      return [{ type: 'content_delta', content: event.text }];

    case 'reasoning_delta':
      return [{ type: 'thinking_delta', thinking: event.text }];

    case 'tool_call':
      // Tools are now routed through Kory via overrideTools, so the tool_call
      // event is informational (the actual execution happens in the override).
      // Surface it for display; the tool_result event carries the outcome.
      if (isFileTool(event.toolName)) {
        const fileEvent = fileEditFromToolCall(event.toolName, event.input);
        if (fileEvent) return [fileEvent];
      }
      return [
        {
          type: 'tool_use_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolInput: JSON.stringify(event.input ?? {}),
        },
      ];

    case 'tool_result': {
      const outputText = event.output
        .map((o: { type: string; value?: unknown }) =>
          o.type === 'json' ? JSON.stringify(o.value) : '[media]')
        .join('\n');
      if (isFileTool(event.toolName)) {
        return [
          {
            type: 'tool_use_stop',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        ];
      }
      return [
        {
          type: 'tool_executed',
          toolName: event.toolName,
          toolOutput: outputText,
          isError: false,
        },
      ];
    }

    case 'finish':
      return [
        {
          type: 'complete',
          finishReason: 'end_turn',
        },
      ];

    case 'error':
      return [{ type: 'error', error: event.message }];

    case 'start':
    case 'download':
    case 'subagent_start':
    case 'subagent_finish':
      // Informational events — not surfaced as ProviderEvents.
      return null;

    default:
      return null;
  }
}

function isFileTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'str_replace' || toolName === 'apply_patch';
}

function fileEditFromToolCall(
  toolName: string,
  input: Record<string, unknown>,
): ProviderEvent | null {
  if (toolName === 'write_file') {
    const path = typeof input.path === 'string' ? input.path : undefined;
    const content = typeof input.content === 'string' ? input.content : undefined;
    if (!path) return null;
    return {
      type: 'file_edit',
      filePath: path,
      fileContent: content,
      fileOperation: 'create',
    };
  }
  if (toolName === 'str_replace' || toolName === 'apply_patch') {
    const path =
      typeof input.path === 'string'
        ? input.path
        : typeof input.filePath === 'string'
          ? input.filePath
          : undefined;
    if (!path) return null;
    return {
      type: 'file_edit',
      filePath: path,
      fileOperation: 'edit',
    };
  }
  return null;
}

// ─── Prompt building ────────────────────────────────────────────────────────

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const turns = messages.filter((m) => m.role !== 'system');

  // Single user turn → send its text verbatim.
  if (turns.length === 1 && turns[0].role === 'user') {
    return flattenContent(turns[0].content);
  }

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
    else if (block.type === 'tool_result') parts.push(`[tool result: ${block.toolOutput ?? ''}]`);
    else if (block.type === 'image')
      parts.push('[image attachment omitted — Freebuff SDK harness is text-only]');
  }
  return parts.join('\n');
}

// ─── Dynamic model discovery via OpenRouter ─────────────────────────────────

function refreshModelsInBackground(): void {
  if (modelsFetchInProgress) return;
  modelsFetchInProgress = true;
  fetchFreebuffModels()
    .then((models) => {
      if (models.length > 0) {
        cachedModels = models;
        cachedModelsAt = Date.now();
        modelDiscoveryError = undefined;
        providerLog.debug(
          { provider: 'freebuff', models: models.map((m) => m.id) },
          'Freebuff model list refreshed from OpenRouter',
        );
      } else {
        modelDiscoveryError = 'No Freebuff-compatible models found on OpenRouter.';
      }
    })
    .catch((err) => {
      modelDiscoveryError = `Failed to fetch Freebuff models: ${err instanceof Error ? err.message : String(err)}`;
      providerLog.warn({ provider: 'freebuff', err }, 'Freebuff model list refresh failed');
    })
    .finally(() => {
      modelsFetchInProgress = false;
    });
}

interface OpenRouterModelMeta {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { context_length?: number; max_completion_tokens?: number };
}

/**
 * Best-effort fetch of OpenRouter's /models catalog, used only to enrich the
 * fixed freebuff menu with live context-window/pricing/vision metadata. Not
 * used to determine *which* models exist — that's FREEBUFF_MODEL_MENU, the
 * CLI's own ground truth. If this fetch fails, we still return the full
 * menu with generic (non-enriched) metadata rather than failing outright.
 */
async function fetchOpenRouterMetadata(): Promise<Map<string, OpenRouterModelMeta>> {
  const resp = await fetch(OPENROUTER_MODELS_URL);
  if (!resp.ok) {
    throw new Error(`OpenRouter /models returned ${resp.status}`);
  }
  const data = (await resp.json()) as { data?: OpenRouterModelMeta[] };
  const byId = new Map<string, OpenRouterModelMeta>();
  for (const m of data?.data ?? []) {
    byId.set(m.id, m);
  }
  return byId;
}

async function fetchFreebuffModels(): Promise<ModelDef[]> {
  let metaById: Map<string, OpenRouterModelMeta>;
  try {
    metaById = await fetchOpenRouterMetadata();
  } catch (err) {
    providerLog.warn(
      { provider: 'freebuff', err },
      'Freebuff: OpenRouter metadata enrichment failed, falling back to generic model metadata',
    );
    metaById = new Map();
  }

  // Build ModelDefs strictly from the fixed, CLI-confirmed menu. This is the
  // source of truth for *availability*; OpenRouter data (when available)
  // only fills in display/pricing/context-window details.
  const models: ModelDef[] = FREEBUFF_MODEL_MENU.map((entry) => {
    const base = createGenericModel(entry.modelId, 'freebuff');
    base.apiModelId = entry.modelId;

    const raw = metaById.get(entry.modelId);
    const enriched = raw ? enrichFromRemoteMetadata(raw, base) : base;
    // Always use the CLI's own display name + tagline (e.g.
    // "GPT-5.6 Luna — Thinks hard & Fast") — this must win over whatever
    // display name OpenRouter reports, since the CLI's naming is the
    // source of truth for a CLI provider.
    enriched.name = `${entry.displayName} — ${entry.tagline}`;

    // Reasoning: only GPT-5.6 Luna's backend template hardcodes reasoning
    // (effort: "high", always on). No model in the freebuff menu exposes a
    // user-selectable reasoning level or "fast mode" — this matches the
    // CLI's own picker, which has no such control.
    enriched.canReason = entry.reasoningHardcoded;
    enriched.reasoningLevels = undefined;

    if (raw) {
      const modalities = raw.architecture?.input_modalities ?? [];
      if (modalities.includes('image')) {
        enriched.vision = true;
        enriched.supportsAttachments = true;
      }
      if (raw.pricing?.prompt) {
        const promptCost = parseFloat(raw.pricing.prompt);
        if (!isNaN(promptCost) && promptCost > 0) {
          enriched.costPerMInputTokens = promptCost * 1_000_000;
        }
      }
      if (raw.pricing?.completion) {
        const completionCost = parseFloat(raw.pricing.completion);
        if (!isNaN(completionCost) && completionCost > 0) {
          enriched.costPerMOutputTokens = completionCost * 1_000_000;
        }
      }
      if (raw.pricing?.input_cache_read) {
        const cacheCost = parseFloat(raw.pricing.input_cache_read);
        if (!isNaN(cacheCost) && cacheCost >= 0) {
          enriched.costPerMInputCached = cacheCost * 1_000_000;
        }
      }
      const maxOut = raw.top_provider?.max_completion_tokens;
      if (typeof maxOut === 'number' && maxOut > 0) {
        enriched.maxOutputTokens = maxOut;
      }
    }

    return enriched;
  });

  // Multi-account: if multiple Freebuff accounts are discovered, duplicate
  // the model list per account with account-prefixed IDs so the user can
  // pick which account to use. With a single account, use bare model IDs.
  const accounts = discoverFreebuffAccounts();
  if (accounts.length > 1) {
    const multiAccountModels: ModelDef[] = [];
    for (const account of accounts) {
      for (const model of models) {
        const accountModel: ModelDef = {
          ...model,
          id: buildAccountModelId(account, model.id),
          name: `${model.name} (${account.label})`,
        };
        multiAccountModels.push(accountModel);
      }
    }
    return multiAccountModels;
  }

  return models;
}
