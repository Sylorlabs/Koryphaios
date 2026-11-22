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
//   cursor      : -p, --output-format stream-json, --mode, --sandbox, --force, --model
//   antigravity : --input-format stream-json, --model, --sandbox, --log-file,
//                 --conversation, --add-dir. Permissions are enforced through
//                 settings.json (permissions + toolPermission), not --mode, which
//                 agy ignores headlessly. Hooks: ~/.gemini/config/hooks.json.
//   grok        : -p, --model, --output-format, --permission-mode, --no-subagents,
//                 --session-id, --leader-socket, --reasoning-effort
//   kimicode    : OpenAI-compatible API (no subprocess); bridge injects Kory
//                 context into the API system prompt + exposes Kory tools as
//                 function-calling definitions.

import type { ProviderName } from '@koryphaios/shared';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { serverLog } from '../logger';
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
import { buildKoryCliMcpConfig } from './kory-cli-mcp-config';
import { getKoryBridgeGrant, type BridgeGrantAction } from './bridge-grant';
import { KORY_TOOLS, toolsForRole } from './kory-mcp-bridge';
import { ensureManagedCliDirectory } from './managed-cli-storage';
import { credentialLinkCandidates } from './cli-config-paths';
import { currentProviderExecutionScope } from './execution-scope';
import { getSafeSubprocessEnv } from '../runtime/safe-env';

// ─── Shared harness note ─────────────────────────────────────────────────────

export const KORY_HARNESS_NOTE =
  'You are running inside the Koryphaios orchestrator. Koryphaios owns ALL tool execution, ' +
  'permissions, and orchestration. Do NOT use your native built-in tools (Read, Edit, Write, ' +
  'Bash, Grep, Glob, etc.) — they are disabled. Use only the role-scoped kory__ tools listed ' +
  'by the "kory" MCP server. Every kory__ tool call goes through Koryphaios permission + ' +
  'sandbox policy. Never spawn native subagents; delegate through Koryphaios only when ' +
  'your advertised role-scoped tool list contains one; otherwise return the need to the manager. ' +
  'To ask the user a question, call kory__ask_user when your tool list has it (workers: ' +
  'kory__ask_manager); never use a native question tool. ' +
  'For custom MCP servers, discover exact schemas with kory__list_mcp_tools and invoke them ' +
  'with kory__invoke_mcp_tool if your CLI tool list has not refreshed.';
export const KORY_CUSTOM_MCP_NOTE =
  'Discover custom MCP tools with kory__list_mcp_tools. If your CLI tool list is stale, ' +
  'invoke newly added tools with kory__invoke_mcp_tool using the discovered server_name, tool_name and arguments.';

export const KORY_HARNESS_NOTE_EXTENDED =
  KORY_HARNESS_NOTE +
  ' Do not start background tasks that require a later notification: complete the requested ' +
  'work in this turn and always finish with a concise user-facing answer.';

export const KORY_DIRECT_TOOL_HARNESS_NOTE =
  'You are running inside the Koryphaios orchestrator. Koryphaios owns ALL tool execution, ' +
  'permissions, and orchestration. Use only the exact role-scoped tool names supplied with this ' +
  'request; do not invent kory__ aliases or use unsupplied native tools. Never spawn or delegate ' +
  'to native subagents; use a supplied Koryphaios delegation tool only when your role exposes it.';

// ─── Legacy Codebuff SDK harness note ───────────────────────────────────────
// Retained while the old adapter is still present for migration tests. The
// active Freebuff provider is freebuff-cli.ts and uses the real TUI + MCP.
export const FREEBUFF_HARNESS_NOTE =
  'You are running inside the Koryphaios orchestrator via the Codebuff SDK. ' +
  'Koryphaios owns ALL filesystem and command tool execution — your native ' +
  'tools (write_file, str_replace, apply_patch, run_terminal_command, ' +
  'list_directory, glob, code_search, read_files) are intercepted and routed ' +
  "through Koryphaios's permission, sandbox, and approval system. Use them " +
  'normally; they will be gated automatically. Your native web tools ' +
  '(web_search, read_url) remain available for research. Never spawn ' +
  'subagents or delegate to other agents yourself; ask the user to delegate ' +
  'via Koryphaios if you need a worker agent.';

