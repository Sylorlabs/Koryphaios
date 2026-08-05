// CLI deep-integration bridges for every native CLI provider except Devin
// (which has its own devin-bridge.ts). Each bridge translates the common
// CliBridgeContext into its CLI's flag format and implements the levers the
// CLI exposes. Providers that lack a lever return null/empty from the base
// ManagedCliBridge, preserving their existing stdout+export path.
//
// Levers by provider (from probing + subagent analysis):
//   claude-code : --append-system-prompt, --allowedTools, --disallowedTools,
//                 --effort, --permission-mode, CLAUDE_CONFIG_DIR, MCP (.claude.json)
//   codex       : --sandbox, --json, --model, <KORY_TOOL_CALL> envelope, CODEX_HOME
//   cline       : --plan, --auto-approve, --json, --reasoning-effort, --model
//   cursor      : -p, --output-format stream-json, --mode, --sandbox, --force, --model
//   antigravity : --print, --model, --mode, --sandbox, --log-file, --conversation
//   grok        : -p, --model, --output-format, --permission-mode, --no-subagents,
//                 --session-id, --leader-socket, --reasoning-effort
//   kimicode    : OpenAI-compatible API (no subprocess); bridge injects Kory
//                 context into the API system prompt + exposes Kory tools as
//                 function-calling definitions.

import type { ProviderName } from '@koryphaios/shared';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
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
  EMPTY_CLI_CAPABILITIES,
  koryProvenanceExtensions,
  ManagedCliBridge,
  roleToPermissionMode,
  sandboxToScopes,
} from './cli-bridge';
import type { ProviderEvent } from './types';
import { buildKoryCliMcpConfig, getKoryCliBearer } from './kory-cli-mcp-config';

// ─── Shared harness note ───────────────────────────────────────────────────

export const KORY_HARNESS_NOTE =
  'You are running inside the Koryphaios orchestrator. Koryphaios owns ALL tool execution, ' +
  'permissions, and orchestration. Do NOT use your native built-in tools (Read, Edit, Write, ' +
  'Bash, Grep, Glob, etc.) — they are disabled. Instead, use the kory__ MCP tools exposed by ' +
  'the "kory" MCP server (kory__read_file, kory__edit_file, kory__write_file, kory__bash, ' +
  'kory__grep, kory__glob, kory__ls, kory__web_search, kory__web_fetch, kory__get_resource_budget, kory__create_note, ' +
  'kory__search_notes, kory__delegate_to_worker, etc.). Every kory__ tool call goes through ' +
  'Koryphaios permission + sandbox policy. Never spawn subagents or delegate to other agents ' +
  'yourself; use kory__delegate_to_worker and Koryphaios will dispatch its own worker agents.';

export const KORY_HARNESS_NOTE_EXTENDED =
  KORY_HARNESS_NOTE +
  ' Do not start background tasks that require a later notification: complete the requested ' +
  'work in this turn and always finish with a concise user-facing answer.';

// ─── Shared kory tool whitelist ────────────────────────────────────────────
// The full set of kory__ MCP tools every CLI harness gets. Mirrors the catalog
// in kory-mcp-bridge.ts. The critic role is restricted to the read-only subset.

export const KORY_TOOL_WHITELIST: string[] = [
  'kory__read_file',
  'kory__write_file',
  'kory__edit_file',
  'kory__batch_edit',
  'kory__delete_file',
  'kory__move_file',
  'kory__diff',
  'kory__patch',
  'kory__grep',
  'kory__glob',
  'kory__ls',
  'kory__bash',
  'kory__shell_manage',
  'kory__web_search',
  'kory__web_fetch',
  'kory__create_note',
  'kory__read_note',
  'kory__update_note',
  'kory__delete_note',
  'kory__link_notes',
  'kory__unlink_notes',
  'kory__recall_notes',
  'kory__search_notes',
  'kory__list_notes',
  'kory__get_note_backlinks',
  'kory__get_note_graph_summary',
  'kory__render_note',
  'kory__fetch_context',
  'kory__prune_context',
  'kory__ask_user',
  'kory__ask_manager',
  'kory__delegate_to_worker',
  'kory__delegate_to_jules',
  'kory__create_goal',
  'kory__update_goal',
  'kory__list_workflows',
  'kory__start_workflow',
  'kory__update_workflow',
  'kory__create_workflow_draft',
  'kory__get_resource_budget',
  'kory__load_skill_detail',
  'kory__detect_errors',
  'kory__analyze_error',
  'kory__suggest_fixes',
  'kory__git_status',
  'kory__git_diff',
  'kory__git_commit',
  'kory__commit_and_create_pr',
  'kory__view_image',
];

