// Devin CLI deep-integration bridge.
//
// Implements the CliBridge surface for the `devin` CLI, translating Koryphaios
// orchestration/context/permissions into Devin's extensibility levers:
//   - --agent-config (declarative per-turn config: system_instructions,
//     allowed_tools, permissions, extensions)
//   - --export ATIF trajectory parsing (reasoning + tools + usage + resolved model)
//   - .devin/hooks.v1.json (lifecycle hook bridge — Phase 3)
//   - .devin/config.json mcpServers (MCP tool bridge — Phase 4; agent-config
//     mcp_servers is rejected by the strict parser for stdio, see D3)
//   - AGENTS.md / .devin/skills (rules & skills mirroring — Phase 6)
//
// The legacy stdout + export path in devin.ts stays the fallback when
// --agent-config is unsupported (older Devins).

import type { ProviderName } from '@koryphaios/shared';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  type CliAgentConfig,
  type CliBridge,
  type CliBridgeContext,
  type CliCapabilities,
  type CliHookConfig,
  type CliMcpServerConfig,
  type CliPermissionScopes,
  type CliRuleFile,
  type CliSkillFile,
  type CliTrajectory,
  koryProvenanceExtensions,
  ManagedCliBridge,
  roleToPermissionMode,
  sandboxToScopes,
} from './cli-bridge';
import { koryToolWhitelistForRole } from './cli-bridges';
import { getDevinCapabilitiesAsync, type DevinCapabilities } from './devin-capabilities';
import type { ProviderEvent } from './types';
import { buildKoryCliMcpConfig } from './kory-cli-mcp-config';
import { getKoryBridgeGrant, type BridgeGrantAction } from './bridge-grant';
import { providerLog } from '../logger';
import { createPrivateCliTextArtifact } from './private-cli-transport';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';
import type { SkillRevision } from '../kory/skills';

interface DevinTrajectoryJson {
  schema_version?: string;
  session_id?: string;
  agent?: {
    name?: string;
    version?: string;
    model_name?: string;
    tool_definitions?: Array<{ name?: string } | string>;
  };
  steps?: Array<{
    source?: string;
    message?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
      function_name?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      input?: Record<string, unknown>;
    }>;
    observation?: { results?: Array<{ content?: string }> };
    model_name?: string;
    generation_model?: string;
    extra?: { generation_model?: string; telemetry?: Record<string, unknown> };
    metrics?: Record<string, unknown>;
  }>;
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps?: number;
  };
}

const HARNESS_SYSTEM_NOTE =
  'You are running inside the Koryphaios orchestrator. Koryphaios owns ALL tool execution, ' +
  'permissions, and orchestration. Do NOT use your native built-in tools (read, edit, write, ' +
  'exec, etc.) — they are disabled. Use only the role-scoped kory__ tools listed by the "kory" ' +
  'MCP server. Every kory__ tool call goes through Koryphaios permission + sandbox policy. ' +
  'Never spawn native subagents; delegate through Koryphaios only when your advertised ' +
  'role-scoped tool list contains one; otherwise return the need to the manager.';

