// Tool system — abstract base and registry.
// Ported from OpenCode's tools/tools.go pattern.

import type { ChangeSummary } from '@koryphaios/shared';
import { crossAgentEvidenceCache, stableEvidenceVariant } from '../cache/evidence-cache';
import { tryResolveGitTreeEvidenceIdentity } from '../cache/git-evidence';
import { toolLog } from '../logger';
import { summarizeToolErrorForAudit } from '../security/bash-sandbox';
import {
  decideToolPermission,
  type ToolPermissionPolicy,
  type ResolvedSandboxOptions,
} from './permission-policy';
import { toolSchemaGuidance, validateToolInputAgainstSchema } from './tool-exposure';
import { checkNoteToolPermission } from '../notes/notes-settings';
import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { sessionWorkspaceOwnership } from '../kory/session-workspace';
import { validatePathAccess } from '../security/path-security';
import { tryAcquireWorkspaceOperation } from './workspace-operation-gate';

export interface ToolContext {
  sessionId: string;
  /** Authenticated actor when known. Falls back to a session-scoped audit identity locally. */
  userId?: string;
  activeProvider?: string;
  activeModel?: string;
  reasoningLevel?: string;
  goalId?: string;
  goalItemId?: string;
  /** Optional agent identifier for backward compatibility in tests and callsites. */
  agentId?: string;
  /** Caller's orchestration role when known. Messaging tools use it to fail
   *  closed: workers may only reach their own manager, managers reach any. */
  callerRole?: 'manager' | 'worker' | 'critic' | 'coder';
  /** Caller's worker domain when the caller is a sub-agent (e.g. 'backend'). */
  callerDomain?: string;
  /** Validate incoming input against the tool's authoritative schema and return
   *  that schema on rejection. Required wherever tools are advertised with the
   *  stub schema, because the model then has not seen the real contract. */
  validateToolInput?: boolean;
  workingDirectory: string;
  /** Host-derived immutable write grant for an owned chat checkout (or its
   * narrower worker directory). Never take this value from tool input. */
  requiredWorkspaceRoot?: string;
  /** Canonical host-owned project root, distinct from a worker's disposable checkout. */
  settingsRoot?: string;
  signal?: AbortSignal;
  /** whitelisted paths for scoped access (sandboxing) */
  allowedPaths?: string[];
  /** Whether the tool execution should be strictly sandboxed */
  isSandboxed?: boolean;
  /** Resolved granular sandbox flags. When present, bash validation and path
   *  confinement honor these per-toggle overrides. Falls back to the legacy
   *  `isSandboxed` boolean behavior when absent. */
  sandboxOptions?: ResolvedSandboxOptions;
  /** Optional callback for streaming file edit deltas to the UI */
  emitFileEdit?: (event: {
    path: string;
    delta: string;
    totalLength: number;
    operation: 'create' | 'edit';
    /** For edits: the original text being replaced, sent once on the first delta (enables a live diff). */
    oldStr?: string;
  }) => void;
  emitFileComplete?: (event: {
    path: string;
    totalLines: number;
    operation: 'create' | 'edit';
  }) => void;
  /** Optional callback to request user input (blocking). The optional opts
   *  bag controls whether the UI offers a custom-response text input and a
   *  "keep chatting" defer button. Tool approvals pass `false` for both so
   *  the dialog is a binary approve/reject with no free-text escape hatch. */
  waitForUserInput?: (
    question: string,
    options: string[],
    opts?: { allowOther?: boolean; allowKeepChatting?: boolean },
  ) => Promise<string>;
  /** Host-owned approval policy. Every Kory tool execution, including worker
   *  tools, passes through this policy before the tool can run. */
  permissionPolicy?: ToolPermissionPolicy;
  /** Calls approved by the host policy do not prompt a second time inside a
   *  tool-specific risk check such as catastrophic bash detection. */
  approvedToolCallIds?: Set<string>;
  /** Optional callback to record code changes for summary and keep/reject */
  recordChange?: (change: ChangeSummary) => void;
  /** Optional: manager-only. When the manager calls delegate_to_worker, this runs the worker pipeline and returns a summary. */
  delegateToWorker?: (
    task: string,
    domain?: string,
    skills?: import('../kory/skill-assignment').SkillAssignment,
  ) => Promise<string>;
  /** Optional: manager-only. Delegates to Google Jules (cloud async agent, API only). */
  delegateToJules?: (
    task: string,
    options?: { createPr?: boolean; branch?: string },
  ) => Promise<string>;
  /** Optional preflight hook called before a file-mutating tool runs. If the
   *  callback returns `{ allowed: false }`, the tool is blocked and its result
   *  is replaced with the reason. Used by autonomy limits to enforce approval
   *  thresholds before large changes. */
  preflightFileChange?: (proposal: {
    paths: string[];
    linesChanged: number;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  /** Host-owned turn eligibility. Provider declarations may stay byte-stable
   *  across plan/act, Notes, web-search, and agent-mode changes while actual
   *  execution still fails closed against the current turn policy. */
  allowedToolNames?: Set<string>;
}

export interface ToolCallInput {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallOutput {
  /** Ephemeral model-visible images; do not include in text archives or audit payloads. */
  images?: Array<{ mimeType: string; data: string }>;
  callId: string;
  name: string;
  output: string;
  isError: boolean;
  durationMs: number;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Optional role restriction: manager = full access; worker = builders; critic = read-only (read_file, grep, glob, ls); any = all roles */
  readonly role?: 'manager' | 'worker' | 'critic' | 'any';

  /** Execute the tool with the given input. */
  run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput>;
}

type ToolExecutionRole = 'manager' | 'worker' | 'critic' | 'coder';

const CRITIC_READ_ONLY_TOOLS = new Set(['read_file', 'grep', 'glob', 'ls']);

/** Role filter: manager gets manager+worker+any (full); worker gets worker+any; critic gets critic+any (read-only only). */
export function roleIncludesTool(
  toolName: string,
  role: ToolExecutionRole,
  toolRole?: 'manager' | 'worker' | 'critic' | 'any',
): boolean {
  const normalizedRole: 'manager' | 'worker' | 'critic' = role === 'coder' ? 'worker' : role;
  const r = toolRole as string | undefined;

  if (normalizedRole === 'critic') {
    // Critic is read-only: the read-only filesystem tools, tools explicitly roled 'critic',
    // or tools the author explicitly marked 'any' (safe for all roles). Crucially, do NOT
    // fall through to NO-role/default tools — that is how bash/write_file leaked to the critic.
    return CRITIC_READ_ONLY_TOOLS.has(toolName) || r === 'critic' || r === 'any';
  }
  if (!r || r === 'any') return true;
  if (normalizedRole === 'manager') return r === 'manager' || r === 'worker';
  return r === normalizedRole;
}

/** Tools that mutate files and are subject to preflight approval checks. */
const FILE_MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'batch_edit',
  'patch',
  'delete_file',
  'move_file',
]);

const EVIDENCE_CACHEABLE_TOOLS = new Set(['grep', 'glob']);
function normalizeEvidencePath(value: unknown, workingDirectory: string): unknown {
  if (typeof value !== 'string') return value;
  const prefix = workingDirectory.endsWith('/') ? workingDirectory : `${workingDirectory}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
async function runToolWithEvidenceCache(
  tool: Tool,
  ctx: ToolContext,
  call: ToolCallInput,
): Promise<ToolCallOutput> {
  if (!EVIDENCE_CACHEABLE_TOOLS.has(tool.name)) return tool.run(ctx, call);
  const tree = await tryResolveGitTreeEvidenceIdentity(ctx.workingDirectory);
  if (!tree) return tool.run(ctx, call);
  if (ctx.allowedPaths?.some((path) => !path.startsWith(ctx.workingDirectory)))
    return tool.run(ctx, call);
  const input = { ...(call.input as Record<string, unknown>) };
  if ('path' in input) input.path = normalizeEvidencePath(input.path, ctx.workingDirectory);
  const variant = stableEvidenceVariant({
    input,
    allowedPaths: ctx.allowedPaths
      ?.map((path) => normalizeEvidencePath(path, ctx.workingDirectory))
      .sort(),
    subdir: tree.relativeWorkingDirectory,
    callerRole: ctx.callerRole,
    callerDomain: ctx.callerDomain,
  });
  const evidence = await crossAgentEvidenceCache.getOrLoad(
    {
      scope: tree.scope,
      operation: tool.name,
      revision: `tree:${tree.algorithm}:${tree.oid}`,
      variant,
    },
    async () => {
      const result = await tool.run(ctx, call);
      return { output: result.output, isError: result.isError };
    },
    {
      validate: async (value) => {
        if (value.isError) return false;
        const current = await tryResolveGitTreeEvidenceIdentity(ctx.workingDirectory);
        return Boolean(
          current &&
          current.scope === tree.scope &&
          current.oid === tree.oid &&
          current.relativeWorkingDirectory === tree.relativeWorkingDirectory,
        );
      },
    },
  );
  return {
    callId: call.id,
    name: tool.name,
    output: evidence.output,
    isError: evidence.isError,
    durationMs: 0,
  };
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  /** Remove a single tool by name. Returns true if a tool was removed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Remove every tool whose name starts with `prefix` (e.g. `mcp_myserver_`).
   *  Returns the count of removed tools. Used when an MCP server is deleted. */
  unregisterByPrefix(prefix: string): number {
    let removed = 0;
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        removed++;
      }
    }
    return removed;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** Get tool definitions formatted for LLM provider calls, filtered by role. Manager = full; worker = build tools; critic = read-only (read_file, grep, glob, ls). */
  getToolDefsForRole(role: ToolExecutionRole) {
    return (
      this.getAll()
        .filter((t) => roleIncludesTool(t.name, role, t.role))
        // Registration order is operational state, not prompt semantics. Keep
        // provider tool declarations byte-stable so unrelated plugin load order
        // cannot destroy a warm prompt-cache prefix.
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
    );
  }

  isAllowedForRole(name: string, role: ToolExecutionRole): boolean {
    const tool = this.tools.get(name);
    return Boolean(tool && roleIncludesTool(tool.name, role, tool.role));
  }

  async execute(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        callId: call.id,
        name: call.name,
        output: `Unknown tool: ${call.name}`,
        isError: true,
        durationMs: 0,
      };
    }

    if (ctx.allowedToolNames && !ctx.allowedToolNames.has(call.name)) {
      return {
        callId: call.id,
        name: call.name,
        output: `Tool ${call.name} is disabled for this turn by the host.`,
        isError: true,
        durationMs: 0,
      };
    }

    if (ctx.callerRole && !roleIncludesTool(tool.name, ctx.callerRole, tool.role)) {
      return {
        callId: call.id,
        name: call.name,
        output: `Tool ${call.name} is not available to the ${ctx.callerRole} role.`,
        isError: true,
        durationMs: 0,
      };
    }

    const start = performance.now();

    // Ownership, not provider input or sandbox preferences, establishes the
    // mandatory write boundary. A worker's own cwd is intentionally narrower
    // than the owning chat checkout. Clone rather than mutate the caller's ctx.
    try {
      const owner = sessionWorkspaceOwnership(ctx.workingDirectory);
      if (!owner && ctx.requiredWorkspaceRoot) {
        throw new Error('Owned workspace is no longer available');
      }
      const cwd = owner ? realpathSync(ctx.workingDirectory) : undefined;
      if (owner && cwd) {
        const rel = relative(owner.checkout, cwd);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error('Owned workspace cwd was redirected outside its checkout');
        }
      }
      // A manager opened on a repository subdirectory still owns that chat's
      // independent Git metadata. Workers retain only their task checkout.
      const root = owner ? (ctx.callerRole === 'manager' ? owner.checkout : cwd) : undefined;
      if (ctx.requiredWorkspaceRoot && root !== ctx.requiredWorkspaceRoot) {
        throw new Error('The pinned workspace grant was redirected');
      }
      if (root || ctx.requiredWorkspaceRoot) {
        ctx.requiredWorkspaceRoot = root;
        ctx.approvedToolCallIds ??= new Set();
        ctx = { ...ctx, requiredWorkspaceRoot: root, ...(cwd ? { workingDirectory: cwd } : {}) };
      }
    } catch {
      return {
        callId: call.id,
        name: call.name,
        isError: true,
        output: 'Cannot establish the mandatory workspace boundary.',
        durationMs: performance.now() - start,
      };
    }

    // Approval receipts are single-invocation capabilities. A provider may
    // reuse a tool-call ID, so discard any stale receipt before deciding the
    // current call. The host adds it back only after this invocation's prompt.
    ctx.approvedToolCallIds?.delete(call.id);

    if (
      ctx.validateToolInput ||
      call.name === 'propose_note_relationship' ||
      call.name === 'review_note_relationship'
    ) {
      const verdict = await validateToolInputAgainstSchema(tool.inputSchema, call.input);
      if (!verdict.valid) {
        return {
          callId: call.id,
          name: call.name,
          output: toolSchemaGuidance(call.name, tool.inputSchema, verdict.error),
          isError: true,
          durationMs: performance.now() - start,
        };
      }
    }

    const input = call.input as Record<string, unknown>;
    const files = Array.isArray(input.files) ? (input.files as Array<Record<string, unknown>>) : [];
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
    const paths = [
      input.path,
      input.oldPath,
      input.newPath,
      input.source,
      input.destination,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const file of [...files, ...edits]) {
      if (typeof file.path === 'string') paths.push(file.path);
    }
    const operations = Array.isArray(input.operations)
      ? (input.operations as Array<Record<string, unknown>>)
      : [];
    for (const operation of operations) {
      if (typeof operation.path === 'string') paths.push(operation.path);
    }
    const nestedEdits = [
      ...edits,
      ...files.flatMap((file) =>
        Array.isArray(file.edits) ? (file.edits as Array<Record<string, unknown>>) : [],
      ),
    ];
    const lineSources = [
      input.content,
      input.newStr,
      input.new_str,
      ...operations.flatMap((operation) => [
        operation.content,
        operation.newStr,
        operation.new_str,
      ]),
      ...nestedEdits.map((edit) => edit.new_str),
    ].filter((value): value is string => typeof value === 'string');
    const change = {
      fileCount: new Set(paths).size,
      linesChanged: lineSources.reduce((total, value) => total + value.split('\n').length, 0),
    };
    const decidePermission = () => {
      const host = decideToolPermission(ctx.permissionPolicy, call.name, change);
      if (host.action === 'deny') return host;
      if (call.name === 'propose_note_relationship' || call.name === 'review_note_relationship') {
        const notes = checkNoteToolPermission(call.name, ctx.settingsRoot ?? ctx.workingDirectory);
        if (!notes.allowed) return { action: 'deny' as const, reason: notes.reason };
        if (call.name === 'review_note_relationship')
          return {
            action: 'ask' as const,
            reason: `Independent human review required for ${call.name}: ${JSON.stringify(call.input)}`,
          };
        return notes.requiresApproval ? { action: 'ask' as const, reason: notes.reason } : host;
      }
      if (call.name !== 'retrieve_note_context') return host;
      // Retrieval reads note bodies on behalf of read_note. Compose both
      // policies here so every native/MCP path gets one fresh approval receipt,
      // and an allowlist or permissive mode cannot override Notes Ask/Block.
      const root = ctx.settingsRoot ?? ctx.workingDirectory;
      let decision = host;
      for (const name of ['retrieve_note_context', 'read_note']) {
        const notes = checkNoteToolPermission(name, root);
        if (!notes.allowed) return { action: 'deny' as const, reason: notes.reason };
        const readHost = decideToolPermission(ctx.permissionPolicy, name);
        if (readHost.action === 'deny') return readHost;
        if (notes.requiresApproval) decision = { action: 'ask', reason: notes.reason };
        else if (readHost.action === 'ask') decision = readHost;
      }
      return decision;
    };
    const permission = decidePermission();
    if (permission.action === 'deny') {
      return {
        callId: call.id,
        name: call.name,
        output: permission.reason,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
    // First-party computer tools perform their argument-bound approval inside
    // the cancellable desktop lock. Do not leave a second generic prompt outside Stop.
    if (
      permission.action === 'ask' &&
      (!tool.name.startsWith('computer_') || tool.name === 'computer_status')
    ) {
      if (!ctx.waitForUserInput) {
        return {
          callId: call.id,
          name: call.name,
          output: `${permission.reason}, but no human approval channel is available.`,
          isError: true,
          durationMs: performance.now() - start,
        };
      }
      let poll: ReturnType<typeof setInterval> | undefined;
      const liveRace = new Promise<string>((resolve) => {
        poll = setInterval(() => {
          try {
            const fresh = decidePermission();
            if (fresh.action === 'allow') {
              clearInterval(poll);
              resolve('__LIVE_ALLOW__');
            } else if (fresh.action === 'deny') {
              clearInterval(poll);
              resolve('__LIVE_DENY__');
            }
          } catch {}
          if (ctx.signal?.aborted) {
            clearInterval(poll);
            resolve('__LIVE_ABORT__');
          }
        }, 250);
        if (ctx.signal) {
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearInterval(poll);
              resolve('__LIVE_ABORT__');
            },
            { once: true },
          );
        }
      });
      const selection = await Promise.race([
        ctx.waitForUserInput(
          `${permission.reason}. Allow ${call.name} once?`,
          ['Allow once', 'Reject'],
          { allowOther: false, allowKeepChatting: false },
        ),
        liveRace,
      ]);
      if (poll) clearInterval(poll);
      if (selection === '__LIVE_ALLOW__') {
        (ctx.approvedToolCallIds ??= new Set()).add(call.id);
      } else if (selection === '__LIVE_DENY__') {
        const fresh = decidePermission();
        return {
          callId: call.id,
          name: call.name,
          output: fresh.reason,
          isError: true,
          durationMs: performance.now() - start,
        };
      } else if (selection === '__LIVE_ABORT__') {
        return {
          callId: call.id,
          name: call.name,
          output: 'Tool aborted.',
          isError: true,
          durationMs: performance.now() - start,
        };
      } else if (selection !== 'Allow once') {
        return {
          callId: call.id,
          name: call.name,
          output:
            selection === '__timeout__'
              ? 'Approval timed out; tool was not run.'
              : 'Tool rejected by user.',
          isError: true,
          durationMs: performance.now() - start,
        };
      }
      (ctx.approvedToolCallIds ??= new Set()).add(call.id);
    }

    // Preflight check for file-mutating tools when autonomy limits are active.
    if (ctx.preflightFileChange && FILE_MUTATING_TOOLS.has(call.name)) {
      const paths: string[] = typeof input.path === 'string' ? [input.path] : [];
      const content = typeof input.content === 'string' ? input.content : '';
      const linesChanged = content ? content.split('\n').length : 0;
      try {
        const verdict = await ctx.preflightFileChange({ paths, linesChanged });
        if (!verdict.allowed) {
          const denialAudit = summarizeToolErrorForAudit(verdict.reason ?? 'preflight denied');
          toolLog.warn(
            {
              ...denialAudit,
              decision: 'preflight_denied',
              toolCallId: call.id,
              sessionId: ctx.sessionId,
            },
            'preflight check denied tool execution',
          );
          return {
            callId: call.id,
            name: call.name,
            output: 'Tool change blocked by the preflight safety policy.',
            isError: true,
            durationMs: performance.now() - start,
          };
        }
      } catch (err: unknown) {
        // If the preflight hook throws, fail closed (block the tool).
        const errorAudit = summarizeToolErrorForAudit(err);
        toolLog.debug(
          {
            ...errorAudit,
            decision: 'preflight_blocked',
            toolCallId: call.id,
            sessionId: ctx.sessionId,
          },
          'preflight check threw — blocking tool for safety',
        );
        return {
          callId: call.id,
          name: call.name,
          output: 'Preflight check failed — tool blocked for safety.',
          isError: true,
          durationMs: performance.now() - start,
        };
      }
    }

    if (
      ['retrieve_note_context', 'propose_note_relationship', 'review_note_relationship'].includes(
        call.name,
      )
    ) {
      // Approval is not permission to ignore revocation while the prompt was open.
      const current = decidePermission();
      if (current.action === 'deny') {
        return {
          callId: call.id,
          name: call.name,
          output: current.reason,
          isError: true,
          durationMs: performance.now() - start,
        };
      }
    }

    const workspaceLease = tryAcquireWorkspaceOperation(ctx.sessionId, call.name === 'git_switch');
    if (!workspaceLease) {
      return {
        callId: call.id,
        name: call.name,
        isError: true,
        output:
          'This chat has another workspace operation in progress. Retry after it finishes; Git switching cannot overlap other tools.',
        durationMs: performance.now() - start,
      };
    }
    try {
      if (ctx.requiredWorkspaceRoot && FILE_MUTATING_TOOLS.has(call.name)) {
        // Recheck after approval/preflight awaits. Settings and YOLO may waive
        // prompts, never ownership. Always resolve symlinks, including parents
        // of not-yet-created paths; broad caller allowedPaths are not authority.
        const root = ctx.requiredWorkspaceRoot;
        if (
          realpathSync(root) !== root ||
          paths.some(
            (path) =>
              !validatePathAccess(resolve(ctx.workingDirectory, path), [root], {
                followSymlinks: true,
              }).allowed,
          )
        ) {
          return {
            callId: call.id,
            name: call.name,
            isError: true,
            output: 'Access denied: file mutation is outside the mandatory workspace boundary.',
            durationMs: performance.now() - start,
          };
        }
        ctx = { ...ctx, allowedPaths: [root] };
      }
      const result = await runToolWithEvidenceCache(tool, ctx, call);
      result.durationMs = performance.now() - start;
      return result;
    } catch (err: unknown) {
      const errorAudit = summarizeToolErrorForAudit(err);
      toolLog.error(
        {
          ...errorAudit,
          decision: 'tool_execution_failed',
          toolCallId: call.id,
          sessionId: ctx.sessionId,
        },
        'Tool execution failed',
      );

      return {
        callId: call.id,
        name: call.name,
        output: `Tool execution failed safely (code: ${errorAudit.errorCode}; reference: ${errorAudit.errorFingerprint}).`,
        isError: true,
        durationMs: performance.now() - start,
      };
    } finally {
      workspaceLease.release();
    }
  }
}