export const FREEBUFF_PTY_HARNESS_NOTE =
  'You are the real Freebuff CLI running inside a Koryphaios-owned disposable transport ' +
  'workspace. The project-local "kory" MCP server exposes the authoritative, role-scoped ' +
  'Koryphaios tools. Use those kory MCP tools for every read, search, edit, command, note, ' +
  "or orchestration action that should affect the user's actual Koryphaios session. Your " +
  'native Freebuff tools still exist, but they can see and modify only this disposable ' +
  'workspace and are not authority for the real project. Never claim a native-only action ' +
  "changed the user's project. Finish the requested work in this turn and return a concise " +
  'user-facing answer. ' +
  KORY_CUSTOM_MCP_NOTE;

// ─── Shared kory tool whitelist ──────────────────────────────────────────────
// Derive provider allowlists from the bridge catalog instead of maintaining a
// second copy that can drift from MCP ListTools role filtering.
export const KORY_MANAGER_TOOL_WHITELIST = toolsForRole('manager').map((tool) => tool.name);
export const KORY_WORKER_TOOL_WHITELIST = toolsForRole('worker').map((tool) => tool.name);
export const KORY_CRITIC_TOOL_WHITELIST = toolsForRole('critic').map((tool) => tool.name);
export const KORY_CODER_TOOL_WHITELIST = toolsForRole('coder').map((tool) => tool.name);

/** Backwards-compatible name for the manager/full catalog. */
export const KORY_TOOL_WHITELIST = KORY_MANAGER_TOOL_WHITELIST;

export function koryToolWhitelistForRole(role: string): string[] {
  if (role === 'manager') return KORY_MANAGER_TOOL_WHITELIST;
  if (role === 'worker') return KORY_WORKER_TOOL_WHITELIST;
  if (role === 'critic') return KORY_CRITIC_TOOL_WHITELIST;
  if (role === 'coder') return KORY_CODER_TOOL_WHITELIST;
  return [];
}

/** Normalize a tool name from a provider or MCP catalog to Kory's namespace. */
export function normalizeKoryToolName(name: string): string {
  let toolName = name.trim();
  while (toolName.startsWith('kory__') || toolName.startsWith('mcp__kory__')) {
    toolName = toolName.startsWith('mcp__kory__')
      ? toolName.slice('mcp__kory__'.length)
      : toolName.slice('kory__'.length);
  }
  return `kory__${toolName}`;
}

const CRITIC_BRIDGE_EXCLUDED_TOOLS = new Set(['bash', 'edit_file', 'delegate_to_worker']);

/** Provider requests carry the authoritative project/role-filtered catalog. */
export function koryToolWhitelistForContext(ctx: CliBridgeContext): string[] {
  if (!['manager', 'worker', 'coder', 'critic'].includes(ctx.role)) return [];
  const tools = ctx.tools.length
    ? ctx.tools.map((tool) => normalizeKoryToolName(tool.name))
    : koryToolWhitelistForRole(ctx.role);
  return [...new Set(tools)]
    .filter(
      (tool) =>
        ctx.role !== 'critic' || !CRITIC_BRIDGE_EXCLUDED_TOOLS.has(tool.slice('kory__'.length)),
    )
    .sort();
}

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
  const events = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const;
  const actionForEvent: Record<(typeof events)[number], BridgeGrantAction> = {
    PreToolUse: 'hook:pre-tool',
    PostToolUse: 'hook:post-tool',
    UserPromptSubmit: 'hook:prompt-submit',
    Stop: 'hook:stop',
  };
  // The hook is spawned by the CLI, not the backend — always pass the backend
  // URL explicitly so a non-default-port backend stays reachable.
  const backendUrl =
    process.env.KORY_BACKEND_URL?.trim() ||
    `http://${process.env.KORYPHAIOS_HOST ?? '127.0.0.1'}:${process.env.KORYPHAIOS_PORT ?? '3001'}`;
  const backendFlag = ` --backend-url ${JSON.stringify(backendUrl)}`;
  // Same runtime rule as the MCP bridge: bare `node` cannot run the source .ts
  // or the bun-targeted packaged .js, so the hook silently no-ops.
  const hookCommand =
    process.env.KORY_HOOK_BRIDGE_COMMAND ||
    process.env.KORY_MCP_BRIDGE_COMMAND ||
    process.execPath;
  return events.map((event) => {
    const grant = ctx.bridgeGrantLease
      ? ctx.bridgeGrantLease.grant([actionForEvent[event]])
      : getKoryBridgeGrant(ctx.sessionId!, ctx.role, [actionForEvent[event]]);
    const command = `${JSON.stringify(hookCommand)} ${JSON.stringify(hookScript)} --auth-file ${JSON.stringify(grant.path)}${backendFlag} --event ${event} --provider claude`;
    return { events: [event], command, matcher: '' };
  });
}

