// Devin CLI provider — runs Cognition's official `devin` CLI harness.
//
// Like the other subscription CLIs (claude-code, cursor): no API key needed in
// Koryphaios — the locally logged-in `devin` binary authenticates itself.
// Headless `-p` streams the answer text to stdout; the richer trajectory
// (per-step reasoning, tool calls with output, and exact token usage) is
// written to an `--export` JSON file which we tail for tools + usage.
//
// Model list + reasoning: Devin exposes a fixed set of named models (SWE-1.6,
// Claude, GPT, Gemini, GLM, Kimi families) selected via --model. There is NO
// separate reasoning-effort flag — the tier is part of the model name
// (e.g. swe-1.6-fast / swe-1.6-slow), so we surface models only.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
import { DevinCliBridge, getKoryphaiosDevinHome, resolveDevinReasoningModel } from './devin-bridge';
import { getDevinCapabilitiesAsync, getDevinCapabilities as getDevinCapabilitiesSync } from './devin-capabilities';

const DEVIN_STREAM_TIMEOUT_MS = 300_000;
const EXPORT_POLL_MS = 250;

// Verified live from `devin -p "hi" --model <bad>` → "Available: …".
const DEVIN_MODELS: Array<{ id: string; name: string; ctx?: number }> = [
  { id: 'swe-1.6', name: 'SWE-1.6' },
  { id: 'swe-1.6-fast', name: 'SWE-1.6 Fast' },
  { id: 'swe-1.6-slow', name: 'SWE-1.6 Slow' },
  { id: 'swe-1.5', name: 'SWE-1.5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', ctx: 1_000_000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', ctx: 200_000 },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', ctx: 1_000_000 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', ctx: 200_000 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', ctx: 1_000_000 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', ctx: 200_000 },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.2', name: 'GPT-5.2' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', ctx: 1_000_000 },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'kimi-k2.7', name: 'Kimi K2.7' },
];

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
    // Prefer the live account-available models from `devin models` (Phase 0
    // capability probe), falling back to the static DEVIN_MODELS table when
    // the probe hasn't settled or the CLI doesn't report a catalog.
    const caps = getDevinCapabilitiesSync();
    const live: ModelDef[] = caps.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: 'devin' as const,
      apiModelId: m.id,
      contextWindow: m.contextWindow ?? 200_000,
      maxOutputTokens: 64_000,
    }));
    const seen = new Set(live.map((m) => m.id));
    const fallback: ModelDef[] = DEVIN_MODELS.filter((m) => !seen.has(m.id)).map((m) => ({
      id: m.id,
      name: m.name,
      provider: 'devin' as const,
      apiModelId: m.id,
      contextWindow: m.ctx ?? 200_000,
      maxOutputTokens: 64_000,
    }));
    return [...live, ...fallback];
  }

  private resolveCliModel(modelId: string | undefined): string | undefined {
    if (!modelId) return undefined;
    const def = this.listModels().find((m) => m.id === modelId || m.apiModelId === modelId);
    return def?.apiModelId ?? modelId.replace(/^devin-/, '');
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
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

    const exportPath = join(tmpdir(), `devin-${Date.now()}-${Math.round(performance.now())}.json`);
    const cwd = request.workingDirectory?.trim() || process.cwd();

    // ── Build the declarative agent config when supported (Phase 1) ──
    // Replaces the HARNESS_SYSTEM_NOTE prompt-body hack: the system prompt +
    // harness note + Kory provenance go into system_instructions, and the
    // SandboxPolicy is translated into permission scopes. The user messages
    // become the prompt body (no system note stuffed in).
    let agentConfigPath: string | null = null;
    let devinHome: string | null = null;
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
    };
    if (caps.supportsAgentConfig) {
      const agentConfig = bridge.buildAgentConfig(bridgeCtx);
      if (agentConfig) {
        agentConfigPath = bridge.writeAgentConfigFile(agentConfig, request.sessionId);
        // Set up the per-session isolated devin home (rules/skills/hooks/MCP).
        devinHome = getKoryphaiosDevinHome(request.sessionId);

        // ── Wire MCP server (kory__ tools) ───────────────────────────────
        // Write the kory MCP server to .devin/config.json so the CLI discovers
        // it on startup and gets access to all kory__ tools.
        const mcpConfigs = bridge.buildMcpConfig(bridgeCtx);
        if (mcpConfigs && mcpConfigs.length > 0) {
          try {
            bridge.writeMcpConfig(mcpConfigs, devinHome);
          } catch (mcpErr) {
            providerLog.warn({ err: mcpErr }, 'Failed to write kory MCP config for Devin');
          }
        }

        // ── Wire hooks (PreToolUse enforcement layer) ────────────────────
        const hookConfigs = bridge.buildHooks(bridgeCtx);
        if (hookConfigs && hookConfigs.length > 0) {
          try {
            const hooksJson = bridge.serializeHooks(hookConfigs);
            const hooksPath = join(devinHome, '.devin', 'hooks.v1.json');
            mkdirSync(dirname(hooksPath), { recursive: true });
            writeFileSync(hooksPath, hooksJson);
          } catch (hookErr) {
            providerLog.warn({ err: hookErr }, 'Failed to write hooks config for Devin');
          }
        }

        // ── Wire rules (AGENTS.md) ───────────────────────────────────────
        const ruleFiles = bridge.buildRules(bridgeCtx);
        if (ruleFiles) {
          for (const rule of ruleFiles) {
            try {
              mkdirSync(dirname(rule.path), { recursive: true });
              writeFileSync(rule.path, rule.content);
            } catch (ruleErr) {
              providerLog.warn({ err: ruleErr }, 'Failed to write rules file for Devin');
            }
          }
        }

        // ── Wire skills (.devin/skills/<name>/SKILL.md) ──────────────────
        const skillFiles = bridge.buildSkills(bridgeCtx);
        if (skillFiles) {
          for (const skill of skillFiles) {
            try {
              mkdirSync(dirname(skill.path), { recursive: true });
              writeFileSync(skill.path, skill.content);
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
      yield { type: 'error', error: 'Devin: empty prompt' };
      return;
    }

    const args: string[] = [
      '-p',
      prompt,
      // Non-interactive: auto-approve so a headless run never blocks. With
      // --agent-config the permission scopes govern; the mode is the coarse
      // fallback. Critic → plan (read-only); manager/worker → accept-edits.
      '--permission-mode',
      caps.supportsPermissionMode
        ? (request.harnessRole === 'critic' ? 'plan' : 'accept-edits')
        : (request.harnessRole === 'critic' ? 'auto' : 'dangerous'),
      ...(request.harnessRole === 'critic' && caps.supportsSandbox ? ['--sandbox'] : []),
      '--export',
      exportPath,
    ];
    if (agentConfigPath) args.push('--agent-config', agentConfigPath);
    const cliModel = this.resolveCliModel(
      resolveDevinReasoningModel(request.model, request.reasoningLevel),
    );
    if (cliModel) args.push('--model', cliModel);

    const jail = request.sandbox ? buildSoftJail(process.env, [join(homedir(), '.devin')]) : null;
    const wrapped = request.sandbox
      ? wrapCommand(bin, args, { cwd, policy: request.sandbox })
      : { command: bin, args };
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Point the CLI at the isolated per-session home so our rules/skills/hooks
    // and session transcripts stay separate from the user's interactive runs.
    if (devinHome) {
      env.DEVIN_CONFIG_DIR = devinHome;
      env.XDG_CONFIG_HOME = devinHome;
    }
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: jail?.env ?? env,
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => jail?.cleanup());
    const timeout = setTimeout(() => {
      providerLog.warn({ provider: 'devin' }, 'Devin harness timed out — killing CLI');
      onAbort();
    }, DEVIN_STREAM_TIMEOUT_MS);
    timeout.unref?.();

    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    // Live text from stdout.
    const stdoutQueue: string[] = [];
    let fullStdout = '';
    child.stdout.on('data', (c: Buffer) => {
      const t = c.toString();
      fullStdout += t;
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
          this.cleanup(exportPath);
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
          this.cleanup(exportPath);
          return;
        }
        if (settled.code !== 0 && !sawContent) {
          const hint = stderr.trim() || `devin exited with status ${settled.code}`;
          const loginHint = /not.*logged in|unauthorized|login|authenticate|api key/i.test(hint)
            ? ' — run "devin auth login".'
            : '';
          yield { type: 'error', error: `Devin: ${hint.slice(0, 300)}${loginHint}` };
          this.cleanup(exportPath);
          return;
        }
        // Surface tools + reasoning + usage from the export trajectory.
        yield* this.drainExport(exportPath);
        yield { type: 'complete', finishReason: 'end_turn' };
        this.cleanup(exportPath);
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
    } catch {
      return;
    }
    const bridge = new DevinCliBridge();
    const { trajectory, events } = bridge.parseTrajectory(raw);
    if (trajectory.modelName) {
      providerLog.debug(
        { provider: 'devin', resolvedModel: trajectory.modelName, schema: trajectory.schemaVersion },
        'Devin ATIF trajectory parsed',
      );
    }
    yield* events;
  }

  private cleanup(exportPath: string): void {
    try {
      if (existsSync(exportPath)) unlinkSync(exportPath);
    } catch {
      /* best-effort */
    }
  }
}

// Re-export for detection modules that only need the home dir.
export const DEVIN_CREDENTIALS = join(homedir(), '.local', 'share', 'devin', 'credentials.toml');