export const KORY_CRITIC_TOOL_WHITELIST: string[] = [
  'kory__read_file',
  'kory__grep',
  'kory__glob',
  'kory__ls',
  'kory__diff',
  'kory__web_search',
  'kory__web_fetch',
  'kory__search_notes',
  'kory__recall_notes',
  'kory__list_notes',
  'kory__read_note',
  'kory__get_note_backlinks',
  'kory__get_note_graph_summary',
  'kory__fetch_context',
  'kory__ask_user',
  'kory__get_resource_budget',
  'kory__load_skill_detail',
  'kory__detect_errors',
  'kory__analyze_error',
  'kory__suggest_fixes',
  'kory__git_status',
  'kory__git_diff',
  'kory__view_image',
];

/** Build the kory MCP server config for a CLI harness. Uses the env vars set
 *  in bootstrap (KORY_MCP_BRIDGE_SCRIPT / KORY_MCP_BRIDGE_COMMAND) so the
 *  bundled bridge script is auto-discovered. */
export function buildKoryMcpServerConfig(
  ctx: CliBridgeContext,
  provider: ProviderName,
): CliMcpServerConfig | null {
  return buildKoryCliMcpConfig(ctx, provider)?.[0] ?? null;
}

/** Build lifecycle hooks for a CLI harness. Uses KORY_HOOK_BRIDGE_SCRIPT. */
export function buildKoryHookConfigs(ctx: CliBridgeContext): CliHookConfig[] | null {
  const hookScript = process.env.KORY_HOOK_BRIDGE_SCRIPT;
  if (!hookScript) return null;
  if (!ctx.sessionId) return null;
  const bearer = getKoryCliBearer(ctx.sessionId, ctx.role);
  const base = `node ${JSON.stringify(hookScript)} --session-id ${JSON.stringify(ctx.sessionId)} --auth ${JSON.stringify(bearer)}`;
  return [
    ...(['PreToolUse', 'PostToolUse', 'UserPromptSubmit'] as const).map((event) => ({
      events: [event],
      command: `${base} --event ${event}`,
      matcher: '',
    })),
    { events: ['Stop'], command: `${base} --event Stop`, matcher: '' },
  ];
}

// ─── Session-isolated homes ────────────────────────────────────────────────

function makeIsolatedHome(dirName: string, realHome: string, symlinkFiles: string[]): string {
  const dir = join(homedir(), '.koryphaios', dirName);
  try {
    mkdirSync(dir, { recursive: true });
    for (const file of symlinkFiles) {
      const src = join(realHome, file);
      const dst = join(dir, file);
      if (!existsSync(src)) continue;
      try {
        if (existsSync(dst) || lstatSync(dst).isSymbolicLink?.()) rmSync(dst, { force: true });
      } catch {
        /* no existing link */
      }
      try {
        symlinkSync(src, dst);
      } catch {
        /* best effort */
      }
    }
  } catch {
    return realHome;
  }
  return dir;
}

export function getKoryphaiosCodexHome(): string {
  return makeIsolatedHome('codex-home', join(homedir(), '.codex'), ['auth.json']);
}

export function getKoryphaiosClineHome(): string {
  return makeIsolatedHome('cline-home', join(homedir(), '.cline'), []);
}

export function getKoryphaiosCursorHome(): string {
  return makeIsolatedHome('cursor-home', join(homedir(), '.cursor'), []);
}

export function getKoryphaiosAntigravityHome(): string {
  return makeIsolatedHome('antigravity-home', join(homedir(), '.antigravity'), []);
}