// ─── Session-isolated homes ──────────────────────────────────────────────────

function makeIsolatedHome(dirName: string, realHome: string, symlinkFiles: string[]): string {
  const dir = join(homedir(), '.koryphaios', dirName);
  try {
    ensureManagedCliDirectory(dir);
    for (const file of symlinkFiles) {
      const src = join(realHome, file);
      const dst = join(dir, file);
      if (!existsSync(src)) continue;
      try {
        if (existsSync(dst) || lstatSync(dst).isSymbolicLink?.()) rmSync(dst, { force: true });
      } catch {
        serverLog.debug({}, 'cli-bridges: no existing link to remove');
      }
      try {
        symlinkSync(src, dst);
      } catch {
        serverLog.debug({}, 'cli-bridges: symlink best-effort failed');
      }
    }
  } catch {
    serverLog.warn({}, 'cli-bridges: private isolated home creation failed');
    throw new Error('Unable to create a private managed CLI home');
  }
  return dir;
}

export function getKoryphaiosCodexHome(profileDir = join(homedir(), '.codex')): string {
  const defaultHome = join(homedir(), '.codex');
  const dirName =
    profileDir === defaultHome
      ? 'codex-home'
      : `codex-home-${basename(profileDir).replace(/[^a-z0-9._-]/gi, '-')}`;
  return makeIsolatedHome(dirName, profileDir, ['auth.json']);
}

export function getKoryphaiosCursorHome(): string {
  return makeIsolatedHome('cursor-home', join(homedir(), '.cursor'), []);
}

/**
 * Credential files agy may keep inside `$GEMINI_DIR`, relative to that root.
 * Discovered by probing instead of hardcoded to one name: the CLI has shipped
 * the OAuth token as `antigravity-cli/antigravity-oauth-token`, while older
 * builds used top-level `oauth_creds.json` / `google_accounts.json`. Linking a
 * name that does not exist is a silent no-op, so a stale list leaves the staged
 * home unauthenticated and every turn drops into the browser OAuth flow.
 */
const ANTIGRAVITY_CREDENTIAL_FILES = [
  'antigravity-cli/antigravity-oauth-token',
  'oauth_creds.json',
  'google_accounts.json',
] as const;

/** True when a portable OAuth record is staged in the managed home.
 *
 *  agy answers a missing credential with its browser sign-in flow, and
 *  Koryphaios probes this provider from status renders and the catalog
 *  scheduler. This predicate is what keeps a passive probe from launching a
 *  login window: no staged credential means nothing to discover.
 */
export function hasAntigravityPortableLogin(
  home: string = getKoryphaiosAntigravityHome(),
): boolean {
  return ANTIGRAVITY_CREDENTIAL_FILES.some((file) => existsSync(join(home, '.gemini', file)));
}

/** Environment for a passive agy probe.
 *
 *  HOME and GEMINI_DIR point at the managed home so agy reads the staged
 *  portable login. Inheriting the host HOME instead lets agy resolve the user's
 *  login keychain, which is what produced macOS consent prompts from a routine
 *  status poll and from the billing quota scan.
 */
