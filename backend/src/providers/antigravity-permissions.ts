/**
 * Koryphaios's control plane over the Antigravity CLI (`agy`) tool surface.
 *
 * `agy` owns a real, declarative permission engine. Every sensitive operation
 * is a resource `action(target)` evaluated across three lists in priority order
 * **Deny > Ask > Allow**, with the `toolPermission` preset supplying the
 * fallback for anything unconfigured. Verified against agy 1.2.16 (a staged
 * home's `settings.json` is read and honored; `agy -p "/permissions"` reports
 * the resulting rules under the `global` scope):
 *
 *   - `~/.gemini/antigravity-cli/settings.json` — `permissions.{deny,ask,allow}`
 *     plus `toolPermission` (`request-review` | `proceed-in-sandbox` |
 *     `always-proceed` | `strict`), `enableTerminalSandbox`,
 *     `allowNonWorkspaceAccess`. Located at `$GEMINI_DIR/antigravity-cli/`, so
 *     the Kory-managed `ANTIGRAVITY_HOME` relocates it.
 *   - Lifecycle hooks at `~/.gemini/config/hooks.json` (global) or
 *     `<workspace>/.agents/hooks.json`. Koryphaios uses the global location so a
 *     turn never writes into the user's checkout.
 *
 * Headless (`--input-format stream-json`, which is how Koryphaios drives agy)
 * cannot prompt. agy therefore **soft-denies** anything landing in `ask`, and
 * reports it as `denied_actions`. That makes the `settings.json` lists the
 * load-bearing control: an action Koryphaios does not explicitly allow simply
 * cannot execute, with no hook support required.
 *
 * Two consequences worth stating plainly:
 *
 *  1. `--mode plan|accept-edits` is NOT a control here. agy logs "Print mode:
 *     --mode %s is not supported headless" and continues in the default mode,
 *     so the flag the adapter used to pass for plan/critic turns was inert.
 *     Plan posture is expressed with permission rules instead, which do apply.
 *  2. The policy below is deliberately independent of Kory's `permissionMode`.
 *     Koryphaios owns host tool execution for every mode, so native writes and
 *     native shell are denied uniformly and *all* real work flows through the
 *     `kory__*` MCP bridge, where `permission-policy.ts` applies the session's
 *     approval preset. The hook then redirects refused native calls to their
 *     `kory__` equivalent so the agent recovers instead of stalling.
 *
 * Everything below was measured against a live agy 1.2.16 turn, not inferred
 * from documentation. The MCP server must be registered at
 * `$GEMINI_DIR/config/mcp_config.json`; agy surfaces MCP through the single
 * built-in `call_mcp_tool` tool rather than one tool per server.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Native agy tools that carry no host authority and may always run. */
const ANTIGRAVITY_SAFE_NATIVE_TOOLS = new Set([
  'ask_question',
  'finish',
  'generate_image',
  'image_gen',
  'list_permissions',
  'manage_task',
  'schedule',
  'todo_write',
  'todowrite',
  'update_plan',
]);

/**
 * agy tool names are the lowercased step type (`CORTEX_STEP_TYPE_*` stripped),
 * e.g. `run_command` — not the `read`/`write`/`exec` spellings other CLIs use.
 * Anything mapped here is denied natively and redirected to its Koryphaios
 * equivalent, which is the only path with a permission decision behind it.
 */
const ANTIGRAVITY_NATIVE_TO_KORY: Record<string, string> = {
  find_by_name: 'kory__glob',
  grep_search: 'kory__grep',
  list_dir: 'kory__ls',
  multi_replace_file_content: 'kory__batch_edit',
  read_url_content: 'kory__web_fetch',
  replace_file_content: 'kory__edit_file',
  read_file: 'kory__read_file',
  run_command: 'kory__bash',
  search_web: 'kory__web_search',
  view_code_item: 'kory__read_file',
  view_file: 'kory__read_file',
  view_file_outline: 'kory__read_file',
  write_to_file: 'kory__write_file',
};

const ANTIGRAVITY_SUBAGENT_TOOLS = new Set([
  'define_subagent',
  'invoke_subagent',
  'manage_subagents',
  'send_message',
]);

/** agy has emitted both snake_case step types and display-style names such as
 * `RunCommand` in hook/result payloads. Normalize both forms before applying
 * the Kory mapping so a display name cannot fall through to generic denial. */
