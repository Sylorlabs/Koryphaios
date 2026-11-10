// MCP bridge + hooks bridge API routes.
//
// These endpoints let the Kory MCP bridge server (kory-mcp-bridge.ts) and the
// CLI lifecycle hooks (devin/claude/antigravity) proxy tool calls and permission
// decisions back into Koryphaios's ToolRegistry + permission system.
//
// Routes:
//   POST /api/v1/mcp-bridge/catalog  — authenticated role-filtered ToolRegistry metadata
//   POST /api/v1/mcp-bridge/execute  — execute a Kory tool by name
//   POST /api/v1/mcp-bridge/hooks/pre-tool   — PreToolUse hook → approve/block/rewrite
//   POST /api/v1/mcp-bridge/hooks/post-tool  — PostToolUse hook → log + inject context
//   POST /api/v1/mcp-bridge/hooks/permission — PermissionRequest hook → approve/block
//   POST /api/v1/mcp-bridge/hooks/prompt-submit — UserPromptSubmit hook → inject context
//   POST /api/v1/mcp-bridge/hooks/stop       — end a CLI turn; never verifies a Goal
//   POST /api/v1/mcp-bridge/hooks/session-start — SessionStart hook → register
//   POST /api/v1/mcp-bridge/hooks/session-end   — SessionEnd hook → flush

import { Elysia, t } from 'elysia';
import { mcpProjectScope } from '../../mcp/project-scope';
import { ensureProjectMcpServers } from '../../mcp/server-service';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { sessionWorkspaceOwnership } from '../../kory/session-workspace';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { getContext } from '../../context';
import { providerLog, serverLog } from '../../logger';
import type { ToolContext } from '../../tools/registry';
import { waitForToolApproval } from '../../tools/approval-queue';
import { loadAgentSettingsForSession } from '../../agent-settings';
import { withSessionProviderExecutionScope } from '../../providers/execution-scope';
import {
  decideToolPermission,
  resolveSubAgentPermissionPolicy,
  resolveToolPermissionPolicy,
  resolveSandboxOptions,
} from '../../tools/permission-policy';
import {
  checkNoteToolPermission,
  filterToolDefsForNotesPermissions,
  formatNoteToolApprovalSummary,
} from '../../notes/notes-settings';
import { isLocalExecutionTarget, isNoteToolName } from '@koryphaios/shared';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  SessionNotFoundError,
  ValidationError,
} from '../../errors/types';
import {
  verifySignedBridgeRequest,
  type BridgeGrantAudience,
  type VerifiedBridgeGrant,
} from '../../providers/bridge-grant';
import type { SessionToken } from '../../auth/local-auth';
import { safeProviderDiagnostic } from '../../providers/provider-diagnostics';
import {
  antigravityNativeToolEquivalent,
  antigravityNativeToolRedirectReason,
  isAntigravityInternalReadPath,
} from '../../providers/antigravity-permissions';

const NATIVE_TO_KORY: Record<string, string> = {
  read: 'kory__read_file',
  edit: 'kory__edit_file',
  write: 'kory__write_file',
  exec: 'kory__bash',
  Read: 'kory__read_file',
  Edit: 'kory__edit_file',
  Write: 'kory__write_file',
  MultiEdit: 'kory__batch_edit',
  Bash: 'kory__bash',
  Glob: 'kory__glob',
  Grep: 'kory__grep',
  LS: 'kory__ls',
  WebFetch: 'kory__web_fetch',
  WebSearch: 'kory__web_search',
  codex_command: 'kory__bash',
  antigravity_exec: 'kory__bash',
  cursor_tool: 'kory__bash',
};

/** Native tools that only mutate the CLI's own bookkeeping and therefore carry
 *  no host authority. Everything else must route through a `kory__` tool. */
const SAFE_NATIVE_CONTROL_TOOLS = new Set([
  'finish',
  'manage_task',
  'todo_write',
  'todowrite',
  'update_plan',
  'generate_image',
  'generateimage',
  'image_gen',
]);

