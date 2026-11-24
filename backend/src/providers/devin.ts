// Devin CLI provider — runs Cognition's official `devin` CLI harness.
//
// Like the other subscription CLIs (claude-code, cursor): no API key needed in
// Koryphaios — the locally logged-in `devin` binary authenticates itself.
// Headless `-p` writes CLI output to stdout; authoritative agent messages,
// per-step reasoning, tool calls with output, and exact token usage come from
// the `--export` ATIF JSON. Stdout remains a fallback for legacy exports.
//
// Model list: `devin models list` reports the account's real catalog — SWE,
// Claude, GPT, Gemini, GLM, Kimi, Fusion families selected via --model. There
// is no separate reasoning-effort flag — the tier is part of the model name
// (e.g. swe-2-medium / swe-2-high, claude-opus-5-5-max) — so per-effort slugs
// are collapsed into one base model whose `reasoningLevels`/`reasoningVariants`
// drive the native Koryphaios reasoning picker; resolveCliModel maps the pick
// back to the slug passed to --model.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { whichBinary } from './cli-detection';
import { detectDevinCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import { applyModelsDevMetadata, refreshModelsDevCache } from './models-dev';
import {
  buildSoftJail,
  inferenceSandboxPolicy,
  wrapCommand,
} from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { DevinCliBridge, getKoryphaiosDevinHome } from './devin-bridge';
import { DevinLiveTail } from './devin-live-tail';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { koryBridgeUnavailableError } from './kory-cli-mcp-config';
import {
  getDevinCapabilitiesAsync,
  getDevinCapabilities as getDevinCapabilitiesSync,
  invalidateDevinCapabilities,
  collapseDevinReasoningTiers,
  matchDevinModel,
  resolveDevinSlug,
} from './devin-capabilities';
import { parseFusionSlug, resolveFusionSlug } from '@koryphaios/shared';
import type { FusionSelection } from '@koryphaios/shared';
import {
  getDevinAccountSnapshot,
  devinQuotaGroupsFrom,
  type DevinQuotaGroup,
} from './devin-account';
import {
  assertPrivateValuesAbsentFromArgv,
  createPrivateCliTextArtifact,
  spawnWithPrivateArtifactCleanup,
  type PrivateCliArtifact,
} from './private-cli-transport';
import {
  appendPrivateDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import { writeManagedCliFile } from './managed-cli-storage';
import { buildProviderCliEnv } from './cli-environment';

const DEVIN_STREAM_TIMEOUT_MS = 300_000;
const EXPORT_POLL_MS = 250;

export function sanitizeDevinOutput(value: string): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/g, '')
    .replace(
      /^(?:Welcome to Devin CLI!|Logged in as .+\.|✓ Organization: .+|You're all set\. Run devin to get started\.)\r?\n?/gm,
      '',
    );
}

export function selectDevinResponseEvents(
  stdout: string,
  exportEvents: ProviderEvent[],
): ProviderEvent[] {
  if (exportEvents.some((event) => event.type === 'content_delta' && event.content?.trim())) {
    return exportEvents;
  }
  return [
    ...(stdout.trim() ? [{ type: 'content_delta' as const, content: stdout }] : []),
    ...exportEvents.filter((event) => event.type !== 'content_delta'),
  ];
}

export function buildDevinProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  jailEnv: NodeJS.ProcessEnv | undefined,
  devinHome: string | null,
): NodeJS.ProcessEnv {
  return {
    ...(jailEnv ?? baseEnv),
    ...(devinHome
      ? {
          DEVIN_CONFIG_DIR: devinHome,
          XDG_CONFIG_HOME: devinHome,
          XDG_DATA_HOME: join(devinHome, '.local', 'share'),
          XDG_CACHE_HOME: join(devinHome, '.cache'),
          XDG_STATE_HOME: join(devinHome, '.local', 'state'),
          HOME: devinHome,
          USERPROFILE: devinHome,
        }
      : {}),
    NO_COLOR: '1',
    TERM: 'dumb',
  };
}

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Koryphaios owns tool execution, ' +
  'permissions, and orchestration. Use the role-scoped kory__ tools from the kory MCP server ' +
  'instead of native read, write, edit, exec, web, or subagent tools. Never spawn native ' +
  'subagents; delegate only through an available kory__ tool, or explain what delegation is needed.';