export class DevinCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'devin' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'agent-config';

  private cached: DevinCapabilities | null = null;

  async ensureCapabilities(): Promise<DevinCapabilities> {
    this.cached = await getDevinCapabilitiesAsync();
    // Prefer ACP when available and enabled (Phase 5 — not yet wired into the
    // provider; the transport field records the intent).
    this.preferredTransport = this.cached.supportsAgentConfig ? 'agent-config' : 'legacy';
    return this.cached;
  }

  getCapabilities(): CliCapabilities {
    // Synchronous snapshot; the provider should call ensureCapabilities() first.
    const caps = this.cached;
    return {
      binaryPath: caps?.binaryPath ?? '',
      version: caps?.version ?? null,
      supportsAgentConfig: caps?.supportsAgentConfig ?? false,
      supportsSandbox: caps?.supportsSandbox ?? false,
      supportsExport: caps?.supportsExport ?? false,
      supportsPermissionMode: caps?.supportsPermissionMode ?? false,
      supportsAcp: caps?.supportsAcp ?? false,
      supportsMcp: caps?.supportsMcp ?? false,
      supportsRules: caps?.supportsRules ?? false,
      supportsSkills: caps?.supportsSkills ?? false,
      supportsHooks: true, // .devin/hooks.v1.json — present in 3000.3.22
      probedAt: caps?.probedAt ?? 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    const caps = this.cached;
    if (!caps?.supportsAgentConfig) return null;

    const scopes = this.buildPermissionScopes(ctx);
    const systemInstructions: string[] = [];
    if (ctx.systemPrompt?.trim()) {
      systemInstructions.push(`${ctx.systemPrompt.trim()}\n\n${HARNESS_SYSTEM_NOTE}`);
    } else {
      systemInstructions.push(HARNESS_SYSTEM_NOTE);
    }

    // Disable ALL native Devin tools. The CLI should only use kory__ MCP tools
    // exposed via the .devin/config.json mcpServers. We list the kory__ tool
    // names as allowed_tools so Devin's agent-config parser pre-approves them.
    const allowedTools = koryToolWhitelistForRole(ctx.role);

    return {
      systemInstructions,
      allowedTools,
      permissions: scopes,
      extensions: koryProvenanceExtensions(ctx),
    };
  }

  /** Serialize to the strict-parsed JSON the devin CLI expects. Only emits
   *  fields the parser accepts (system_instructions, allowed_tools,
   *  permissions, extensions). mcp_servers is intentionally omitted — the
   *  strict parser rejects every stdio shape (D3); MCP servers go in
   *  .devin/config.json via writeMcpConfig. */
  serializeAgentConfig(config: CliAgentConfig): string {
    const payload: Record<string, unknown> = {
      system_instructions: config.systemInstructions,
      allowed_tools: config.allowedTools,
      permissions: {
        allow: config.permissions.allow,
        deny: config.permissions.deny,
        ask: config.permissions.ask,
      },
      extensions: config.extensions,
    };
    return JSON.stringify(payload, null, 2);
  }

  /** Write the agent config to a temp file and return its path. */
  writeAgentConfigFile(config: CliAgentConfig, sessionId?: string): string {
    return createPrivateCliTextArtifact(
      `devin-agent-config-${sessionId ?? 'anon'}`,
      this.serializeAgentConfig(config),
      'json',
    ).path;
  }

  buildHooks(ctx: CliBridgeContext): CliHookConfig[] | null {
    // Always wire hooks — this is the enforcement layer that blocks native
    // Devin tool calls. The hook script calls the Kory backend which returns
    // block/approve for each tool call.
    if (!this.cached?.supportsHooks) return null;
    const hookScript = process.env.KORY_HOOK_BRIDGE_SCRIPT;
    if (!hookScript) return null;
    if (!ctx.sessionId) return null;
    const events = [
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'UserPromptSubmit',
      'Stop',
    ] as const;
    const actionForEvent: Record<(typeof events)[number], BridgeGrantAction> = {
      PreToolUse: 'hook:pre-tool',
      PostToolUse: 'hook:post-tool',
      PermissionRequest: 'hook:permission',
      UserPromptSubmit: 'hook:prompt-submit',
      Stop: 'hook:stop',
    };
    return events.map((event) => {
      const grant = ctx.bridgeGrantLease
        ? ctx.bridgeGrantLease.grant([actionForEvent[event]])
        : getKoryBridgeGrant(ctx.sessionId!, ctx.role, [actionForEvent[event]]);
      const command = `node ${JSON.stringify(hookScript)} --auth-file ${JSON.stringify(grant.path)} --event ${event}`;
      return { events: [event], command, matcher: '' };
    });
  }

  serializeHooks(hooks: CliHookConfig[]): string {
    // .devin/hooks.v1.json format: { "<Event>": [{ matcher, hooks: [{ type, command }] }] }
    const payload: Record<
      string,
      Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }>
    > = {};
    for (const hook of hooks) {
      for (const event of hook.events) {
        payload[event] = payload[event] ?? [];
        payload[event].push({
          matcher: hook.matcher ?? '',
          hooks: [{ type: 'command', command: hook.command }],
        });
      }
    }
    return JSON.stringify(payload, null, 2);
  }

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // Always configure the kory MCP server — this is how Devin accesses
    // Koryphaios tools instead of its own native tools.
    if (!this.cached?.supportsMcp) return null;
    return buildKoryCliMcpConfig(ctx, 'devin');
  }

  /** Write MCP servers to the per-session .devin/config.json (the shape the
   *  CLI accepts — agent-config mcp_servers is rejected for stdio, see D3). */
  writeMcpConfig(servers: CliMcpServerConfig[], homeDir: string): void {
    if (!servers.length) return;
    const configPath = join(homeDir, '.devin', 'config.json');
    const mcpServers: Record<string, unknown> = {};
    for (const s of servers) {
      mcpServers[s.name] =
        s.transport === 'stdio'
          ? { command: s.command, args: s.args, env: s.env ?? {}, transport: 'stdio' }
          : { url: s.url, transport: s.transport };
    }
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(require('node:fs').readFileSync(configPath, 'utf8'));
      } catch {
        /* overwrite */
        providerLog.debug({}, 'Devin bridge: existing config parse failed — will overwrite');
      }
    }
    existing.mcpServers = {
      ...((existing.mcpServers as Record<string, unknown>) ?? {}),
      ...mcpServers,
    };
    ensureManagedCliDirectory(dirname(configPath));
    writeManagedCliFile(configPath, JSON.stringify(existing, null, 2), { encoding: 'utf8' });
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    if (!this.cached?.supportsRules) return null;
    // Phase 6: mirror Kory's compiled skill instructions as an AGENTS.md in
    // the per-session devin home. The project root AGENTS.md is left to the
    // user (D4).
    const homeDir = getKoryphaiosDevinHome(ctx.sessionId);
    return [
      {
        path: join(homeDir, 'AGENTS.md'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(ctx: CliBridgeContext): CliSkillFile[] | null {
    // Mirror Kory's active skills as .devin/skills/<name>/SKILL.md so the
    // Devin CLI discovers them as agent-invocable skills. Each skill's full
    // instructions are rendered from the Kory skill system.
    if (!this.cached?.supportsSkills) return null;
    try {
      // Lazy import to avoid a circular dependency at module load time.
      const { listSkills } = require('../kory/skills');
      const homeDir = getKoryphaiosDevinHome(ctx.sessionId);
      const skills = listSkills(ctx.workingDirectory).filter((s: SkillRevision) => s.state === 'active');
      return skills.map((skill: SkillRevision) => ({
        path: join(homeDir, '.devin', 'skills', skill.name, 'SKILL.md'),
        // SkillRevision carries `instructions` (rendered full-text) and
        // `content` (raw SKILL.md source). Prefer the rendered instructions;
        // fall back to raw content if instructions are empty.
        content: skill.instructions?.trim() || skill.content || '',
      }));
    } catch (err) {
      providerLog.warn({ err }, 'Devin bridge: failed to mirror Kory skills');
      return null;
    }
  }

  parseTrajectory(raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    let data: DevinTrajectoryJson;
    try {
      data = JSON.parse(raw) as DevinTrajectoryJson;
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Devin bridge: trajectory JSON parse failed',
      );
      return { trajectory: { steps: [] }, events: [] };
    }
    const trajectory: CliTrajectory = {
      schemaVersion: data.schema_version,
      sessionId: data.session_id,
      agentName: data.agent?.name,
      agentVersion: data.agent?.version,
      modelName: data.agent?.model_name,
      toolDefinitions: Array.isArray(data.agent?.tool_definitions)
        ? data.agent.tool_definitions.map((t) => ({
            name: typeof t === 'string' ? t : (t.name ?? String(t)),
          }))
        : [],
      steps: Array.isArray(data.steps)
        ? data.steps.map((s) => ({
            source: s.source ?? '',
            message: typeof s.message === 'string' ? s.message : undefined,
            reasoning: typeof s.reasoning_content === 'string' ? s.reasoning_content : undefined,
            toolCalls: Array.isArray(s.tool_calls)
              ? s.tool_calls.map((c) => ({
                  name: c.function_name ?? c.name ?? 'tool',
                  input: (c.arguments ?? c.input ?? {}) as Record<string, unknown>,
                  output: s.observation?.results?.map((r) => r.content ?? '').join('\n'),
                }))
              : undefined,
            modelName: s.model_name,
            generationModel: s.generation_model ?? s.extra?.generation_model,
            metrics: s.metrics ?? s.extra?.telemetry,
          }))
        : [],
      finalMetrics: data.final_metrics
        ? {
            promptTokens: data.final_metrics.total_prompt_tokens,
            completionTokens: data.final_metrics.total_completion_tokens,
            cachedTokens: data.final_metrics.total_cached_tokens,
            totalSteps: data.final_metrics.total_steps,
          }
        : undefined,
      extensions: data.agent?.extra,
    };
    return { trajectory, events: trajectoryToEvents(trajectory) };
  }
}

/** Convert a parsed ATIF trajectory into Kory ProviderEvents. */
export function trajectoryToEvents(t: CliTrajectory): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const step of t.steps) {
    if (step.source !== 'agent') continue;
    if (step.reasoning?.trim()) {
      events.push({ type: 'thinking_delta', thinking: step.reasoning });
    }
    for (const call of step.toolCalls ?? []) {
      events.push({
        type: 'tool_executed',
        toolName: call.name,
        toolInput: JSON.stringify(call.input),
        toolOutput: (call.output ?? '').slice(0, 8_000),
      });
    }
  }
  const m = t.finalMetrics;
  if (m && (m.promptTokens || m.completionTokens)) {
    events.push({
      type: 'usage_update',
      tokensIn: m.promptTokens ?? 0,
      tokensOut: m.completionTokens ?? 0,
    });
  }
  return events;
}

