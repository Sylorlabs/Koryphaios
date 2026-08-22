// Devin CLI provider — runs Cognition's official `devin` CLI harness.
//
// Like the other subscription CLIs (claude-code, cursor): no API key needed in
// Koryphaios — the locally logged-in `devin` binary authenticates itself.
// Headless `-p` streams the answer text to stdout; the richer trajectory
// (per-step reasoning, tool calls with output, and exact token usage) is
// written to an `--export` JSON file which we tail for tools + usage.
//
// Model list: Devin exposes a fixed set of named models (SWE-1.6,
// Claude, GPT, Gemini, GLM, Kimi families) selected via --model. There is NO
// separate reasoning-effort flag — the tier is part of the model name
// (e.g. swe-1.6-fast / swe-1.6-slow), so we surface models only and never
// show a reasoning picker.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { whichBinary } from './cli-detection';
import { detectDevinCLILogin } from './auth-utils';
import { providerLog } from '../logger';
import { buildSoftJail, wrapCommand } from '../collaboration/sandbox-runner';
import {
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type StreamRequest,
} from './types';
import { DevinCliBridge, getKoryphaiosDevinHome } from './devin-bridge';
import { createKoryBridgeGrantLease } from './bridge-grant';
import {
  getDevinCapabilitiesAsync,
  getDevinCapabilities as getDevinCapabilitiesSync,
} from './devin-capabilities';
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

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Never spawn subagents or delegate to ' +
  'other agents yourself; if work should be parallelized or delegated, say so in your response ' +
  'and Koryphaios will dispatch its own worker agents.';

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
  readonly name = 'devin' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!whichBinary('devin') && detectDevinCLILogin();
  }

  listModels(): ModelDef[] {
    // `devin models` is account-scoped; never synthesize a list before it
    // reports one.
    const caps = getDevinCapabilitiesSync();
    const live: ModelDef[] = caps.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: 'devin' as const,
      apiModelId: m.id,
      contextWindow: m.contextWindow ?? 0,
      contextVerified: typeof m.contextWindow === 'number' && m.contextWindow >= 1024,
      maxOutputTokens: 0,
    }));
    return live;
  }

  async refreshModels(): Promise<void> {
    await getDevinCapabilitiesAsync();
  }

  private resolveCliModel(modelId: string | undefined): string | undefined {
    if (!modelId) return undefined;
    const def = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    return def?.apiModelId ?? modelId.replace(/^devin-/, '');
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
    let devinHome: string | null = null;
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
        // Set up the per-session isolated devin home (rules/skills/hooks/MCP).
        devinHome = getKoryphaiosDevinHome(request.sessionId);

        // ── Wire MCP server (kory__ tools) ───────────────────────────────
        // Write the kory MCP server to .devin/config.json so the CLI discovers
        // it on startup and gets access to all kory__ tools.
        const mcpConfigs = researchOnly ? null : bridge.buildMcpConfig(bridgeCtx);
        if (mcpConfigs && mcpConfigs.length > 0) {
          try {
            bridge.writeMcpConfig(mcpConfigs, devinHome);
          } catch (mcpErr) {
            providerLog.warn({ err: mcpErr }, 'Failed to write kory MCP config for Devin');
          }
        }

        // ── Wire hooks (PreToolUse enforcement layer) ────────────────────
        const hookConfigs = researchOnly ? null : bridge.buildHooks(bridgeCtx);
        if (hookConfigs && hookConfigs.length > 0) {
          try {
            const hooksJson = bridge.serializeHooks(hookConfigs);
            const hooksPath = join(devinHome, '.devin', 'hooks.v1.json');
            writeManagedCliFile(hooksPath, hooksJson);
          } catch (hookErr) {
            providerLog.warn({ err: hookErr }, 'Failed to write hooks config for Devin');
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
      // fallback. Research uses the ordinary auto mode; strict agent-config
      // removes every non-web tool from visibility and denies filesystem/exec.
      // Do not require Devin's optional OS sandbox here: it has extra host
      // dependencies and the exact visibility allowlist is the authority
      // boundary. Devin does not have a "plan" permission-mode value.
      '--permission-mode',
      caps.supportsPermissionMode
        ? researchOnly
          ? 'auto'
          : request.harnessRole === 'critic'
            ? 'normal'
            : 'accept-edits'
        : 'auto',
      ...(!researchOnly && caps.supportsSandbox ? ['--sandbox'] : []),
      ...(researchOnly ? ['--respect-workspace-trust', 'false'] : []),
      '--export',
      exportPath,
    ];
    if (agentConfigPath) args.push('--agent-config', agentConfigPath);
    const cliModel = this.resolveCliModel(request.model);
    if (cliModel) args.push('--model', cliModel);

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
      request.sandbox && !researchOnly ? buildSoftJail(baseEnv, [devinHome ?? tmpdir()]) : null;
    const wrapped =
      request.sandbox && !researchOnly
        ? wrapCommand(bin, args, {
            cwd,
            configDirs: [
              ...(devinHome ? [devinHome] : []),
              ...(bridgeGrantDirectory ? [bridgeGrantDirectory] : []),
              promptArtifact.directory,
              exportArtifact.directory,
              ...(agentConfigArtifact ? [agentConfigArtifact.directory] : []),
            ],
            policy: request.sandbox,
          })
        : { command: bin, args };
    assertPrivateValuesAbsentFromArgv(wrapped.args, [prompt, request.systemPrompt]);
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    // Point the CLI at the isolated per-session home so our rules/skills/hooks
    // and session transcripts stay separate from the user's interactive runs.
    if (devinHome && !researchOnly) {
      env.DEVIN_CONFIG_DIR = devinHome;
      env.XDG_CONFIG_HOME = devinHome;
    }
    const child = spawnWithPrivateArtifactCleanup(
      () =>
        spawn(wrapped.command, wrapped.args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: jail?.env ?? env,
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
      const t = c.toString();
      stdoutQueue.push(t);
    });

    const exitPromise = new Promise<number>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code ?? 0));
    });

    let sawContent = false;
    while (true) {
      const settled = await Promise.race([
        exitPromise.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), EXPORT_POLL_MS)),
      ]);
      while (stdoutQueue.length > 0) {
        const chunk = stdoutQueue.shift()!;
        if (chunk) {
          sawContent = true;
          yield { type: 'content_delta', content: chunk };
        }
      }
      if (settled.done) {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        if (request.signal?.aborted) {
          exportArtifact.cleanup();
          return;
        }
        // Drain any trailing stdout.
        while (stdoutQueue.length > 0) {
          const chunk = stdoutQueue.shift()!;
          if (chunk) {
            sawContent = true;
            yield { type: 'content_delta', content: chunk };
          }
        }
        if (settled.code === -1) {
          yield { type: 'error', error: 'Devin: failed to launch the devin CLI process.' };
          exportArtifact.cleanup();
          return;
        }
        if (settled.code !== 0 && !sawContent) {
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
        // Surface tools + reasoning + usage from the export trajectory.
        yield* this.drainExport(exportPath);
        exportArtifact.cleanup();
        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
    }
  }

  private *drainExport(exportPath: string): Generator<ProviderEvent> {
    if (!existsSync(exportPath)) return;
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
      return;
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
    yield* events;
  }
}

// Re-export for detection modules that only need the home dir.
export const DEVIN_CREDENTIALS = join(homedir(), '.local', 'share', 'devin', 'credentials.toml');
