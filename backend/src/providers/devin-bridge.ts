// Devin CLI deep-integration bridge.
//
// Implements the CliBridge surface for the `devin` CLI, translating Koryphaios
// orchestration/context/permissions into Devin's extensibility levers:
//   - --agent-config (declarative per-turn config: system_instructions,
//     allowed_tools, permissions, extensions)
//   - --export ATIF trajectory parsing (reasoning + tools + usage + resolved model)
//   - XDG devin/config.json hooks (lifecycle hook bridge — Phase 3)
//   - XDG devin/mcp_config.json (MCP tool bridge — Phase 4; agent-config
//     mcp_servers is rejected by the strict parser for stdio, see D3)
//   - XDG devin/AGENTS.md and devin/skills (rules & skills mirroring — Phase 6)
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
import { koryToolWhitelistForContext, KORY_CUSTOM_MCP_NOTE } from './cli-bridges';
import { getDevinCapabilitiesAsync, type DevinCapabilities } from './devin-capabilities';
import type { ProviderEvent } from './types';
import { buildKoryCliMcpConfig } from './kory-cli-mcp-config';
import { getKoryBridgeGrant, type BridgeGrantAction } from './bridge-grant';
import { providerLog } from '../logger';
import { createPrivateCliTextArtifact } from './private-cli-transport';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';
import type { SkillRevision } from '../kory/skills';
import { recordedToolIdentity, recordedToolInput, recordedToolName } from './recorded-tool';

/** Total char budget for Devin-bridge skill manifests (minimal entries + spillover note). */
const DEVIN_SKILL_MANIFEST_BUDGET = 15_000;

interface DevinTrajectoryJson {
  schema_version?: string;
  session_id?: string;
  agent?: {
    name?: string;
    version?: string;
    model_name?: string;
    tool_definitions?: Array<{ name?: string } | string>;
    extra?: Record<string, unknown>;
  };
  steps?: Array<{
    source?: string;
    message?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
      tool_call_id?: string;
      id?: string;
      function_name?: string;
      name?: string;
      function?: { name?: string; arguments?: Record<string, unknown> | string };
      arguments?: Record<string, unknown> | string;
      input?: Record<string, unknown>;
    }>;
    observation?: { results?: Array<{ source_call_id?: string; tool_call_id?: string; content?: string; isError?: boolean; is_error?: boolean }> };
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
      supportsHooks: true, // <DEVIN_CONFIG_DIR>/devin/config.json `hooks` — verified live
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
    const allowedTools = koryToolWhitelistForContext(ctx);

