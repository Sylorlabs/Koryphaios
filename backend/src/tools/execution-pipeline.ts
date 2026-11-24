import { crossAgentEvidenceCache, stableEvidenceVariant } from '../cache/evidence-cache';
import { tryResolveGitTreeEvidenceIdentity } from '../cache/git-evidence';
import { toolLog } from '../logger';
import { summarizeToolErrorForAudit } from '../security/bash-sandbox';
import { screenToolCall } from '../security/banned-names';
import { decideToolPermission, READ_ONLY_TOOLS } from './permission-policy';
import { toolSchemaGuidance, validateToolInputAgainstSchema } from './tool-exposure';
import { isNoteToolName } from '@koryphaios/shared';
import { checkNoteToolPermission } from '../notes/notes-settings';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionWorkspaceOwnership } from '../kory/session-workspace';
import { validatePathAccess } from '../security/path-security';
import { canonicalizePath, isContainedBy } from '../runtime/platform';
import { tryAcquireWorkspaceOperation } from './workspace-operation-gate';
import { roleIncludesTool } from './tool-roles';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import {
  FILESYSTEM_TOOLS,
  FILE_MUTATING_TOOLS,
  WORKSPACE_MUTATING_TOOLS,
  FilePathScope,
  bindFilePathScope,
} from './external-paths';

function approvalSubject(ctx: ToolContext): string {
  if (ctx.callerDomain)
    return `${ctx.callerDomain[0].toUpperCase()}${ctx.callerDomain.slice(1)} worker`;
  if (ctx.callerRole === 'manager') return 'Kory';
  if (ctx.callerRole === 'critic') return 'Critic';
  return ctx.agentName ?? 'Backend';
}

function approvalQuestion(ctx: ToolContext, call: ToolCallInput): string {
  const subject = approvalSubject(ctx);
  if (call.name === 'bash' && typeof call.input.command === 'string') {
    return `${subject} is requesting permission to run this terminal command:\n\n${call.input.command}`;
  }
  const action = call.name.replaceAll('_', ' ');
  const path = typeof call.input.path === 'string' ? `:\n\n${call.input.path}` : '';
  return `${subject} is requesting permission to ${action}${path}`;
}

/** Derive an execution context without snapshotting live host-policy getters. */
export function deriveToolContext(ctx: ToolContext, overrides: Partial<ToolContext>): ToolContext {
  return Object.create(Object.getPrototypeOf(ctx), {
    ...Object.getOwnPropertyDescriptors(ctx),
    ...Object.getOwnPropertyDescriptors(overrides),
  });
}

/** A read-only tool must not keep the turn alive after Stop. The underlying
 *  work is harmless and is left to finish, but the tool loop returns now.
 *  File-mutating tools are deliberately excluded: they check the signal at
 *  their own mutation boundary so a write is never reported as stopped while
 *  it is still landing. */
function raceToolWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  const reason = signal.reason ?? new DOMException('Tool call stopped by user', 'AbortError');
  if (signal.aborted) return Promise.reject(reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

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

/** Execute a resolved tool through the host policy and workspace pipeline. */
export async function executeTool(
  tool: Tool,
  ctx: ToolContext,
  call: ToolCallInput,
): Promise<ToolCallOutput> {
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

  // Bouncer, not a killer: a name the owner has banned never reaches the
  // filesystem or the process table. Screened here, before ownership, sandbox
  // and approval work, so a refused call costs nothing and leaves no artifact.
  const banned = screenToolCall(call);
  if (banned) {
    return {
      callId: call.id,
      name: call.name,
      output: banned.reason,
      isError: true,
      durationMs: 0,
    };
  }

  // The workspace binding was swapped mid-turn (isolate_chat/merge_chat_back):
  // this context still points at the pre-change directory, so mutations must
  // wait for the next turn's fresh context.
  if (ctx.workspaceRebindPending === true && WORKSPACE_MUTATING_TOOLS.has(call.name)) {
    return {
      callId: call.id,
      name: call.name,
      output:
        "This chat's workspace changed during this turn; the work continues in the next turn.",
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
    const reviewRoot = ctx.reviewWorkspaceRoot
      ? canonicalizePath(ctx.reviewWorkspaceRoot)
      : undefined;
    // canonicalizePath resolves symlinks and therefore throws on a missing
    // path; a vanished grant is the same "no longer available" failure.
    let grantRoot: string | undefined;
    if (ctx.requiredWorkspaceRoot) {
      try {
        grantRoot = canonicalizePath(ctx.requiredWorkspaceRoot);
      } catch {
        throw new Error('Owned workspace is no longer available');
      }
      if (!existsSync(grantRoot)) {
        throw new Error('Owned workspace is no longer available');
      }
    }
    const cwd =
      owner || reviewRoot || grantRoot ? canonicalizePath(ctx.workingDirectory) : undefined;
    if (reviewRoot && (!cwd || !isContainedBy(reviewRoot, cwd)))
      throw new Error('Verification cwd escaped its disposable grant');
    if (owner && cwd) {
      if (!isContainedBy(owner.checkout, cwd)) {
        throw new Error('Owned workspace cwd was redirected outside its checkout');
      }
    }
    // No owned checkout and no review grant: the host-issued workspace grant is
    // the boundary. It is host-set, never provider input — a worker pointed at
    // a directory this session does not own still gets its sandbox grant, not a
    // blanket refusal.
    if (!owner && !reviewRoot && grantRoot) {
      if (!cwd || !isContainedBy(grantRoot, cwd)) {
        throw new Error('Workspace grant cwd was redirected outside its root');
      }
    }
    // A manager opened on a repository subdirectory still owns that chat's
    // independent Git metadata. Workers retain only their task checkout.
    const root =
      reviewRoot ?? (owner ? (ctx.callerRole === 'manager' ? owner.checkout : cwd) : grantRoot);
    if (grantRoot && root !== grantRoot) {
      throw new Error('The pinned workspace grant was redirected');
    }
    if (root || ctx.requiredWorkspaceRoot) {
      ctx.requiredWorkspaceRoot = root;
      ctx.approvedToolCallIds ??= new Set();
      ctx = deriveToolContext(ctx, {
        requiredWorkspaceRoot: root,
        ...(cwd ? { workingDirectory: cwd } : {}),
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      callId: call.id,
      name: call.name,
      isError: true,
      output: `Cannot establish the mandatory workspace boundary: ${reason}`,
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
  const paths = [input.path, input.oldPath, input.newPath, input.source, input.destination].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
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
    input.new_string,
    ...operations.flatMap((operation) => [operation.content, operation.newStr, operation.new_str]),
    ...nestedEdits.map((edit) => edit.new_str),
  ].filter((value): value is string => typeof value === 'string');
  const change = {
    fileCount: new Set(paths).size,
    linesChanged: lineSources.reduce((total, value) => total + value.split('\n').length, 0),
  };
  let fileScope: FilePathScope | undefined;
  const hardWriteRoot = () =>
    ctx.requiredWorkspaceRoot &&
    (ctx.callerRole !== 'manager' || ctx.reviewWorkspaceRoot || !fileScope?.externalPaths.length)
      ? ctx.requiredWorkspaceRoot
      : undefined;
  const checkWriteBoundary = () => {
    const root = hardWriteRoot();
    if (!root || !FILE_MUTATING_TOOLS.has(call.name)) return;
    if (
      canonicalizePath(root) !== root ||
      paths.some(
        (path) =>
          !validatePathAccess(resolve(ctx.workingDirectory, path), [root], { followSymlinks: true })
            .allowed,
      )
    )
      throw new Error('Access denied: file mutation is outside the mandatory workspace boundary.');
  };
  // A host-side invocation scope requires an existing cwd. Permission-only
  // registry fixtures may use a synthetic, not-yet-created cwd; let their
  // host policy decide first, while built-in file tools still fail closed in
  // validateFileToolPath when they cannot verify that cwd.
  if (!tool.projectRoot && FILESYSTEM_TOOLS.has(call.name) && existsSync(ctx.workingDirectory)) {
    try {
      // Check immutable ownership before asking for authority it cannot grant.
      // Managers can authorize outside actions; workers and verification homes cannot.
      fileScope = new FilePathScope(ctx, call);
      checkWriteBoundary();
      call = fileScope.call;
    } catch (error) {
      return {
        callId: call.id,
        name: call.name,
        isError: true,
        durationMs: performance.now() - start,
        output:
          hardWriteRoot() && FILE_MUTATING_TOOLS.has(call.name)
            ? 'Access denied: file mutation is outside the mandatory workspace boundary.'
            : `Access denied: ${error instanceof Error ? error.message : 'Cannot verify filesystem paths'}`,
      };
    }
  }
  const decideBasePermission = () => {
    // A filesystem allowlist must not turn planning interaction into a write grant.
    // In plan mode, let the permission policy decide instead of unconditionally blocking
    const host = decideToolPermission(ctx.permissionPolicy, call.name, change);
    if (host.action === 'deny') return host;
    if (call.name !== 'retrieve_note_context') {
      const notes = checkNoteToolPermission(call.name, ctx.settingsRoot ?? ctx.workingDirectory, {
        mode: ctx.permissionPolicy?.mode,
      });
      if (!notes.allowed) return { action: 'deny' as const, reason: notes.reason };
      if (notes.requiresApproval)
        return {
          action: 'ask' as const,
          reason: `${notes.reason}: ${JSON.stringify(call.input).slice(0, 6000)}`,
        };
      if (
        isNoteToolName(call.name) &&
        (ctx.permissionPolicy?.mode === 'guarded' || ctx.permissionPolicy?.mode === 'yolo') &&
        !ctx.permissionPolicy.toolAsklist.includes(call.name)
      )
        return { action: 'allow' as const, reason: notes.reason };
      return host;
    }
    // Retrieval reads note bodies on behalf of read_note. Compose both
    // policies here so every native/MCP path gets one fresh approval receipt,
    // and an allowlist or permissive mode cannot override Notes Ask/Block.
    const root = ctx.settingsRoot ?? ctx.workingDirectory;
    let decision = host;
    for (const name of ['retrieve_note_context', 'read_note']) {
      const notes = checkNoteToolPermission(name, root, { mode: ctx.permissionPolicy?.mode });
      if (!notes.allowed) return { action: 'deny' as const, reason: notes.reason };
      const readHost = decideToolPermission(ctx.permissionPolicy, name);
      if (readHost.action === 'deny') return readHost;
      if (notes.requiresApproval) decision = { action: 'ask', reason: notes.reason };
      else if (readHost.action === 'ask') decision = readHost;
    }
    return decision;
  };
  const decidePermission = () => {
    const decision = decideBasePermission();
    if (
      decision.action !== 'deny' &&
      fileScope?.externalPaths.length &&
      ctx.permissionPolicy?.mode !== 'yolo'
    )
      return {
        action: 'ask' as const,
        reason: 'Outside-directory filesystem access requires human approval',
      };
    if (decision.action !== 'allow' || !ctx.requestToolApproval) return decision;
    return READ_ONLY_TOOLS.has(call.name) || call.name === 'ask_manager' || call.name === 'ask_user'
      ? decision
      : { action: 'ask' as const, reason: 'Critic action requires approval' };
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
  let humanApproved = false;
  if (fileScope?.externalPaths.length && permission.action === 'ask') {
    const question =
      `${approvalSubject(ctx)} is requesting ${call.name} outside the working directory.\n\n` +
      fileScope.targets
        .map(({ literal, canonical }) =>
          literal === canonical ? canonical : `${literal} → ${canonical}`,
        )
        .join('\n') +
      '\n\nAllow this invocation only?';
    let selection: string;
    try {
      // requestToolApproval is manager/LLM review, never human authority.
      selection = ctx.waitForToolApproval
        ? await ctx.waitForToolApproval(ctx, call, question, ['Allow once', 'Reject'], ctx.signal)
        : ctx.waitForUserInput
          ? await ctx.waitForUserInput(question, ['Allow once', 'Reject'], {
              allowOther: false,
              allowKeepChatting: false,
            })
          : '__unavailable__';
    } catch {
      selection = '__cancelled__';
    }
    if (selection !== 'Allow once' || ctx.signal?.aborted) {
      return {
        callId: call.id,
        name: call.name,
        isError: true,
        durationMs: performance.now() - start,
        output:
          selection === '__unavailable__'
            ? 'Outside-directory access requires approval, but no human approval channel is available.'
            : 'Outside-directory access was not approved by the user.',
      };
    }
    humanApproved = true;
  }
  // First-party computer tools perform their argument-bound approval inside
  // the cancellable desktop lock. Do not leave a second generic prompt outside Stop.
  if (
    permission.action === 'ask' &&
    !humanApproved &&
    ctx.requestToolApproval &&
    (!tool.name.startsWith('computer_') || tool.name === 'computer_status')
  ) {
    let approved: boolean;
    try {
      approved = await ctx.requestToolApproval(call, permission.reason);
    } catch {
      // A critic review channel that throws has no approver on the other end;
      // treat it the same as a refusal rather than a transport fault.
      approved = false;
    }
    if (!approved || ctx.signal?.aborted || decidePermission().action === 'deny') {
      return {
        callId: call.id,
        name: call.name,
        output: 'Critic action was not approved.',
        isError: true,
        durationMs: performance.now() - start,
      };
    }
    (ctx.approvedToolCallIds ??= new Set()).add(call.id);
  }
  if (
    permission.action === 'ask' &&
    !humanApproved &&
    !ctx.requestToolApproval &&
    ctx.waitForToolApproval &&
    (!tool.name.startsWith('computer_') || tool.name === 'computer_status')
  ) {
    let selection: string;
    try {
      selection = await ctx.waitForToolApproval(
        ctx,
        call,
        approvalQuestion(ctx, call),
        ['Allow once', 'Reject'],
        ctx.signal,
      );
    } catch {
      selection = '__cancelled__';
    }
    if (selection !== 'Allow once') {
      return {
        callId: call.id,
        name: call.name,
        output:
          selection === '__cancelled__' ? 'Tool approval was cancelled.' : 'Tool rejected by user.',
        isError: true,
        durationMs: performance.now() - start,
      };
    }
    (ctx.approvedToolCallIds ??= new Set()).add(call.id);
  }
  if (
    permission.action === 'ask' &&
    !humanApproved &&
    !ctx.requestToolApproval &&
    !ctx.waitForToolApproval &&
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
    // An approval channel that throws (no live turn to park a prompt on) is
    // the same "no approver available" outcome as a missing channel — the
    // tool must return an error result, not fault the transport.
    const selection = await Promise.race([
      ctx.waitForUserInput(
        `${permission.reason}. Allow ${call.name} once?`,
        ['Allow once', 'Reject'],
        { allowOther: false, allowKeepChatting: false },
      ),
      liveRace,
    ]).catch(() => '__unavailable__');
    if (poll) clearInterval(poll);
    if (selection === '__unavailable__') {
      return {
        callId: call.id,
        name: call.name,
        output: `${permission.reason}, but no human approval channel is available.`,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
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
    try {
      const verdict = await ctx.preflightFileChange({ paths, linesChanged: change.linesChanged });
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

  if (isNoteToolName(call.name)) {
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
  let releaseFileScope: (() => void) | undefined;
  try {
    const checkFilePolicy = () => {
      ctx.signal?.throwIfAborted();
      if (ctx.allowedToolNames && !ctx.allowedToolNames.has(call.name))
        throw new Error('Tool is disabled for this turn by the host');
      const current = decidePermission();
      if (current.action === 'deny') throw new Error(current.reason);
      if (current.action === 'ask' && !humanApproved && !ctx.approvedToolCallIds?.has(call.id))
        throw new Error('Current filesystem policy requires fresh approval');
      checkWriteBoundary();
    };
    if (fileScope) {
      checkFilePolicy();
      fileScope.revalidate(ctx);
      // This derived context exists only until this invocation returns. Exact
      // canonical operands accommodate legacy image checks without broad grants.
      ctx = deriveToolContext(ctx, {
        allowedPaths: [...fileScope.accessRoots, fileScope.cwd],
        ...(FILE_MUTATING_TOOLS.has(call.name) ? { requiredWorkspaceRoot: hardWriteRoot() } : {}),
      });
      releaseFileScope = bindFilePathScope(ctx, fileScope, checkFilePolicy);
    }
    const mutationRoot = hardWriteRoot();
    if (mutationRoot && FILE_MUTATING_TOOLS.has(call.name)) {
      // Recheck after approval/preflight awaits. Settings and YOLO may waive
      // prompts, never ownership. Always resolve symlinks, including parents
      // of not-yet-created paths; broad caller allowedPaths are not authority.
      const root = mutationRoot;
      if (
        canonicalizePath(root) !== root ||
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
      // Keep live policy getters and the invocation-bound context intact.
      if (!fileScope) ctx = deriveToolContext(ctx, { allowedPaths: [root] });
    }
    ctx.signal?.throwIfAborted();
    const work = runToolWithEvidenceCache(tool, ctx, call);
    // Bash owns its own abort path: it must return the "command continues"
    // result instead of being raced away as a generic cancelled tool.
    const result =
      FILE_MUTATING_TOOLS.has(call.name) || call.name === 'bash'
        ? await work
        : await raceToolWithAbort(work, ctx.signal);
    result.durationMs = performance.now() - start;
    // A successful workspace mutation this turn blocks a later isolate_chat:
    // uncommitted in-place edits cannot travel to the new copy.
    if (!result.isError && WORKSPACE_MUTATING_TOOLS.has(call.name)) {
      ctx.noteWorkspaceMutation?.();
    }
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
    releaseFileScope?.();
    ctx.approvedToolCallIds?.delete(call.id);
    workspaceLease.release();
  }
}