export function antigravityProbeEnv(
  home: string = getKoryphaiosAntigravityHome(),
): NodeJS.ProcessEnv {
  return {
    ...getSafeSubprocessEnv(),
    HOME: home,
    USERPROFILE: home,
    ANTIGRAVITY_HOME: home,
    GEMINI_DIR: join(home, '.gemini'),
  };
}

export function getKoryphaiosAntigravityHome(subscope?: string): string {
  const staged = currentProviderExecutionScope()?.antigravityHome;
  const safeSubscope = subscope?.trim().replace(/[^a-z0-9._-]/gi, '-') || '';
  if (staged && !safeSubscope) return staged;
  const baseDir =
    staged ?? makeIsolatedHome('antigravity-home', join(homedir(), '.antigravity'), []);
  const dir = safeSubscope ? join(baseDir, safeSubscope) : baseDir;
  // agy authenticates via ~/.gemini OAuth material, but the child runs with
  // HOME/ANTIGRAVITY_HOME pointed at this isolated dir. Link the credentials
  // in so the jailed child signs in as the user (read-only by convention —
  // agy only reads these). The sandbox mounts the real ~/.gemini read-only so
  // the links resolve inside the jail too.
  try {
    ensureManagedCliDirectory(dir);
    const geminiDir = staged ? join(staged, '.gemini') : join(homedir(), '.gemini');
    const isolatedGemini = join(dir, '.gemini');
    ensureManagedCliDirectory(isolatedGemini);
    for (const file of ANTIGRAVITY_CREDENTIAL_FILES) {
      const src = join(geminiDir, file);
      const dst = join(isolatedGemini, file);
      if (!existsSync(src)) continue;
      ensureManagedCliDirectory(join(isolatedGemini, dirname(file)));
      if (existsSync(dst) || lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink()) {
        rmSync(dst, { force: true });
      }
      try {
        symlinkSync(src, dst);
      } catch {
        serverLog.debug({}, 'cli-bridges: antigravity credential link best-effort failed');
      }
    }
  } catch {
    /* best-effort; detection reports login state separately */
  }
  return dir;
}

/**
 * Symlink credential files into an isolated home at every plausible resolution
 * point (root and nested dot-directory), skipping any that already exist.
 *
 * Best-effort by design: a CLI that cannot see its login degrades to its own
 * sign-in prompt, which is a visible failure rather than a silent one.
 */
function linkCredentialCandidates(
  realConfigDir: string,
  homeDir: string,
  dotDir: string,
  files: readonly string[],
): void {
  for (const { source, target } of credentialLinkCandidates(
    realConfigDir,
    homeDir,
    dotDir,
    files,
  )) {
    if (!existsSync(source)) continue;
    try {
      if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
        rmSync(target, { force: true });
      }
    } catch {
      serverLog.debug({}, 'cli-bridges: no existing link to remove');
    }
    try {
      ensureManagedCliDirectory(dirname(target));
      symlinkSync(source, target);
    } catch {
      serverLog.debug({}, 'cli-bridges: credential link best-effort failed');
    }
  }
}

export function getKoryphaiosGrokHome(): string {
  // Grok stores its login outside the environment. Keep the child isolated for
  // sessions/configuration, but make the CLI-owned auth and model cache visible
  // to it. Without this, Koryphaios can detect a working terminal login and
  // then launch a child that quite correctly says "sign in" because it has an
  // empty HOME.
  //
  // Linked at the root AND under `.grok/`: whether the CLI resolves these
  // against GROK_HOME or against a ~/.grok directory inside it is unmeasured,
  // because the grok CLI is not installed on the authoring host. The root link
  // alone left the child unauthenticated if the dot-directory is what it reads,
  // which is the exact failure this comment describes.
  const dir = makeIsolatedHome('grok-home', join(homedir(), '.grok'), [
    'auth.json',
    'models_cache.json',
  ]);
  linkCredentialCandidates(join(homedir(), '.grok'), dir, '.grok', [
    'auth.json',
    'models_cache.json',
  ]);
  return dir;
}

/**
 * Stage Omnirush's CLI-owned state without copying its bearer token. The CLI
 * refreshes its own auth.json in place, so the auth file is linked rather than
 * read by Koryphaios or placed in process arguments.
 */