    return {
      systemInstructions: [...systemInstructions, KORY_CUSTOM_MCP_NOTE],
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
    // UserPromptSubmit is intentionally absent: a fail-closed hook that drops
    // the prompt kills the whole headless turn silently, and the bridge's
    // context-injection channel is unused on this vocabulary. Keep the events
    // that gate tool calls and turn lifecycle instead.
    const events = [
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
    ] as const;
    const actionForEvent: Record<(typeof events)[number], BridgeGrantAction> = {
      PreToolUse: 'hook:pre-tool',
      PostToolUse: 'hook:post-tool',
      PermissionRequest: 'hook:permission',
      Stop: 'hook:stop',
    };
    // Spawn through the bridge runtime: a packaged .js bundle targets bun, and
    // bare `node` cannot run the source .ts either — the hook would error and
    // silently drop the enforcement layer.
    const hookCommand =
      process.env.KORY_HOOK_BRIDGE_COMMAND ||
      process.env.KORY_MCP_BRIDGE_COMMAND ||
      process.execPath;
    // The hook is spawned by the CLI, not the backend — pass the backend URL
    // explicitly so a non-default-port backend is reachable instead of falling
    // back to the 127.0.0.1:3001 default and failing closed on every call.
    const backendUrl =
      process.env.KORY_BACKEND_URL?.trim() ||
      `http://${process.env.KORYPHAIOS_HOST ?? '127.0.0.1'}:${process.env.KORYPHAIOS_PORT ?? '3001'}`;
    return events.map((event) => {
      const grant = ctx.bridgeGrantLease
        ? ctx.bridgeGrantLease.grant([actionForEvent[event]])
        : getKoryBridgeGrant(ctx.sessionId!, ctx.role, [actionForEvent[event]]);
      const command = `${JSON.stringify(hookCommand)} ${JSON.stringify(hookScript)} --auth-file ${JSON.stringify(grant.path)} --backend-url ${JSON.stringify(backendUrl)} --event ${event} --provider devin`;
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
    // Koryphaios tools instead of its own native tools. The mcp_config.json
    // discovery contract does not depend on the `devin mcp` management
    // subcommand the supportsMcp probe checks for; gating on it could leave a
    // managed turn with every native tool denied and no kory__ tools.
    return buildKoryCliMcpConfig(ctx, 'devin');
  }

  /** Write MCP servers to the isolated XDG user config used by the child. */
  writeMcpConfig(servers: CliMcpServerConfig[], homeDir: string): void {
    if (!servers.length) return;
    const configPath = join(getDevinUserConfigDir(homeDir), 'mcp_config.json');
    const mcpServers: Record<string, unknown> = {};
    for (const s of servers) {
      mcpServers[s.name] =
        s.transport === 'stdio'
          ? { command: s.command, args: s.args, env: s.env ?? {} }
          : { url: s.url, transport: s.transport };
    }
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(require('node:fs').readFileSync(configPath, 'utf8'));
      } catch {
        /* overwrite */
        providerLog.debug({}, 'Devin bridge: existing MCP config parse failed — will overwrite');
      }
    }
    existing.mcpServers = {
      ...((existing.mcpServers as Record<string, unknown>) ?? {}),
      ...mcpServers,
    };
    ensureManagedCliDirectory(dirname(configPath));
    writeManagedCliFile(configPath, JSON.stringify(existing, null, 2), { encoding: 'utf8' });
  }

  /** Bare tool names denied via Devin's documented tool-name permission
   *  grammar (`"deny": ["edit", "exec"]`). The authoritative list published by
   *  the CLI is short (`read`, `edit`, `grep`, `glob`, `exec`); unknown names
   *  are inert, so the full observed native surface goes in — the signed hook
   *  bridge is the second layer that default-denies anything the config
   *  grammar did not catch. kory__ MCP calls are unaffected: they are
   *  `mcp__kory__*` names, not these names. */
  private static readonly NATIVE_TOOL_DENIES = [
    'read',
    'write',
    'edit',
    'exec',
    'grep',
    'glob',
    'find_file_by_name',
    'webfetch',
    'web_fetch',
    'web_search',
    'read_page_content',
    'apply_patch',
    'patch',
    'notebook_read',
    'notebook_edit',
    'request_scope',
    'run_subagent',
    'read_subagent',
    'task',
    'spawn',
    'browser_preview',
    'get_output',
    'kill_shell',
    'write_to_process',
    'mcp_call_tool',
    'ask_user_question',
  ];

  writeHooksConfig(hooks: CliHookConfig[], homeDir: string): void {
    if (!hooks.length) return;
    this.writeManagedUserConfig(null, hooks, homeDir);
  }