function buildPrompt(systemPrompt: string | undefined, messages: ProviderMessage[]): string {
  const lines: string[] = [];
  const sys = systemPrompt?.trim();
  lines.push(sys ? `${sys}\n\n${HARNESS_SYSTEM_NOTE}` : HARNESS_SYSTEM_NOTE, '');
  for (const m of messages) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) =>
              b.type === 'text' ? b.text : b.type === 'image' ? '[image attachment]' : '',
            )
            .filter(Boolean)
            .join('\n');
    if (!content.trim()) continue;
    if (m.role === 'user') lines.push(`User: ${content}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${content}`);
    else if (m.role === 'tool') lines.push(`Tool result: ${content.slice(0, 8_000)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Build the prompt body from user/assistant/tool messages ONLY — used when
 *  --agent-config carries the system prompt via system_instructions, so the
 *  HARNESS_SYSTEM_NOTE is not duplicated into the body. */
function buildPromptBodyOnly(messages: ProviderMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) =>
              b.type === 'text' ? b.text : b.type === 'image' ? '[image attachment]' : '',
            )
            .filter(Boolean)
            .join('\n');
    if (!content.trim()) continue;
    if (m.role === 'user') lines.push(`User: ${content}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${content}`);
    else if (m.role === 'tool') lines.push(`Tool result: ${content.slice(0, 8_000)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export class DevinProvider implements Provider {
  readonly imageInputTransport = 'none' as const;
  readonly name = 'devin' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('devin') && detectDevinCLILogin();
  }

  listModels(): ModelDef[] {
    // `devin models` is account-scoped; never synthesize a list before it
    // reports one. The CLI's `models list` is human-formatted and only
    // reports model id + name; context windows must be enriched from the
    // public models.dev catalog. Devin hosts a wide variety of models
    // (Claude, GPT, Gemini, GLM, Kimi, Llama, …) under one subscription,
    // so we look under the most common upstream provider keys.
    refreshModelsDevCache();
    const caps = getDevinCapabilitiesSync();
    const base: ModelDef[] = caps.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: 'devin' as const,
      apiModelId: m.id,
      contextWindow: m.contextWindow ?? 0,
      contextVerified: typeof m.contextWindow === 'number' && m.contextWindow >= 1024,
      maxOutputTokens: 0,
      costPerMInputTokens: m.costPerMInputTokens,
      costPerMInputCached: m.costPerMInputCached,
      costPerMOutputTokens: m.costPerMOutputTokens,
    }));
    const enriched = applyModelsDevMetadata('devin', base, [
      'anthropic',
      'openai',
      'google',
      'xai',
      'zai',
      'moonshot',
      'mistral',
      'deepseek',
    ]);
    // Devin encodes effort in the model slug (`claude-opus-5-5-high`,
    // `gpt-6-sol-low-priority`, `glm-5-2-none-1m`). Collapse every per-effort
    // family into one base model exposing the real tiers as `reasoningLevels`
    // + `reasoningVariants` — the same native Koryphaios mapping providers
    // with a reasoning parameter get, resolved back to a concrete slug at
    // spawn time via resolveCliModel. Models with no effort siblings keep
    // their verbatim id; generic models.dev `reasoningLevels` on them are
    // dropped — a single-tier slug cannot take an effort.
    return collapseDevinReasoningTiers(enriched).map((m) =>
      m.reasoningVariants ? m : { ...m, reasoningLevels: undefined },
    );
  }

  async refreshModels(): Promise<void> {
    // The capability cache is keyed on the binary path + mtime and has no TTL,
    // so a forced refresh previously re-probed nothing: `getDevinCapabilitiesAsync`
    // returned the memoised result and `devin models list` never ran again
    // unless the binary changed on disk. Drop the cache first so an explicit
    // refresh is actually a refresh.
    invalidateDevinCapabilities();
    await getDevinCapabilitiesAsync();
  }

  private quotaGroupsCache: DevinQuotaGroup[] | null = null;

  /** Synchronous quota-groups read for GET /api/providers/devin/quota — the
   *  route contract is sync, so this kicks an account refresh in the
   *  background and serves last-known groups (same pattern as the Antigravity
   *  provider's module cache). */
  getQuotaGroups(): DevinQuotaGroup[] | null {
    void getDevinAccountSnapshot()
      .then((snapshot) => {
        this.quotaGroupsCache = devinQuotaGroupsFrom(snapshot);
      })
      .catch(() => {});
    return this.quotaGroupsCache;
  }

  private resolveCliModel(
    modelId: string | undefined,
    effort?: string,
    speedTier?: string,
    fusion?: FusionSelection,
  ): { slug: string } | { error: string } | undefined {
    if (!modelId) return undefined;
    const match = matchDevinModel(this.listModels(), modelId);
    if (!match) return { slug: modelId.replace(/^devin-/, '') };
    if (match.model.fusion) {
      // Fusion is one model with two composer-edited slots; the exact slug
      // comes from the catalog's pairing matrix, never the generic
      // effort/speed fold. A legacy `fusion-…` alias restores its own cell.
      const catalog = match.model.fusion;
      const legacySel = modelId.startsWith('fusion-') ? parseFusionSlug(modelId) : undefined;
      const sel = fusion ?? legacySel ?? catalog.defaultSelection;
      const slug = resolveFusionSlug(catalog, sel);
      if (!slug) {
        return {
          error: "This Fusion pairing isn't offered by Devin. Pick another Fusion 2 model.",
        };
      }
      return { slug };
    }
    // The Koryphaios reasoning level plus the composer's speed tier resolve
    // to the concrete Devin slug for --model. `auto`/unset falls through to
    // the family's default slug (bare member when the CLI offers one, else
    // its medium/default tier); a speed variant only replaces it when the
    // tier covers that effort, and a persisted fast selection implies the
    // tier on its own.
    const slug = resolveDevinSlug(
      match.model,
      effort ?? match.legacyEffort,
      speedTier ?? match.legacySpeedTier,
    );
    return { slug: slug.replace(/^devin-/, '') };
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const researchOnly = request.capabilityProfile === 'research-only';
    const bin = whichBinary('devin');
    if (!bin) {
      yield { type: 'error', error: 'Devin CLI (devin) not found on PATH.' };
      return;
    }
    if (!detectDevinCLILogin()) {
      yield {
        type: 'error',
        error: 'Devin CLI is not logged in — run "devin auth login" (or set COGNITION_API_KEY).',
      };
      return;
    }

    // Probe the CLI for its extensibility levers (Phase 0). Awaiting here means
    // the first turn pays the probe cost; subsequent turns use the cache.
    const bridge = new DevinCliBridge();
    const caps = await bridge.ensureCapabilities();
    if (researchOnly && !caps.supportsAgentConfig) {
      yield {
        type: 'error',
        error:
          'Devin native research is unavailable: this CLI does not expose strict tool visibility.',
      };
      return;
    }

    const researchRoot = researchOnly
      ? mkdtempSync(join(tmpdir(), 'kory-web-research-devin-'))
      : null;
    const cwd = researchRoot ?? (request.workingDirectory?.trim() || process.cwd());

    // ── Build the declarative agent config when supported (Phase 1) ──
    // Replaces the HARNESS_SYSTEM_NOTE prompt-body hack: the system prompt +
    // harness note + Kory provenance go into system_instructions, and the
    // SandboxPolicy is translated into permission scopes. The user messages
    // become the prompt body (no system note stuffed in).
    let agentConfigPath: string | null = null;
    let agentConfigArtifact: PrivateCliArtifact | null = null;
    // Set up the per-session isolated devin home (rules/skills/hooks/MCP).
    const devinHome = researchOnly ? null : getKoryphaiosDevinHome(request.sessionId);
    const bridgeGrantLease =
      !researchOnly && request.sessionId
        ? createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager')
        : undefined;
    const bridgeCtx = {
      provider: 'devin' as const,
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: cwd,
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt,
      tools: request.tools ?? [],
      promptManifestHash: request.promptManifestHash,
      taskContractHash: request.taskContractHash,
      bridgeGrantLease,
    };
    const bridgeGrantDirectory =
      !researchOnly && bridgeCtx.sessionId
        ? bridgeGrantLease!.grant(['mcp:catalog', 'mcp:execute']).directory
        : null;
    if (caps.supportsAgentConfig) {
      const agentConfig = bridge.buildAgentConfig(bridgeCtx);
      if (agentConfig) {
        if (researchOnly) {
          agentConfig.systemInstructions = [
            'Perform web research only. Use only the visible native web tools. Do not inspect local files, execute commands, modify state, call MCP tools, or delegate. Return concise findings with full source URLs.',
          ];
          agentConfig.allowedTools = ['WebSearch', 'WebFetch', 'Browser'];
          agentConfig.permissions = {
            allow: [],
            deny: ['Read(**)', 'Write(**)', 'Exec(*)'],
            ask: [],
          };
        }
        agentConfigArtifact = createPrivateCliTextArtifact(
          'devin-agent-config',
          bridge.serializeAgentConfig(agentConfig),
          'json',
        );
        agentConfigPath = agentConfigArtifact.path;
      }
    }

    // ── Wire MCP server (kory__ tools) ───────────────────────────────
    // Write the kory MCP server to the isolated user config so the CLI discovers
    // it on startup and gets access to all kory__ tools.
    const mcpConfigs = researchOnly ? null : bridge.buildMcpConfig(bridgeCtx);
    // Fail closed: a session-scoped non-research turn without the kory MCP
    // server would spawn the CLI with every native tool denied and no kory__
    // tools — the silent "talks but cannot act" failure this must never ship.
    if (!researchOnly && bridgeCtx.sessionId && (!mcpConfigs || mcpConfigs.length === 0)) {
      agentConfigArtifact?.cleanup();
      bridgeGrantLease?.cleanup();
      yield { type: 'error', error: koryBridgeUnavailableError('devin') };
      return;
    }
    if (mcpConfigs && mcpConfigs.length > 0 && devinHome) {
      try {
        bridge.writeMcpConfig(mcpConfigs, devinHome);
      } catch (mcpErr) {
        providerLog.warn({ err: mcpErr }, 'Failed to write kory MCP config for Devin');
        agentConfigArtifact?.cleanup();
        bridgeGrantLease?.cleanup();
        yield {
          type: 'error',
          error:
            'Devin: could not write the kory MCP configuration — refusing to run without tools.',
        };
        return;
      }
    }

    // ── Managed user config (hooks + permissions + subagents) ──────
    // config.json is the only enforcement surface this CLI generation reads:
    // --agent-config does not exist on it. The file carries the signed-grant
    // hooks, the tool-name deny rules, `subagents_enabled: false`, and the
    // cross-tool import kill-switch. Fail-closed like every managed provider:
    // a turn that cannot write its enforcement never spawns ungated.
    const hookConfigs = researchOnly ? null : bridge.buildHooks(bridgeCtx);
    if (devinHome) {
      try {
        bridge.writeManagedUserConfig(bridgeCtx, hookConfigs ?? [], devinHome);
      } catch (configErr) {
        providerLog.warn({ err: configErr }, 'Failed to write managed Devin config');
        agentConfigArtifact?.cleanup();
        bridgeGrantLease?.cleanup();
        yield {
          type: 'error',
          error:
            'Devin: could not write the managed CLI configuration — refusing to run unenforced.',
        };
        return;
      }
    }

    // ── Wire rules (AGENTS.md) ───────────────────────────────────────
    const ruleFiles = researchOnly ? null : bridge.buildRules(bridgeCtx);
    if (ruleFiles) {
      for (const rule of ruleFiles) {
        try {
          writeManagedCliFile(rule.path, rule.content);
        } catch (ruleErr) {
          providerLog.warn({ err: ruleErr }, 'Failed to write rules file for Devin');
        }
      }
    }

    // ── Wire skills (.devin/skills/<name>/SKILL.md) ──────────────────
    const skillFiles = researchOnly ? null : bridge.buildSkills(bridgeCtx);
    if (skillFiles) {
      for (const skill of skillFiles) {
        try {
          writeManagedCliFile(skill.path, skill.content);
        } catch (skillErr) {
          providerLog.warn({ err: skillErr }, 'Failed to write skill file for Devin');
        }
      }
    }

    // The prompt body is the user messages only when agent-config carries the
    // system prompt; otherwise fall back to the legacy buildPrompt (system
    // note + messages in the body).
    const prompt = agentConfigPath
      ? buildPromptBodyOnly(request.messages)
      : buildPrompt(request.systemPrompt, request.messages);
    if (!prompt.trim()) {
      agentConfigArtifact?.cleanup();
      yield { type: 'error', error: 'Devin: empty prompt' };
      return;
    }

    const promptArtifact = createPrivateCliTextArtifact('devin-prompt', prompt);
    const exportArtifact = createPrivateCliTextArtifact('devin-export', '', 'json');
    const exportPath = exportArtifact.path;

    const args: string[] = [
      '-p',
      '--prompt-file',
      promptArtifact.path,
      // Non-interactive: auto-approve so a headless run never blocks. With
      // --agent-config the permission scopes govern; the mode is the coarse
      // fallback. Managed turns run 'dangerous': Kory is the permission
      // authority (config.json deny rules still apply in dangerous mode —
      // Deny > Ask > Allow — so native tools stay denied and mcp__kory__*
      // stays allowed), and any headless prompt would stall the turn since
      // nothing can answer it. Research uses the ordinary auto mode; strict
      // agent-config removes every non-web tool from visibility and denies
      // filesystem/exec. Do not require Devin's optional OS sandbox here: it
      // has extra host dependencies and the exact visibility allowlist is the
      // authority boundary. Devin does not have a "plan" permission-mode value.
      '--permission-mode',
      caps.supportsPermissionMode ? (researchOnly ? 'auto' : 'dangerous') : 'auto',
      ...(!researchOnly && caps.supportsSandbox ? ['--sandbox'] : []),
      '--respect-workspace-trust',
      'false',
      '--export',
      exportPath,
    ];
    if (agentConfigPath) args.push('--agent-config', agentConfigPath);
    // The composer's reasoning level resolves to the concrete effort slug
    // inside the selected family — Devin's --model IS the effort control.
    const cliModel = this.resolveCliModel(
      request.model,
      request.reasoningLevel,
      request.speedTier,
      request.fusion,
    );
    if (cliModel && 'error' in cliModel) {
      yield { type: 'error', error: cliModel.error };
      return;
    }
    if (cliModel) args.push('--model', cliModel.slug);

    const baseEnv = buildProviderCliEnv('devin', {
      ...(devinHome && !researchOnly
        ? {
            DEVIN_CONFIG_DIR: devinHome,
            XDG_CONFIG_HOME: devinHome,
            HOME: devinHome,
            USERPROFILE: devinHome,
          }
        : {}),
    });
    const jail =
      request.sandbox && !researchOnly
        ? buildSoftJail(
            baseEnv,
            [devinHome ?? tmpdir()],
            {
              // The jail replaces HOME and points XDG_DATA_HOME inside it, so
              // `devin auth status` resolved credentials at
              // <jailHome>/.local/share/devin/credentials.toml and reported "Not
              // logged in" on every turn. The configDirs shorthand cannot express
              // this: it links by basename, which would yield <jailHome>/share.
              ...(devinHome ? { '.local/share': join(devinHome, '.local/share') } : {}),
            },
            request.sessionId,
          )
        : null;
    const wrapped =
      request.sandbox && !researchOnly
        ? wrapCommand(bin, args, {
            cwd,
            homeDir: devinHome ?? undefined,
            configDirs: [
              ...(devinHome ? [devinHome] : []),
              ...(bridgeGrantDirectory ? [bridgeGrantDirectory] : []),
              promptArtifact.directory,
              exportArtifact.directory,
              ...(agentConfigArtifact ? [agentConfigArtifact.directory] : []),
            ],
            readonlyConfigDirs: [join(homedir(), '.local', 'share', 'devin', 'credentials.toml')],
            // The CLI child is the inference transport — it must reach the
            // model endpoint. See inferenceSandboxPolicy.
            policy: inferenceSandboxPolicy(request.sandbox),
          })
        : { command: bin, args };
    assertPrivateValuesAbsentFromArgv(wrapped.args, [prompt, request.systemPrompt]);
    // Point the CLI at the isolated per-session home so our rules/skills/hooks
    // and session transcripts stay separate from the user's interactive runs.
    const env = buildDevinProcessEnv(baseEnv, jail?.env, devinHome);
    // Live transcript tail: the CLI persists each step to its sessions.db as
    // it runs. Without this, reasoning, text and tool calls only reached the
    // transcript after process exit — a long turn looked dead the whole time.
    // The ATIF export stays authoritative; live events are deduplicated below.
    // Snapshot before spawn so rows written by earlier turns are skipped.
    const liveTail = devinHome && !researchOnly ? new DevinLiveTail(devinHome) : null;
    liveTail?.snapshot();
    const child = spawnWithPrivateArtifactCleanup(
      () =>
        spawn(wrapped.command, wrapped.args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        }),
      [promptArtifact, agentConfigArtifact],
      () => bridgeGrantLease?.cleanup(),
    );
    bridgeGrantLease?.bindToChild(child);

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Devin CLI child already gone on abort',
        );
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => {
      jail?.cleanup();
      if (researchRoot) rmSync(researchRoot, { recursive: true, force: true });
    });
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'devin' }, 'Devin harness timed out — killing CLI');
      onAbort();
    }, DEVIN_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr = appendPrivateDiagnostic(stderr, c)));

    // Live text from stdout.
    const stdoutQueue: string[] = [];
    child.stdout.on('data', (c: Buffer) => {
      const t = sanitizeDevinOutput(c.toString());
      if (t) stdoutQueue.push(t);
    });

    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    while (true) {
      const settled = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), EXPORT_POLL_MS)),
      ]);
      if (settled.done) {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        if (request.signal?.aborted) {
          exportArtifact.cleanup();
          return;
        }
        if (settled.code === -1) {
          yield { type: 'error', error: 'Devin: failed to launch the devin CLI process.' };
          exportArtifact.cleanup();
          return;
        }
        // Last DB writes can land just after the exit signal — drain once more
        // before reading the export so the tail's coverage is complete.
        if (liveTail) for (const event of liveTail.drainFinal()) yield event;
        const exportEvents = this.readExportEvents(exportPath);
        const remaining = liveTail ? liveTail.dedupeExportEvents(exportEvents) : exportEvents;
        const hasAgentContent =
          exportEvents.some((event) => event.type === 'content_delta' && event.content?.trim()) ||
          liveTail?.emittedAnyContent === true;
        if (settled.code !== 0 && !hasAgentContent) {
          const diagnostic = safeProviderDiagnostic('devin', 'stderr', stderr, {
            exitCode: settled.code,
          });
          providerLog.warn(diagnostic, 'Devin CLI exited unsuccessfully');
          yield {
            type: 'error',
            error: safeProviderFailureMessage('devin', diagnostic, {
              authenticationAction: 'Run "devin auth login", then reconnect.',
            }),
          };
          exportArtifact.cleanup();
          return;
        }
        exportArtifact.cleanup();
        // Live text already shown suppresses the stdout fallback (it would
        // duplicate the same final message); the export's non-dup events
        // (usage, anything the tail missed) still land.
        if (liveTail?.emittedAnyContent) {
          yield* remaining;
        } else {
          yield* selectDevinResponseEvents(stdoutQueue.join(''), remaining);
        }
        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
      if (liveTail) for (const event of liveTail.drain()) yield event;
    }
  }

  private readExportEvents(exportPath: string): ProviderEvent[] {
    if (!existsSync(exportPath)) return [];
    // Use the full ATIF-v1.7 parser from the bridge (Phase 2): it extracts
    // reasoning, tool calls, the real resolved model, tool definitions, and
    // final metrics — superset of the legacy DevinExport parsing.
    let raw: string;
    try {
      raw = readFileSync(exportPath, 'utf-8');
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Devin export file not readable',
      );
      return [];
    }
    const bridge = new DevinCliBridge();
    const { trajectory, events } = bridge.parseTrajectory(raw);
    if (trajectory.modelName) {
      providerLog.debug(
        {
          provider: 'devin',
          resolvedModel: trajectory.modelName,
          schema: trajectory.schemaVersion,
        },
        'Devin ATIF trajectory parsed',
      );
    }
    return events;
  }
}

// Re-export for detection modules that only need the home dir.
export const DEVIN_CREDENTIALS = join(homedir(), '.local', 'share', 'devin', 'credentials.toml');