export function getKoryphaiosGrokHome(): string {
  return makeIsolatedHome('grok-home', join(homedir(), '.grok'), []);
}

// ─── Claude Code bridge ────────────────────────────────────────────────────

export class ClaudeCodeCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'claude' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'agent-config';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      // Claude Code has --append-system-prompt, --allowedTools, --disallowedTools,
      // --effort, --permission-mode, CLAUDE_CONFIG_DIR, and MCP via .claude.json.
      supportsAgentConfig: true, // via --append-system-prompt + --allowedTools
      supportsSandbox: false, // no OS sandbox flag
      supportsExport: true, // stream-json output
      supportsPermissionMode: true,
      supportsAcp: false,
      supportsMcp: true, // .claude.json mcpServers
      supportsRules: true, // CLAUDE.md
      supportsSkills: false, // no skills system
      supportsHooks: true, // .claude/hooks (Claude Code compatible)
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    // Koryphaios owns ALL tool execution. Disable every native Claude Code tool
    // and force the CLI to use kory__ MCP tools instead. The only native tool
    // we keep is TodoWrite (harmless planning aid, no side effects).
    const deny = [
      'Read',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'Glob',
      'Grep',
      'LS',
      'WebFetch',
      'WebSearch',
      'Task',
      'Agent',
    ];
    // Allow only the kory MCP tools + TodoWrite (planning only).
    // Claude Code prefixes MCP tools with mcp__<server>__.
    const allow = [
      ...KORY_TOOL_WHITELIST.map((t) => `mcp__kory__${t.replace(/^kory__/, '')}`),
      'TodoWrite', // planning only, no side effects
    ];
    // Critic role: further restrict to read-only kory tools.
    if (ctx.role === 'critic') {
      const criticAllow = [
        ...KORY_CRITIC_TOOL_WHITELIST.map((t) => `mcp__kory__${t.replace(/^kory__/, '')}`),
        'TodoWrite',
      ];
      return { allow: criticAllow, deny: [...new Set(deny)], ask: [] };
    }
    return { allow, deny: [...new Set(deny)], ask: [] };
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    // Claude Code doesn't have a single --agent-config file; the config is
    // spread across --append-system-prompt, --allowedTools, --disallowedTools.
    // We package them here so the provider can pull them out.
    const scopes = this.buildPermissionScopes(ctx);
    const systemInstructions: string[] = [];
    const note = KORY_HARNESS_NOTE;
    if (ctx.systemPrompt?.trim()) {
      systemInstructions.push(`${ctx.systemPrompt.trim()}\n\n${note}`);
    } else {
      systemInstructions.push(note);
    }
    return {
      systemInstructions,
      allowedTools: scopes.allow,
      permissions: scopes,
      extensions: koryProvenanceExtensions(ctx),
    };
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    // Claude Code has no agent-config file; the provider reads the
    // CliAgentConfig fields directly and maps them to CLI flags.
    return '{}';
  }

  buildHooks(ctx: CliBridgeContext): CliHookConfig[] | null {
    // Always wire hooks — this is the enforcement layer that blocks native
    // tool calls even if the CLI somehow tries to use them. The hook script
    // calls the Kory backend which returns block/approve.
    return buildKoryHookConfigs(ctx);
  }

  serializeHooks(hooks: CliHookConfig[]): string {
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
    // Always configure the kory MCP server — this is how the CLI accesses
    // Koryphaios tools instead of its own native tools.
    const server = buildKoryMcpServerConfig(ctx, 'claude');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    // Claude Code reads CLAUDE.md as always-on rules.
    const home = join(homedir(), '.koryphaios', 'claude-home');
    return [
      {
        path: join(home, 'CLAUDE.md'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null; // Claude Code has no skills system
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    // Claude Code streams NDJSON directly; the provider maps events live.
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Codex bridge ──────────────────────────────────────────────────────────

export class CodexCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'codex' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'agent-config';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false, // no --agent-config flag; uses prompt envelope
      supportsSandbox: true, // --sandbox read-only/workspace-write
      supportsExport: true, // --json JSONL
      supportsPermissionMode: false, // uses --sandbox instead
      supportsAcp: true, // codex app-server --stdio
      supportsMcp: false, // no MCP support yet
      supportsRules: false,
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    // Codex uses --sandbox modes, not scope matchers. The provider maps
    // the role to read-only/workspace-write. We return the scopes for
    // provenance only.
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    // Codex uses the <KORY_TOOL_CALL> envelope in the prompt body, not a
    // config file. We package the system instructions + the kory__ tool
    // whitelist so the provider can build the envelope protocol.
    // The envelope tells Codex to emit kory__ tool calls instead of using
    // its native command_execution tool.
    // This configuration advertises the Kory-owned capability surface. The
    // Codex provider renders the current request's role-filtered, unprefixed
    // ToolRegistry names into its envelope protocol.
    const allowedTools = ctx.role === 'critic' ? KORY_CRITIC_TOOL_WHITELIST : KORY_TOOL_WHITELIST;
    return {
      systemInstructions: [
        ctx.systemPrompt?.trim() ?? '',
        'You are running inside Koryphaios. Native tools are not authority. Use only the host-supplied Kory tool names through the KORY_TOOL_CALL envelope protocol; Koryphaios enforces permissions and executes them.',
      ],
      allowedTools,
      permissions: this.buildPermissionScopes(ctx),
      extensions: koryProvenanceExtensions(ctx),
    };
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null; // Codex has no hooks
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }

  buildMcpConfig(_ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    return null; // Codex has no MCP yet — uses the <KORY_TOOL_CALL> envelope
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    // Codex reads AGENTS.md if present in its working directory / home.
    const home = getKoryphaiosCodexHome();
    return [
      {
        path: join(home, 'AGENTS.md'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null;
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    // Codex streams JSONL directly; the provider maps events live.
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Cline bridge ──────────────────────────────────────────────────────────

export class ClineCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'cline' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false, // no config file; uses --plan + --auto-approve
      supportsSandbox: false,
      supportsExport: true, // --json NDJSON
      supportsPermissionMode: true, // --plan mode
      supportsAcp: false,
      supportsMcp: true, // cline supports MCP servers via cline_mcp_settings.json
      supportsRules: true, // .clinerules
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    // Cline uses --plan (read-only) vs --auto-approve true. No scope matchers.
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(_ctx: CliBridgeContext): CliAgentConfig | null {
    return null; // Cline has no agent-config file
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null; // Cline has no hooks system
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // Cline reads MCP servers from cline_mcp_settings.json in its home dir.
    const server = buildKoryMcpServerConfig(ctx, 'cline');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    // Cline reads .clinerules as always-on rules.
    const home = getKoryphaiosClineHome();
    return [
      {
        path: join(home, '.clinerules'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null;
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Cursor bridge ─────────────────────────────────────────────────────────

export class CursorCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'cursor' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: true, // --sandbox enabled
      supportsExport: true, // --output-format stream-json
      supportsPermissionMode: true, // --mode ask/agent
      supportsAcp: false,
      supportsMcp: true, // cursor-agent supports MCP servers
      supportsRules: true, // .cursorrules
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(_ctx: CliBridgeContext): CliAgentConfig | null {
    return null;
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null;
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // Always configure the kory MCP server for Cursor.
    const server = buildKoryMcpServerConfig(ctx, 'cursor');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    // Cursor reads .cursorrules as always-on rules.
    const home = getKoryphaiosCursorHome();
    return [
      {
        path: join(home, '.cursorrules'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null;
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Antigravity bridge ────────────────────────────────────────────────────

export class AntigravityCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'antigravity' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: true, // --sandbox
      supportsExport: true, // --log-file SSE + SQLite trajectory
      supportsPermissionMode: true, // --mode plan/accept-edits
      supportsAcp: false,
      supportsMcp: true, // imports .claude/ config (mcpServers)
      supportsRules: true, // AGENTS.md (imports from .claude/)
      supportsSkills: true, // .claude/ skills (imported)
      supportsHooks: true, // .claude/ hooks (imported)
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(_ctx: CliBridgeContext): CliAgentConfig | null {
    return null;
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildHooks(ctx: CliBridgeContext): CliHookConfig[] | null {
    // Antigravity imports .claude/hooks — same format as Claude Code.
    // Always wire hooks to block native tool calls.
    return buildKoryHookConfigs(ctx);
  }

  serializeHooks(hooks: CliHookConfig[]): string {
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
    // Antigravity imports .claude/ config — configure kory MCP server there.
    const server = buildKoryMcpServerConfig(ctx, 'antigravity');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    const home = getKoryphaiosAntigravityHome();
    return [
      {
        path: join(home, 'AGENTS.md'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    // Phase 6: mirror Kory skills as .claude/skills/ — pending skill extraction.
    return null;
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Grok bridge ───────────────────────────────────────────────────────────

export class GrokCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'grok' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: false,
      supportsExport: true, // --output-format streaming-json
      supportsPermissionMode: true, // --permission-mode plan / --always-approve
      supportsAcp: false,
      supportsMcp: true, // grok CLI supports MCP servers via config
      supportsRules: true, // .grokrules
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(_ctx: CliBridgeContext): CliAgentConfig | null {
    return null;
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null; // Grok CLI has no hooks system
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // Grok CLI supports MCP servers — configure the kory server.
    const server = buildKoryMcpServerConfig(ctx, 'grok');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    // Grok reads .grokrules as always-on rules.
    const home = getKoryphaiosGrokHome();
    return [
      {
        path: join(home, '.grokrules'),
        content: `# Koryphaios Session Rules\n\n${ctx.systemPrompt.trim()}\n`,
      },
    ];
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null;
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── KimiCode bridge (API-based, no subprocess) ────────────────────────────

export class KimiCodeCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'kimicode' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      // KimiCode is API-based (extends OpenAIProvider). No CLI subprocess, so
      // no agent-config/sandbox/export/permission-mode/acp/rules/skills/hooks.
      // The bridge injects Kory context into the API system prompt and exposes
      // Kory tools as function-calling definitions.
      supportsMcp: false, // uses native function calling instead
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    // For API providers, the "agent config" is the system prompt + tool defs
    // sent in the API request. Package them so the provider can inject.
    const allowedTools = ctx.role === 'critic' ? KORY_CRITIC_TOOL_WHITELIST : KORY_TOOL_WHITELIST;
    return {
      systemInstructions: [ctx.systemPrompt?.trim() ?? '', KORY_HARNESS_NOTE].filter(Boolean),
      allowedTools,
      permissions: this.buildPermissionScopes(ctx),
      extensions: koryProvenanceExtensions(ctx),
    };
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null;
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }

  buildMcpConfig(_ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    return null;
  }

  buildRules(_ctx: CliBridgeContext): CliRuleFile[] | null {
    return null;
  }

  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null;
  }

  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Bridge registry ───────────────────────────────────────────────────────

const bridgeRegistry = new Map<ProviderName, CliBridge>();

export function getCliBridge(provider: ProviderName): CliBridge | null {
  const cached = bridgeRegistry.get(provider);
  if (cached) return cached;
  let bridge: CliBridge | null = null;
  switch (provider) {
    case 'devin':
      // Devin has its own bridge module with async capability probing.
      // Imported lazily to avoid a circular dependency.
      return null; // use DevinCliBridge directly from devin-bridge.ts
    case 'claude':
      bridge = new ClaudeCodeCliBridge();
      break;
    case 'codex':
      bridge = new CodexCliBridge();
      break;
    case 'cline':
      bridge = new ClineCliBridge();
      break;
    case 'cursor':
      bridge = new CursorCliBridge();
      break;
    case 'antigravity':
      bridge = new AntigravityCliBridge();
      break;
    case 'grok':
      bridge = new GrokCliBridge();
      break;
    case 'kimicode':
      bridge = new KimiCodeCliBridge();
      break;
    default:
      return null;
  }
  bridgeRegistry.set(provider, bridge);
  return bridge;
}

export { roleToPermissionMode };