export function getKoryphaiosOmnirushHome(): string {
  const source = process.env.OMNIRUSH_DIR?.trim() || join(homedir(), '.omnirush');
  const dir = makeIsolatedHome('omnirush-home', source, ['auth.json']);
  // Keep the agent directory Kory-owned and disposable. The launcher installs
  // its extension/model metadata there; linking the user's real agent folder
  // would let a Kory turn mutate unrelated Omnirush state. Only auth.json is
  // linked above, because the CLI remains the sole credential authority.
  return dir;
}

/**
 * Private CodeBuddy configuration/transcripts. codebuddy-environment.ts stages
 * the exact HOME-relative CLI auth file separately; settings are not credentials.
 */
export function getKoryphaiosCodeBuddyHome(): string {
  return makeIsolatedHome('codebuddy-home', join(homedir(), '.codebuddy'), []);
}

// ─── CodeBuddy bridge ────────────────────────────────────────────────────────

export class CodeBuddyCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'codebuddy' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: true, // --system-prompt-file + tool flags
      supportsSandbox: false, // Kory wraps the child when a sandbox is requested
      supportsExport: true, // --output-format stream-json (Claude Code envelope shapes)
      supportsPermissionMode: true, // --permission-mode acceptEdits|plan
      supportsAcp: false,
      supportsMcp: true, // user-scope ~/.codebuddy/.codebuddy.json mcpServers
      supportsRules: false,
      supportsSkills: false,
      supportsHooks: false, // unverified against a live codebuddy turn
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    return {
      systemInstructions: [ctx.systemPrompt?.trim() ?? '', KORY_HARNESS_NOTE_EXTENDED].filter(
        Boolean,
      ),
      allowedTools: koryToolWhitelistForContext(ctx),
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

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // CodeBuddy reads user-scope MCP servers from ~/.codebuddy/.codebuddy.json.
    const server = buildKoryMcpServerConfig(ctx, 'codebuddy');
    return server ? [server] : null;
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

// ─── WorkBuddy Desktop bridge ───────────────────────────────────────────────

/**
 * The WorkBuddy AI desktop app's host runtime (`codebuddy --serve` inside the
 * app bundle) speaks ACP over HTTP SSE and loads MCP servers from a
 * `--mcp-config` file — the same CLI config surface the CodeBuddy bridge
 * targets, reached through the desktop app's own runtime instead of the
 * standalone CLI on PATH. Koryphaios injects the kory MCP server through
 * that config file; the harness note (delivered as the session's system
 * instructions over ACP) steers the runtime to the kory__ tools.
 */
export class WorkBuddyDesktopCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'workbuddy-desktop' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'acp';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: true, // ACP initialize + session/new system instructions
      supportsSandbox: false, // the runtime's own product sandbox policy confines commands
      supportsExport: false,
      supportsPermissionMode: true, // ACP session/set_mode (default / acceptEdits / read-only)
      supportsAcp: true, // ACP over HTTP SSE at /api/v1/acp
      supportsMcp: true, // --mcp-config + --strict-mcp-config
      supportsRules: false,
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    return {
      systemInstructions: [ctx.systemPrompt?.trim() ?? '', KORY_HARNESS_NOTE_EXTENDED].filter(
        Boolean,
      ),
      allowedTools: koryToolWhitelistForContext(ctx),
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

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // The desktop runtime loads MCP servers from the --mcp-config file the
    // provider writes per turn (mcpServers shape, same as the desktop app's
    // own agent CLI MCP config).
    const server = buildKoryMcpServerConfig(ctx, 'workbuddy-desktop');
    return server ? [server] : null;
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

// ─── Claude Code bridge ──────────────────────────────────────────────────────

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
      supportsHooks: true, // settings.json `hooks` key, supplied per turn via --settings
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
      'AskUserQuestion',
    ];
    // Allow only the kory MCP tools + TodoWrite (planning only).
    // Claude Code prefixes MCP tools with mcp__<server>__.
    const allow = [
      ...koryToolWhitelistForContext(ctx).map(
        (tool) => `mcp__kory__${tool.slice('kory__'.length)}`,
      ),
      // Only the host-owned bridge; backend role/project/policy checks own
      // authority, including tools registered during this same CLI turn.
      ...(ctx.role === 'critic' ? [] : ['mcp__kory__*']),
      'TodoWrite', // planning only, no side effects
    ];
    return { allow, deny: [...new Set(deny)], ask: [] };
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    // Claude Code doesn't have a single --agent-config file; the config is
    // spread across --append-system-prompt, --allowedTools, --disallowedTools.
    // We package them here so the provider can pull them out.
    const scopes = this.buildPermissionScopes(ctx);
    const systemInstructions: string[] = [];
    const note = `${KORY_HARNESS_NOTE} ${KORY_CUSTOM_MCP_NOTE}`;
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

// ─── Codex bridge ────────────────────────────────────────────────────────────

function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    } else out += ch;
  }
  return `${out}"`;
}