function normalizeAntigravityToolName(toolName: string): string {
  return toolName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export function isAntigravitySafeNativeTool(toolName: string): boolean {
  return ANTIGRAVITY_SAFE_NATIVE_TOOLS.has(normalizeAntigravityToolName(toolName));
}

export function antigravityNativeToolEquivalent(
  toolName: string,
): { kind: 'safe' } | { kind: 'delegate' } | { kind: 'kory'; kory: string } | { kind: 'unknown' } {
  const name = normalizeAntigravityToolName(toolName);
  if (ANTIGRAVITY_SAFE_NATIVE_TOOLS.has(name)) return { kind: 'safe' };
  const kory = ANTIGRAVITY_NATIVE_TO_KORY[name];
  if (kory) return { kind: 'kory', kory };
  if (ANTIGRAVITY_SUBAGENT_TOOLS.has(name)) return { kind: 'delegate' };
  return { kind: 'unknown' };
}

/**
 * Give agy an executable recovery instruction when its native tool gate fires.
 * A bare `kory__bash` name is not callable in agy's tool surface: agy exposes
 * the Kory server through the single `call_mcp_tool` dispatcher. Naming the
 * dispatcher and its exact envelope prevents the model from retrying the
 * refused native call or inventing the legacy `kory_bash` spelling.
 */
export function antigravityNativeToolRedirectReason(nativeTool: string, koryTool: string): string {
  return (
    `Native agy tool ${JSON.stringify(nativeTool)} is denied and must not be retried. ` +
    `Call call_mcp_tool with ServerName="kory", ToolName=${JSON.stringify(koryTool)}, ` +
    'and Arguments containing the equivalent operation. ' +
    'Koryphaios owns host tool execution and permission checks.'
  );
}

function canonicalizeExistingAncestor(targetPath: string): string | null {
  let cursor = resolve(targetPath);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        return resolve(realpathSync(cursor), ...missing);
      }
      return resolve(realpathSync(cursor), ...missing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(cursor, ...missing);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Antigravity registers MCP tools as lazy (`call_mcp_tool`) and instructs the
 * model to read `$GEMINI_DIR/antigravity-cli/mcp/<server>/<tool>.json` for tool
 * schemas and `$GEMINI_DIR/antigravity-cli/brain/<id>/...` for spilled step
 * outputs. Those two internal trees are read-only CLI metadata and never
 * include sibling credential files (`antigravity-oauth-token`).
 */
export function isAntigravityInternalReadPath(rawPath: unknown): boolean {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\0')) return false;
  const resolved = resolve(trimmed);
  const matchesInternalSubtree = (candidate: string): boolean =>
    /(?:^|\/)\.gemini\/antigravity-cli\/(?:mcp|brain)\/[^/]/.test(candidate);
  if (!matchesInternalSubtree(resolved)) return false;
  const canonical = canonicalizeExistingAncestor(resolved);
  return canonical !== null && matchesInternalSubtree(canonical);
}

/**
 * agy's `toolPermission` presets. `request-review` is the only preset that both
 * keeps ordinary work working and stays fail-closed headlessly: workspace file
 * access is permitted without a prompt, while writes, shell, and web land in
 * `ask`, which a headless turn auto-denies.
 *
 * Rejected alternatives, both measured against agy 1.2.16:
 *   - `always-proceed` is `--dangerously-skip-permissions`: native tools run
 *     with no gate at all.
 *   - `strict` also auto-denies workspace *reads* in a headless turn, leaving
 *     the agent unable to read its own checkout.
 */
export type AntigravityToolPermission = 'request-review';

export interface AntigravityPermissionSettings {
  toolPermission: AntigravityToolPermission;
  /** Workspaces agy treats as project roots, so reads need no approval. */
  trustedWorkspaces: string[];
  enableTerminalSandbox: boolean;
  allowNonWorkspaceAccess: boolean;
  permissions: {
    deny: string[];
    ask: string[];
    allow: string[];
  };
}

export interface AntigravitySettingsInput {
  /** Session workspace. Grants recursive read of exactly this tree. */
  workspacePath?: string | null;
  /** Managed Antigravity home so agy can read its own lazy MCP schemas and brain step outputs. */
  antigravityHome?: string | null;
}

/** `read_file` targets are matched literally against the path agy resolved, so
 *  the rule must carry the canonical path: a session workspace reached through a
 *  symlink (e.g. macOS `/var` → `/private/var`) otherwise never matches and the
 *  agent cannot read its own checkout. Trailing separators are dropped because
 *  a bare directory is how agy expresses recursive access. */
function readTarget(workspacePath: string): string {
  const trimmed = workspacePath.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  try {
    return realpathSync(trimmed).replace(/\/+$/, '');
  } catch {
    // A workspace that does not exist yet cannot be canonicalized; fall back to
    // the literal path. Omitting the rule entirely would be no safer: agy would
    // then fall back to Ask, which headless turns auto-deny.
    return trimmed;
  }
}

/**
 * Build the `settings.json` payload Koryphaios enforces for a turn.
 *
 * Everything Koryphaios owns execution of is in `deny`, so no stray allow-rule
 * or upstream default can re-enable it (Deny beats Ask beats Allow):
 *   - `command(*)` — native shell. Current agy releases reject the old
 *     `unsandboxed(*)` resource name, so do not emit it: `command(*)` is the
 *     supported shell gate for both sandboxed and unsandboxed execution.
 *   - `write_file(*)`               — native edits, which implicitly grant reads
 *   - `read_url(*)` / `execute_url(*)` — native web, including the browser agent
 *
 * `allow` is deliberately short, and both entries are load-bearing (both
 * verified against a live headless turn):
 *   - `read_file(<workspace>)` — with the workspace also listed in
 *     `trustedWorkspaces`, the agent can read its own checkout. Trust is the
 *     part that matters: an untrusted workspace makes even reads require
 *     approval, and approval is exactly what headless cannot provide.
 *   - `mcp(kory/*)` — REQUIRED, not decorative. `call_mcp_tool` defaults to
 *     `ask`, so without this rule the Koryphaios bridge is unreachable in a
 *     headless turn and every real action would be denied. With it, the bridge
 *     is the single sanctioned path to any host effect.
 */
export function buildAntigravitySettings(
  input: AntigravitySettingsInput,
): AntigravityPermissionSettings {
  const allow: string[] = ['mcp(kory/*)'];
  const trustedWorkspaces: string[] = [];
  const addReadableRoot = (candidatePath?: string | null) => {
    const trimmed = candidatePath?.trim();
    if (!trimmed) return;
    const canonical = readTarget(trimmed);
    if (!canonical) return;
    if (!trustedWorkspaces.includes(canonical)) {
      trustedWorkspaces.push(canonical);
    }
    const rule = `read_file(${canonical})`;
    if (!allow.includes(rule)) {
      allow.push(rule);
    }
  };

  addReadableRoot(input.workspacePath);
  const agyHome = input.antigravityHome?.trim();
  if (agyHome) {
    // Allow agy to read only its lazy MCP tool schema directory and brain step
    // output directory — never the parent antigravity-cli root where the OAuth
    // token file resides.
    addReadableRoot(join(agyHome, '.gemini', 'antigravity-cli', 'mcp'));
    addReadableRoot(join(agyHome, '.gemini', 'antigravity-cli', 'brain'));
  }

  return {
    // Never `always-proceed`: that is `--dangerously-skip-permissions`.
    toolPermission: 'request-review',
    trustedWorkspaces,
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    permissions: {
      deny: ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'],
      // Nothing can be asked headlessly; leaving this empty keeps `deny` the
      // single source of refusals instead of adding a second, softer path.
      ask: [],
      allow,
    },
  };
}

export interface AntigravityHooksInput {
  /** Absolute path to `kory-hook-bridge.ts`. */
  hookScript: string;
  /** Per-turn bridge grant file that authenticates the hook callback. */
  authFile: string;
  /** Host-resolved bridge interpreter; the headless runtime may be Bun-only. */
  runtime?: string;
  /** Optional explicit backend URL for the hook callback. */
  backendUrl?: string;
}

const KORY_HOOK_NAME = 'kory-permission-gate';
const HOOK_TIMEOUT_SECONDS = 20;

/**
 * Build the global `hooks.json` for a turn.
 *
 * Shape and decision vocabulary are agy's own, not Claude Code's: top-level
 * keys are hook *names*, tool matchers are regexes, and `PreToolUse` decisions
 * are `allow` | `deny` | `ask` | `force_ask`. agy rejects anything else
 * ("unsupported hook decision"), so the bridge is told which vocabulary to
 * speak via `--decision-vocabulary`.
 *
 * This layer is the *redirector*: it names the `kory__` equivalent so the agent
 * re-routes through the bridge instead of stalling on a refusal. The
 * `settings.json` deny list above is what makes the refusal real.
 */
export function buildAntigravityHooks(input: AntigravityHooksInput): string {
  const command = [
    input.runtime ? JSON.stringify(input.runtime) : 'node',
    JSON.stringify(input.hookScript),
    '--auth-file',
    JSON.stringify(input.authFile),
    ...(input.backendUrl ? ['--backend-url', JSON.stringify(input.backendUrl)] : []),
    '--event',
    'PreToolUse',
    '--decision-vocabulary',
    'antigravity',
  ].join(' ');
  return `${JSON.stringify(
    {
      [KORY_HOOK_NAME]: {
        enabled: true,
        PreToolUse: [
          {
            // "" matches every tool, so no native tool can slip past unmatched.
            matcher: '',
            hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}