  /** Write the managed user config at `<home>/devin/config.json` — the file
   *  the CLI honours at `DEVIN_CONFIG_DIR` (verified: `devin doctor` resolves
   *  it, hook events fire, deny rules block). Besides the signed-grant hooks,
   *  this lays down the declarative enforcement the missing `--agent-config`
   *  flag cannot carry:
   *    - `permissions`: allow `mcp__kory__*` only, deny the authority-bearing
   *      native tools plus the sandbox-derived scopes, keep `ask` entries
   *    - `subagents_enabled: false` — removes run_subagent/read_subagent
   *      entirely rather than merely denying them
   *    - `read_config_from` — disables every cross-tool import that could add
   *      MCP servers or rules the managed turn never asked for; the project's
   *      own AGENTS.md stays (`agents_standard`)
   *    - `auto_update`/`notify` — headless hygiene so a managed turn never
   *      mutates the install or rings the user's terminal
   *  A stale `hooks` block from an earlier session is removed when no hooks
   *  are supplied: its grant files are gone, so keeping it would only jam the
   *  turn on fail-closed hook errors. */
  writeManagedUserConfig(
    ctx: CliBridgeContext | null,
    hooks: CliHookConfig[],
    homeDir: string,
  ): void {
    const configPath = join(getDevinUserConfigDir(homeDir), 'config.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(require('node:fs').readFileSync(configPath, 'utf8'));
      } catch {
        /* overwrite */
        providerLog.debug({}, 'Devin bridge: existing user config parse failed — will overwrite');
      }
    }
    if (hooks.length > 0) {
      existing.hooks = JSON.parse(this.serializeHooks(hooks));
    } else {
      delete existing.hooks;
    }
    const scopes = ctx ? this.buildPermissionScopes(ctx) : { allow: [], deny: [], ask: [] };
    existing.permissions = {
      allow: [...new Set(['mcp__kory__*', ...scopes.allow])],
      deny: [...new Set([...DevinCliBridge.NATIVE_TOOL_DENIES, ...scopes.deny])],
      ask: scopes.ask,
    };
    existing.subagents_enabled = false;
    existing.auto_update = false;
    existing.notify = 'never';
    existing.read_config_from = {
      // The workspace's own AGENTS.md is the repo's contract — still honored.
      agents_standard: true,
      // Everything else imports foreign rules/skills/MCP servers (claude,
      // cursor, windsurf, opencode, zed, cloud plugins). A managed turn must
      // only see the kory server and the mirrored manifests.
      cursor: false,
      windsurf: false,
      claude: false,
      copilot: false,
      codex: false,
      kiro: false,
      opencode: false,
      zed: false,
      cloud: false,
    };
    ensureManagedCliDirectory(dirname(configPath));
    writeManagedCliFile(configPath, JSON.stringify(existing, null, 2), { encoding: 'utf8' });
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    if (!this.cached?.supportsRules) return null;
    // Phase 6: mirror Kory's compiled skill instructions as an AGENTS.md in
    // the per-session devin home. The project root AGENTS.md is left to the
    // user (D4).
    const configDir = getDevinUserConfigDir(getKoryphaiosDevinHome(ctx.sessionId));
    return [
      {
        path: join(configDir, 'AGENTS.md'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt?.trim() ?? ''}\n`,
      },
    ];
  }

  buildSkills(ctx: CliBridgeContext): CliSkillFile[] | null {
    // Mirror Kory's active skills as .devin/skills/<name>/SKILL.md so the
    // Devin CLI discovers them as agent-invocable skills. Full-text mirroring
    // (~1.1M chars for a large personal library) is deliberately NOT done
    // here: each file carries only a minimal manifest (name/version/description
    // plus a load_skill_detail pointer, same progressive-disclosure contract as
    // the kory-mcp-bridge), capped at a fixed char budget with spillover names
    // listed in a single overflow note.
    if (!this.cached?.supportsSkills) return null;
    try {
      // Lazy import to avoid a circular dependency at module load time.
      const { listSkills } = require('../kory/skills');
      const configDir = getDevinUserConfigDir(getKoryphaiosDevinHome(ctx.sessionId));
      const skills = listSkills(ctx.workingDirectory)
        .filter((s: SkillRevision) => s.state === 'active')
        .sort((a: SkillRevision, b: SkillRevision) => a.name.localeCompare(b.name));
      const files: CliSkillFile[] = [];
      const spilled: string[] = [];
      let spent = 0;
      for (const skill of skills as SkillRevision[]) {
        const description = (skill.description ?? '').trim().slice(0, 240);
        const content = [
          `# ${skill.name} (v${skill.metadata.version}, ${skill.source})`,
          '',
          description,
          '',
          'Full instructions are NOT embedded here. Load them on demand with the kory__load_skill_detail tool (same contract as the Kory MCP bridge), e.g. {"name": "' +
            skill.name +
            '"} — then follow the returned guidance.',
          '',
        ].join('\n');
        if (spent + content.length > DEVIN_SKILL_MANIFEST_BUDGET) {
          spilled.push(skill.name);
          continue;
        }
        spent += content.length;
        files.push({
          path: join(configDir, 'skills', skill.name, 'SKILL.md'),
          content,
        });
      }
      if (spilled.length > 0) {
        files.push({
          path: join(configDir, 'skills', 'KORY_SKILLS_SPILLOVER.md'),
          content: [
            `# More Kory skills (${spilled.length} omitted by the ${DEVIN_SKILL_MANIFEST_BUDGET}-char bridge budget)`,
            '',
            ...spilled.map((name) => `- ${name}`),
            '',
            'Load any of them on demand with the kory__load_skill_detail tool.',
            '',
          ].join('\n'),
        });
      }
      return files;
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
    const resultsByCall = new Map(
      (data.steps ?? []).flatMap((step) => step.observation?.results ?? [])
        .flatMap((result) => {
          const id = result.source_call_id ?? result.tool_call_id;
          return id ? [[id, result] as const] : [];
        }),
    );
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
              ? s.tool_calls.map((c) => {
                  const id = c.tool_call_id ?? c.id;
                  const single = s.tool_calls?.length === 1 && s.observation?.results?.length === 1
                    ? s.observation.results[0] : undefined;
                  const result = (id ? resultsByCall.get(id) : undefined)
                    ?? (single && !single.source_call_id && !single.tool_call_id ? single : undefined);
                  const tool = recordedToolIdentity(
                    recordedToolName(c as Record<string, unknown>),
                    recordedToolInput(c.arguments ?? c.input ?? c.function?.arguments),
                  );
                  return {
                    id, name: tool.name ?? '', input: tool.input, output: result?.content,
                    isError: result?.isError === true || result?.is_error === true,
                  };
                })
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
        toolCallId: call.id,
        toolName: call.name || undefined,
        toolInput: JSON.stringify(call.input),
        toolOutput: (call.output ?? '').slice(0, 8_000),
        isError: call.isError === true,
      });
    }
    if (step.message?.trim()) {
      events.push({ type: 'content_delta', content: step.message });
    }
  }
  // ATIF step metrics are per model request: `prompt_tokens` is that request's
  // whole input (cached_tokens is a subset of it). `final_metrics` totals are
  // summed over every step of the exported session (a measured ATIF-v1.7
  // export: total_prompt_tokens 14,466,544 is exactly the sum of its 135 agent
  // steps' prompt_tokens; the last step was 154,111), so they are billing
  // evidence only. The latest agent step is the live occupancy.
  const latest = latestStepUsage(t.steps);
  if (latest) {
    events.push({
      type: 'usage_update',
      tokensIn: latest.promptTokens,
      tokensOut: latest.completionTokens,
      ...(latest.cachedTokens !== undefined ? { tokensCacheRead: latest.cachedTokens } : {}),
    });
  }
  const m = t.finalMetrics;
  if (m && (m.promptTokens || m.completionTokens)) {
    events.push({
      type: 'usage_update',
      tokensIn: m.promptTokens ?? 0,
      tokensOut: m.completionTokens ?? 0,
      tokensCacheRead: m.cachedTokens,
      // Cumulative over every request: never occupancy. Without a per-step
      // snapshot above, the meter shows it as an estimate and bounds it.
      estimated: true,
      billingTokensIn: m.promptTokens ?? 0,
      billingTokensOut: m.completionTokens ?? 0,
    });
  }
  return events;
}

function numericMetric(metrics: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metrics?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The last agent step that reported its own request usage. */
function latestStepUsage(
  steps: CliTrajectory['steps'],
): { promptTokens: number; completionTokens: number; cachedTokens?: number } | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.source !== 'agent') continue;
    const promptTokens = numericMetric(step.metrics, 'prompt_tokens');
    if (promptTokens === undefined || promptTokens <= 0) continue;
    return {
      promptTokens,
      completionTokens: numericMetric(step.metrics, 'completion_tokens') ?? 0,
      cachedTokens: numericMetric(step.metrics, 'cached_tokens'),
    };
  }
  return undefined;
}

// ─── Session-isolated Devin home ───────────────────────────────────────────

let cachedDevinHome: string | null = null;

export function getDevinUserConfigDir(homeDir: string): string {
  return join(homeDir, 'devin');
}

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