export function managedNativeToolDecision(
  toolName: string,
  toolInput: Record<string, unknown> = {},
):
  | { decision: 'approve'; reason: string }
  | { decision: 'block'; reason: string; koryEquivalent?: string } {
  const name = toolName.toLowerCase();
  if (name === 'call_mcp_tool') {
    const server = toolInput.ServerName ?? toolInput.serverName ?? toolInput.server_name;
    const tool = toolInput.ToolName ?? toolInput.toolName ?? toolInput.tool_name;
    if (server === 'kory' && typeof tool === 'string' && /^kory__[a-z][a-z0-9_-]*$/.test(tool))
      return {
        decision: 'approve',
        reason:
          'Kory MCP dispatch; the signed bridge enforces tool role, session and permission policy.',
      };
    return {
      decision: 'block',
      reason: 'Managed MCP calls must target a kory__ tool on the kory server.',
    };
  }
  if (
    (name === 'view_file' || name === 'read_file') &&
    isAntigravityInternalReadPath(
      toolInput.AbsolutePath ??
        toolInput.absolute_path ??
        toolInput.Path ??
        toolInput.path ??
        toolInput.file_path,
    )
  ) {
    return {
      decision: 'approve',
      reason: 'Antigravity internal MCP schema and brain artifact inspection',
    };
  }
  // agy names its tools after the step type (`run_command`, `view_file`, …), so
  // its catalog is resolved from its own map rather than the Claude-style
  // spellings below. A missed name still lands on the default-deny tail.
  const antigravity = antigravityNativeToolEquivalent(toolName);
  if (antigravity.kind === 'safe') {
    return { decision: 'approve', reason: 'Provider-local bookkeeping only' };
  }
  if (antigravity.kind === 'delegate') {
    return {
      decision: 'block',
      reason: 'Use kory__delegate_to_worker; Koryphaios owns orchestration.',
    };
  }
  if (antigravity.kind === 'kory') {
    return {
      decision: 'block',
      koryEquivalent: antigravity.kory,
      reason: antigravityNativeToolRedirectReason(toolName, antigravity.kory),
    };
  }
  const koryEquivalent = NATIVE_TO_KORY[toolName] ?? NATIVE_TO_KORY[name];
  if (koryEquivalent)
    return {
      decision: 'block',
      koryEquivalent,
      reason: antigravityNativeToolRedirectReason(toolName, koryEquivalent),
    };
  if (toolName === 'run_subagent' || toolName === 'Task' || toolName === 'Agent')
    return {
      decision: 'block',
      reason: 'Use kory__delegate_to_worker; Koryphaios owns orchestration.',
    };
  if (SAFE_NATIVE_CONTROL_TOOLS.has(name))
    return { decision: 'approve', reason: 'Provider-local bookkeeping only' };
  return {
    decision: 'block',
    reason: `Unknown native tool ${toolName} is blocked in managed mode. Use a kory__ MCP tool.`,
  };
}

type BridgeRouteAuth =
  { kind: 'signed'; grant: VerifiedBridgeGrant } | { kind: 'local'; session: SessionToken };

function authenticateBridgeRoute(
  request: Request,
  set: { status?: number | string },
  body: unknown,
  audience: BridgeGrantAudience,
): BridgeRouteAuth | null {
  const grant = verifySignedBridgeRequest(
    request.headers,
    audience,
    request.method,
    new URL(request.url).pathname,
    body,
  );
  if (grant) return { kind: 'signed', grant };
  const session = requireLocalRouteAuth(request, set);
  return session ? { kind: 'local', session } : null;
}

function scopedCliRole(auth: BridgeRouteAuth, sessionId: string): string | null {
  if (auth.kind === 'signed') {
    return auth.grant.sessionId === sessionId ? auth.grant.role : null;
  }
  const prefix = `mcp:${sessionId}:`;
  return (
    auth.session.permissions
      .find((permission) => permission.startsWith(prefix))
      ?.slice(prefix.length) ?? (auth.session.permissions.includes('*') ? 'manager' : null)
  );
}

function hasBridgeRole(auth: BridgeRouteAuth, sessionId: string, role: string): boolean {
  if (auth.kind === 'signed') {
    return auth.grant.sessionId === sessionId && auth.grant.role === role;
  }
  return localAuth.hasPermission(auth.session, `mcp:${sessionId}:${role}`);
}