function sanitizeTomlKey(name: string): string | null {
  const key = name.trim();
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : null;
}

/**
 * Serialize MCP servers to a Codex `kory.config.toml` profile (layered via
 * `codex --profile kory`, so the base config.toml is never rewritten).
 * stdio transport only — the kory bridge is stdio. Throws on anything else
 * so a half-understood server can never silently turn into a broken one.
 */
export function serializeCodexMcpProfile(servers: CliMcpServerConfig[]): string {
  const lines = [
    '# Managed by Koryphaios: per-turn kory MCP servers for Codex.',
    '# Rewritten every turn with a fresh session-scoped grant; do not edit.',
  ];
  for (const srv of servers) {
    const key = sanitizeTomlKey(srv.name);
    if (!key) {
      throw new Error(`Codex MCP profile: unsupported server name ${JSON.stringify(srv.name)}`);
    }
    if (srv.transport !== 'stdio') {
      throw new Error(
        `Codex MCP profile: transport ${srv.transport} is not supported (stdio only)`,
      );
    }
    lines.push(`[mcp_servers.${key}]`);
    lines.push(`command = ${tomlBasicString(srv.command)}`);
    lines.push(`args = [${srv.args.map((a) => tomlBasicString(a)).join(', ')}]`);
    // Bun cold-starts the TypeScript bridge; give it room beyond codex's default.
    lines.push('startup_timeout_sec = 30');
    const env = srv.env ?? {};
    if (Object.keys(env).length > 0) {
      lines.push(`[mcp_servers.${key}.env]`);
      for (const [name, value] of Object.entries(env)) {
        const envKey = sanitizeTomlKey(name);
        if (!envKey) {
          throw new Error(`Codex MCP profile: unsupported env name ${JSON.stringify(name)}`);
        }
        lines.push(`${envKey} = ${tomlBasicString(value)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

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
      // codex exec spawns `mcp_servers` from config (verified live against
      // `codex mcp list` + per-turn server startup). The kory MCP server is
      // mounted via a per-turn `kory.config.toml` profile; the envelope
      // protocol stays as the fallback for servers that fail to start.
      supportsMcp: true,
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
    // Codex prefers the kory MCP server (mounted via the per-turn kory
    // profile) and falls back to the <KORY_TOOL_CALL> envelope in the prompt
    // body when MCP is unavailable. We package the system instructions + the
    // kory__ tool whitelist so the provider can build both transports.
    // This configuration advertises the Kory-owned capability surface. The
    // Codex provider renders the current request's role-filtered, unprefixed
    // ToolRegistry names into its envelope protocol.
    const allowedTools = koryToolWhitelistForContext(ctx);
    return {
      systemInstructions: [
        ctx.systemPrompt?.trim() ?? '',
        'You are running inside Koryphaios. Native tools are not authority. Prefer the host-supplied kory MCP tools for every read, edit, search, and command; if the kory MCP server is unavailable, emit Kory tool calls through the KORY_TOOL_CALL envelope protocol instead. Koryphaios enforces permissions and executes them.',
        KORY_CUSTOM_MCP_NOTE,
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

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // The kory MCP server is mounted through a per-turn `kory.config.toml`
    // profile (see serializeCodexMcpProfile). The envelope protocol stays as
    // the fallback when no session-scoped grant can be issued.
    const server = buildKoryMcpServerConfig(ctx, 'codex');
    return server ? [server] : null;
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

// ─── Cursor bridge ───────────────────────────────────────────────────────────

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

// ─── Antigravity bridge ──────────────────────────────────────────────────────

export class AntigravityCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'antigravity' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: true, // --sandbox, plus enableTerminalSandbox
      supportsExport: true, // --log-file SSE + SQLite trajectory
      // Permission posture is enforced through agy's own engine
      // (settings.json permissions + toolPermission), NOT via --mode: agy
      // ignores --mode in print/stream-json mode. See
      // antigravity-permissions.ts.
      supportsPermissionMode: true,
      supportsAcp: false,
      supportsMcp: true, // $GEMINI_DIR/config/mcp_config.json; agy exposes call_mcp_tool
      supportsRules: true, // AGENTS.md
      supportsSkills: true,
      // agy reads hooks from ~/.gemini/config/hooks.json or
      // <workspace>/.agents/hooks.json — not .claude/. Its schema and decision
      // vocabulary also differ, so hooks are written directly by the adapter
      // via antigravity-permissions.ts rather than through this abstraction.
      supportsHooks: true,
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
    // Deliberately null. `CliHookConfig` encodes Claude Code's shape — event
    // names as top-level keys and approve/block decisions — which agy does not
    // accept: it keys hooks by *name*, matches tools by regex, and only parses
    // allow/deny/ask/force_ask. Emitting the Claude shape produced a hooks.json
    // agy silently ignored, so the native-tool gate never ran. The adapter
    // writes the real format through buildAntigravityHooks().
    return null;
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
    // Antigravity's provider writes this to $GEMINI_DIR/config/mcp_config.json.
    const server = buildKoryMcpServerConfig(ctx, 'antigravity');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    const subscope = ctx.role && ctx.role !== 'manager' ? ctx.role : undefined;
    const home = getKoryphaiosAntigravityHome(subscope);
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

// ─── Grok bridge ─────────────────────────────────────────────────────────────

export class GrokCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'grok' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: false,
      supportsExport: true, // --output-format streaming-json
       supportsPermissionMode: true, // --permission-mode and --always-approve
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

// ─── OpenCode bridge ─────────────────────────────────────────────────────────

export class OpenCodeCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'opencode' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'acp';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: true, // the ACP child can run under the OS jail
      supportsExport: true, // ACP session/prompt receipts
      supportsPermissionMode: true, // ACP plan mode + per-request permission veto
      supportsAcp: true,
      supportsMcp: true, // session/new mcpServers (stdio)
      supportsRules: false, // system prompt travels inside the ACP prompt
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    const allowedTools = koryToolWhitelistForContext(ctx);
    return {
      systemInstructions: [
        ctx.systemPrompt?.trim() ?? '',
        `${KORY_HARNESS_NOTE} ${KORY_CUSTOM_MCP_NOTE}`,
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
    // OpenCode's hook mechanism is its plugin API; per-session tool gating is
    // enforced here by answering session/request_permission instead.
    return null;
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // The kory server is passed per ACP session (session/new.mcpServers), never
    // written into the user's OpenCode configuration.
    const server = buildKoryMcpServerConfig(ctx, 'opencode');
    return server ? [server] : null;
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

// ─── Omnirush bridge ─────────────────────────────────────────────────────────

export class OmnirushCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'omnirush' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'agent-config';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: true, // --append-system-prompt + tool flags
      supportsSandbox: false, // Kory wraps the child when a sandbox is requested
      supportsExport: false,
      supportsPermissionMode: true, // --yolo is available; Kory never enables it
      supportsAcp: false,
      // Omnirush 2.x hard-denies MCP in its managed OpenCode engine. Kory tools
      // are exposed through the provider's per-turn custom-tool plugin instead.
      supportsMcp: false,
      supportsRules: false,
      supportsSkills: true,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig {
    return {
      systemInstructions: [ctx.systemPrompt?.trim() ?? '', KORY_HARNESS_NOTE_EXTENDED].filter(
        Boolean,
      ),
      allowedTools: koryToolWhitelistForContext(ctx),
      permissions: this.buildPermissionScopes(ctx),
      extensions: koryProvenanceExtensions(ctx),
    };
  }

  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }

  buildMcpConfig(_ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    // Omnirush 2.x strips MCP before OpenCode loads project configuration.
    // The provider owns its custom-tool plugin transport instead.
    return null;
  }

  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null;
  }

  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
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

// ─── KimiCode bridge (API-based, no subprocess) ─────────────────────────────

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
    const allowedTools = ctx.tools.map((tool) => tool.name);
    return {
      systemInstructions: [ctx.systemPrompt?.trim() ?? '', KORY_DIRECT_TOOL_HARNESS_NOTE].filter(
        Boolean,
      ),
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

// ─── Freebuff (real TUI + project-local MCP) bridge ─────────────────────────

export class FreebuffCliBridge extends ManagedCliBridge implements CliBridge {
  readonly provider: ProviderName = 'freebuff' as const;
  preferredTransport: 'acp' | 'agent-config' | 'legacy' = 'legacy';

  getCapabilities(): CliCapabilities {
    return {
      ...EMPTY_CLI_CAPABILITIES,
      supportsAgentConfig: false,
      supportsSandbox: true,
      supportsExport: true,
      supportsPermissionMode: false,
      supportsAcp: false,
      supportsMcp: true,
      supportsRules: true,
      supportsSkills: false,
      supportsHooks: false,
      version: null,
      probedAt: 0,
    };
  }

  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes {
    return sandboxToScopes(ctx.sandbox, ctx.role);
  }

  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null {
    const allowedTools = koryToolWhitelistForContext(ctx);
    return {
      systemInstructions: [ctx.systemPrompt?.trim() ?? '', FREEBUFF_PTY_HARNESS_NOTE].filter(
        Boolean,
      ),
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

  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    const server = buildKoryMcpServerConfig(ctx, 'freebuff');
    return server ? [server] : null;
  }

  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null {
    return [
      {
        path: 'knowledge.md',
        content: `# Koryphaios managed Freebuff session\n\n${ctx.systemPrompt.trim()}\n\n${FREEBUFF_PTY_HARNESS_NOTE}\n`,
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

// ─── Bridge registry ─────────────────────────────────────────────────────────

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
    case 'cursor':
      bridge = new CursorCliBridge();
      break;
    case 'antigravity':
      bridge = new AntigravityCliBridge();
      break;
    case 'grok':
      bridge = new GrokCliBridge();
      break;
    case 'codebuddy':
      bridge = new CodeBuddyCliBridge();
      break;
    case 'workbuddy-desktop':
      bridge = new WorkBuddyDesktopCliBridge();
      break;
    case 'omnirush':
      bridge = new OmnirushCliBridge();
      break;
    case 'kimicode':
      bridge = new KimiCodeCliBridge();
      break;
    case 'freebuff':
      bridge = new FreebuffCliBridge();
      break;
    case 'opencode':
      bridge = new OpenCodeCliBridge();
      break;
    default:
      return null;
  }
  bridgeRegistry.set(provider, bridge);
  return bridge;
}

/**
 * The kory MCP server identity for a CLI-harness session: every managed CLI
 * bridge injects the kory MCP server (the kory__* tool surface) into its
 * turns. Derived from the bridge's own capability declaration — providers
 * without an MCP lever (plain API providers, CLI harnesses that cannot load
 * MCP) surface nothing. Used by the session context endpoint so the
 * injected tools are visible (icons, labels) in the feed, not merely usable.
 */
export function koryMcpServerIdentity(
  provider: ProviderName,
): { name: string; tools: string[] } | null {
  const bridge = getCliBridge(provider);
  if (!bridge?.getCapabilities().supportsMcp) return null;
  return { name: 'kory', tools: KORY_TOOLS.map((tool) => tool.name) };
}

export { roleToPermissionMode };