// ─── Session-isolated Devin home ───────────────────────────────────────────

let cachedDevinHome: string | null = null;

/** A Koryphaios-owned, per-session devin home so our headless runs never
 *  commingle with the user's interactive `devin` sessions. Credentials are
 *  symlinked from the real ~/.local/share/devin so the shared login works;
 *  rules/skills/hooks/config are isolated per session. Mirrors the
 *  getKoryphaiosClaudeConfigDir() pattern. */
export function getKoryphaiosDevinHome(sessionId?: string): string {
  const base = join(homedir(), '.koryphaios', 'devin-home');
  const dir = sessionId ? join(base, sessionId) : base;
  if (cachedDevinHome === dir) return dir;
  try {
    ensureManagedCliDirectory(dir);
    ensureManagedCliDirectory(join(dir, '.devin'));
    // Share credentials with the user's real devin install via a symlink so
    // the subscription login works without re-auth. Isolation is about
    // sessions + rules/skills/hooks, not credentials.
    const realCreds = join(homedir(), '.local', 'share', 'devin', 'credentials.toml');
    const credParent = join(dir, '.local', 'share', 'devin');
    if (existsSync(realCreds)) {
      ensureManagedCliDirectory(credParent);
      const link = join(credParent, 'credentials.toml');
      try {
        if (existsSync(link)) require('node:fs').rmSync(link, { force: true });
        require('node:fs').symlinkSync(realCreds, link);
      } catch {
        /* symlink unsupported/exists — best effort */
        providerLog.debug({}, 'Devin bridge: credentials symlink best-effort failed');
      }
    }
  } catch {
    providerLog.warn({ provider: 'devin' }, 'Could not build private isolated devin home');
    throw new Error('Unable to create a private managed Devin home');
  }
  cachedDevinHome = dir;
  return dir;
}

/** Reset the cached home (e.g. when the session id changes). */
export function resetKoryphaiosDevinHome(): void {
  cachedDevinHome = null;
}

export { roleToPermissionMode };