function requireLocalMcpTarget(auth: BridgeRouteAuth, target: unknown): void {
  const backendId = process.env.KORY_BACKEND_ID?.trim() || 'local';
  // Signed bridge grants are minted by this backend and are the only current
  // MCP transport. Requiring the target on that path prevents a caller from
  // turning a local ToolRegistry grant into an implied linked/remote transport.
  if (target === undefined && auth.kind === 'signed')
    throw new ValidationError('A local MCP execution target is required');
  if (target !== undefined && !isLocalExecutionTarget(target, backendId))
    throw new AuthorizationError('MCP bridge only accepts this backend as a local target');
}

async function requireActiveBridgeSession(sessionId: string) {
  const { sessions } = getContext();
  const session = await sessions.getActive(sessionId);
  if (session) return session;
  if (await sessions.get(sessionId)) {
    throw new ConflictError('Recover this archived chat before using its CLI bridge.');
  }
  throw new SessionNotFoundError(sessionId);
}

export const mcpBridgeRoutes = new Elysia({ prefix: '/api/v1/mcp-bridge' })

  // ── Authoritative tool catalog (called by the MCP bridge server) ──
  .post(
    '/catalog',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'mcp');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { sessionId, role, target } = body as {
        sessionId: string;
        role: string;
        target?: unknown;
      };
      if (!sessionId) throw new ValidationError('sessionId is required');
      if (role !== 'manager' && role !== 'worker' && role !== 'critic' && role !== 'coder') {
        throw new ValidationError('A valid CLI role is required');
      }
      if (!hasBridgeRole(auth, sessionId, role)) {
        throw new AuthorizationError('The CLI capability is not scoped to this session and role');
      }
      requireLocalMcpTarget(auth, target);
      const { tools } = getContext();
      const session = await requireActiveBridgeSession(sessionId);
      const root = mcpProjectScope(
        session.gitWorkspace?.repositoryPath ?? session.workingDirectory ?? process.cwd(),
      );
      await ensureProjectMcpServers(root);

      return {
        ok: true,
        tools: filterToolDefsForNotesPermissions(tools.getToolDefsForRole(role, root), root).map(
          (tool) => ({
            ...tool,
            name: `kory__${tool.name}`,
          }),
        ),
      };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        role: t.String(),
        target: t.Optional(t.Unknown()),
      }),
    },
  )

  // ── Execute a Kory tool by name (called by the MCP bridge server) ────────
  .post(
    '/execute',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'mcp');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const {
        sessionId,
        toolName: rawToolName,
        input,
        role,
        workingDirectory,
        target,
      } = body as {
        sessionId: string;
        toolName: string;
        input: Record<string, unknown>;
        role?: string;
        workingDirectory?: string;
        target?: unknown;
      };
      const toolName = rawToolName?.replace(/^kory__/, '') ?? '';
      if (!sessionId || !toolName) {
        throw new ValidationError('sessionId and toolName are required');
      }
      const { tools, goals, kory } = getContext();
      const managerOwnsLifecycle = kory.hasActiveSessionExecution(sessionId);
      const bridgeLease = managerOwnsLifecycle
        ? null
        : kory.tryAcquireSessionMutationBarrier(sessionId);
      if (!managerOwnsLifecycle && !bridgeLease) {
        throw new ConflictError(
          'Wait for chat lifecycle work to finish before using its CLI bridge.',
        );
      }
      try {
        const session = await requireActiveBridgeSession(sessionId);
        if (role !== 'manager' && role !== 'worker' && role !== 'critic' && role !== 'coder') {
          throw new ValidationError('A valid CLI role is required');
        }
        if (!hasBridgeRole(auth, sessionId, role)) {
          throw new AuthorizationError('The CLI capability is not scoped to this session and role');
        }
        requireLocalMcpTarget(auth, target);
        const normalizedRole = role;
        const settingsRoot = mcpProjectScope(
          session.gitWorkspace?.repositoryPath ?? session.workingDirectory ?? process.cwd(),
        );
        if (!tools.isAllowedForRole(toolName, normalizedRole, settingsRoot)) {
          throw new AuthorizationError(`${normalizedRole} is not allowed to call ${toolName}`);
        }
        const executionSignal =
          auth.kind === 'signed'
            ? AbortSignal.any([request.signal, auth.grant.signal])
            : request.signal;
        if (normalizedRole === 'critic') {
          if (auth.kind !== 'signed' || !auth.grant.workspaceRoot)
            throw new AuthorizationError('Critic calls require an active host-bound review grant');
          const result = await withSessionProviderExecutionScope(sessionId, () =>
            kory.executeCriticBridgeTool(
              sessionId,
              auth.grant.workspaceRoot!,
              {
                id: `critic-bridge-${crypto.randomUUID()}`,
                name: toolName,
                input,
              },
              executionSignal,
            ),
          );
          return {
            ok: true,
            output: result.output,
            isError: result.isError,
            durationMs: result.durationMs,
            ...(result.images && !result.isError ? { images: result.images } : {}),
          };
        }
        const activeGoal = (await goals.list()).find(
          (goal) =>
            goal.execution?.sessionId === sessionId &&
            (goal.status === 'queued' || goal.status === 'planning' || goal.status === 'running'),
        );
        const activeGoalItem = activeGoal?.checklist.find((item) => item.status === 'running');
        // The authenticated session owns the workspace and its saved policy —
        // including its own approval preset, so a CLI driving a YOLO chat does
        // not inherit another chat's guarded posture (or the reverse).
        const chatRoot = await kory.resolveSessionWorkingDirectoryPublic(sessionId);
        let root = chatRoot;
        if (auth.kind === 'signed' && auth.grant.workspaceRoot) {
          let granted: string;
          let canonicalChatRoot: string;
          try {
            granted = realpathSync(auth.grant.workspaceRoot);
            canonicalChatRoot = realpathSync(chatRoot);
          } catch {
            throw new AuthorizationError('CLI workspace grant does not belong to this chat');
          }
          const chatOwner = sessionWorkspaceOwnership(canonicalChatRoot);
          const grantOwner = sessionWorkspaceOwnership(granted);
          if (chatOwner) {
            if (!grantOwner || chatOwner.checkout !== grantOwner.checkout) {
              throw new AuthorizationError('CLI workspace grant does not belong to this chat');
            }
          } else {
            const rel = relative(canonicalChatRoot, granted);
            if (
              grantOwner ||
              (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
            ) {
              throw new AuthorizationError('CLI workspace grant does not belong to this chat');
            }
          }
          root = granted;
        } else if (
          sessionWorkspaceOwnership(chatRoot) &&
          (normalizedRole === 'worker' || normalizedRole === 'coder')
        ) {
          throw new AuthorizationError('Worker CLI calls require a host-bound workspace grant');
        }
        const mcpSettings = loadAgentSettingsForSession(root, sessionId);
        const permissionPolicy =
          normalizedRole === 'worker' && session.interactionMode !== 'plan'
            ? resolveSubAgentPermissionPolicy(mcpSettings, mcpSettings.subAgentApproval)
            : resolveToolPermissionPolicy(
                mcpSettings,
                session.interactionMode === 'plan' ? 'plan' : 'act',
              );
        const mcpNaturalSandboxed = permissionPolicy.mode !== 'yolo';
        if (isNoteToolName(toolName)) {
          const notePermission = checkNoteToolPermission(toolName, root, {
            mode: permissionPolicy.mode,
          });
          if (!notePermission.allowed) {
            throw new AuthorizationError(`${normalizedRole} is not allowed to call ${toolName}`);
          }
          // ToolRegistry owns Notes approval and the single-use receipt.
        }
        const ctx: ToolContext = {
          sessionId,
          agentId: `mcp-bridge:${normalizedRole}`,
          callerRole: normalizedRole,
          ...(activeGoal ? { goalId: activeGoal.id } : {}),
          ...(activeGoalItem ? { goalItemId: activeGoalItem.id } : {}),
          workingDirectory: root,
          settingsRoot,
          requiredWorkspaceRoot: sessionWorkspaceOwnership(root)
            ? normalizedRole === 'manager'
              ? sessionWorkspaceOwnership(root)!.checkout
              : root
            : undefined,
          // Native calls must not outlive a disconnected/timed-out bridge request
          // or a revoked turn grant when the user stops the session.
          signal: toolName.startsWith('computer_')
            ? AbortSignal.any([executionSignal, AbortSignal.timeout(25_000)])
            : executionSignal,
          isSandboxed: mcpNaturalSandboxed,
          sandboxOptions: resolveSandboxOptions(mcpSettings, mcpNaturalSandboxed),
          permissionPolicy,
          approvedToolCallIds: new Set(),
          ...(normalizedRole === 'manager'
            ? {
                renameSession: (title: string) => kory.renameSession(sessionId, title),
                delegateToWorker: (
                  task: string,
                  domain?: string,
                  skills?: import('../../kory/skill-assignment').SkillAssignment,
                  workerModel?: string,
                  reasoningLevel?: string,
                ) =>
                  kory.runWorkerPipeline(
                    sessionId,
                    task,
                    undefined,
                    reasoningLevel,
                    domain,
                    skills,
                    workerModel,
                  ),
              }
            : {}),
          waitForUserInput: (question, options, opts) =>
            kory.requestToolApproval(sessionId, question, options, opts),
          ...(normalizedRole === 'worker' &&
          !(mcpSettings.subAgentApproval === 'manager' && mcpSettings.permissionMode === 'guarded')
            ? { waitForToolApproval }
            : {}),
          recordChange: (change) => {
            kory.recordChange?.(sessionId, change);
          },
        };
        const result = await withSessionProviderExecutionScope(sessionId, () =>
          tools.execute(ctx, {
            id: `mcp-bridge-${Date.now()}`,
            name: toolName,
            input,
          }),
        );
        return {
          ok: true,
          output: result.output,
          ...(result.images && !result.isError ? { images: result.images } : {}),
          isError: result.isError,
          durationMs: result.durationMs,
        };
      } finally {
        bridgeLease?.release();
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        toolName: t.String(),
        input: t.Record(t.String(), t.Unknown()),
        role: t.Optional(t.String()),
        workingDirectory: t.Optional(t.String()),
        target: t.Optional(t.Unknown()),
      }),
    },
  )

  // ── PreToolUse hook: approve/block/rewrite a CLI tool call ──────────────
  .post(
    '/hooks/pre-tool',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { session_id, tool_name, tool_input } = body as {
        session_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
      };
      try {
        const { kory, sessions } = getContext();
        const session = await sessions.getActive(session_id);
        if (!session) {
          return {
            decision: 'block' as const,
            reason: 'Kory chat is missing or archived; recover it before using CLI tools',
          };
        }
        const role = scopedCliRole(auth, session_id);
        if (!role)
          return {
            decision: 'block' as const,
            reason: 'CLI capability is not scoped to this session',
          };
        const decision = managedNativeToolDecision(tool_name, tool_input);
        // Route native CLI tool calls through Kory's permission system.
        // If the tool is one Kory can handle (read, write, exec, etc.), block
        // the native call and tell the CLI to use the kory__ equivalent instead.
        if (decision.decision === 'block') {
          // agy only reads `reason` from a PreToolUse verdict — it has no
          // `hookSpecificOutput` — so the redirect has to be in the reason for
          // the agent to recover instead of retrying a denied tool.
          const redirect = decision.reason;
          return {
            decision: 'block' as const,
            reason: redirect,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: redirect,
            },
          };
        }
        // Block native subagent spawning — route through kory__delegate_to_worker.
        return { decision: 'approve' as const, reason: decision.reason };
      } catch (err: unknown) {
        // Fail closed: if the permission check itself errors, block the tool call
        // rather than potentially allowing an unauthorized operation.
        serverLog.error(
          {
            ...safeProviderDiagnostic('cli-bridge', 'configuration', err),
            toolName: tool_name,
            sessionId: session_id,
          },
          'PreToolUse hook failed',
        );
        return { decision: 'block' as const, reason: 'Kory permission check failed closed' };
      }
    },
    {
      body: t.Object({
        session_id: t.String(),
        tool_name: t.String(),
        tool_input: t.Record(t.String(), t.Unknown()),
      }),
    },
  )

  // ── PostToolUse hook: log the tool execution ────────────────────────────
  .post(
    '/hooks/post-tool',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) return { ok: false, error: 'Unauthorized' };
      const { session_id, tool_name, tool_response } = body as {
        session_id: string;
        tool_name: string;
        tool_response?: { success?: boolean; output?: string; error?: string };
      };
      if (!scopedCliRole(auth, session_id)) return { ok: false, error: 'Unauthorized' };
      try {
        providerLog.debug(
          { sessionId: session_id, toolName: tool_name, success: tool_response?.success },
          'CLI tool execution logged via PostToolUse hook',
        );
        return { ok: true };
      } catch (err: unknown) {
        // Expected: logging is best-effort; failure to log must not break the hook response.
        serverLog.debug(
          safeProviderDiagnostic('cli-bridge', 'configuration', err),
          'PostToolUse hook logging failed',
        );
        return { ok: true };
      }
    },
    {
      body: t.Object({
        session_id: t.String(),
        tool_name: t.String(),
        tool_response: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )

  // ── PermissionRequest hook: route to Kory's permission system ───────────
  .post(
    '/hooks/permission',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) return { ok: false, error: 'Unauthorized' };
      const { session_id, tool_name, tool_input } = body as {
        session_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
      };
      const { sessions } = getContext();
      const session = await sessions.getActive(session_id);
      if (!session) {
        return {
          decision: 'block' as const,
          reason: 'Kory chat is missing or archived; recover it before using CLI tools',
        };
      }
      const role = scopedCliRole(auth, session_id);
      if (!role)
        return {
          decision: 'block' as const,
          reason: 'CLI capability is not scoped to this session',
        };
      return managedNativeToolDecision(tool_name, tool_input);
    },
    {
      body: t.Object({
        session_id: t.String(),
        tool_name: t.String(),
        tool_input: t.Record(t.String(), t.Unknown()),
      }),
    },
  )

  // ── UserPromptSubmit hook: inject Kory context (notes, smart-context) ───
  .post(
    '/hooks/prompt-submit',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) return { ok: false, error: 'Unauthorized' };
      const { session_id } = body as { session_id: string };
      if (!scopedCliRole(auth, session_id)) return { ok: false, error: 'Unauthorized' };
      try {
        const { kory, sessions } = getContext();
        const session = await sessions.getActive(session_id);
        if (!session) return { ok: true, additionalContext: '' };
        // Build the Kory context injection: notes network hint + smart context.
        // The KoryManager already assembles this for managed providers; here we
        // surface it to the CLI via the hook's additionalContext channel.
        const contextHint = await kory.buildContextInjection?.(session_id);
        return { ok: true, additionalContext: contextHint ?? '' };
      } catch (err: unknown) {
        // Expected: context injection is best-effort; failure degrades to empty context.
        serverLog.debug(
          safeProviderDiagnostic('cli-bridge', 'configuration', err),
          'UserPromptSubmit context injection failed',
        );
        return { ok: true, additionalContext: '' };
      }
    },
    { body: t.Object({ session_id: t.String() }) },
  )

  // ── Stop hook: lifecycle boundary, separate from Goal verification ─────
  .post(
    '/hooks/stop',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { session_id } = body as { session_id: string };
      if (!scopedCliRole(auth, session_id)) throw new AuthorizationError('Unauthorized');
      try {
        const { kory } = getContext();
        const mayEndTurn = await kory.cliHarnessMayEndTurn?.(session_id);
        if (mayEndTurn === false) {
          return {
            decision: 'block' as const,
            reason:
              'Koryphaios is still coordinating this CLI turn. Goal completion is verified separately.',
          };
        }
        return { decision: 'approve' as const };
      } catch (err: unknown) {
        // Turn termination fails open so cancellation cannot be trapped. This
        // endpoint never completes or verifies a Goal.
        serverLog.debug(
          {
            ...safeProviderDiagnostic('cli-bridge', 'configuration', err),
            sessionId: session_id,
          },
          'CLI turn-end check failed, allowing harness to stop',
        );
        return { decision: 'approve' as const };
      }
    },
    { body: t.Object({ session_id: t.String() }) },
  )

  // ── SessionStart hook: register the CLI session ─────────────────────────
  .post(
    '/hooks/session-start',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { session_id } = body as { session_id: string };
      if (!scopedCliRole(auth, session_id)) throw new AuthorizationError('Unauthorized');
      await requireActiveBridgeSession(session_id);
      providerLog.info({ sessionId: session_id }, 'CLI session started via hook');
      return { ok: true };
    },
    { body: t.Object({ session_id: t.String() }) },
  )

  // ── SessionEnd hook: flush ───────────────────────────────────────────────
  .post(
    '/hooks/session-end',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'hook');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { session_id } = body as { session_id: string };
      if (!scopedCliRole(auth, session_id)) throw new AuthorizationError('Unauthorized');
      providerLog.info({ sessionId: session_id }, 'CLI session ended via hook');
      return { ok: true };
    },
    { body: t.Object({ session_id: t.String() }) },
  );
