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
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { getContext } from '../../context';
import { providerLog, serverLog } from '../../logger';
import type { ToolContext } from '../../tools/registry';
import { loadAgentSettings } from '../../agent-settings';
import { resolveToolPermissionPolicy, resolveSandboxOptions } from '../../tools/permission-policy';
import {
  AuthenticationError,
  AuthorizationError,
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

const SAFE_NATIVE_CONTROL_TOOLS = new Set([
  'finish',
  'manage_task',
  'todo_write',
  'todowrite',
  'update_plan',
]);

export function managedNativeToolDecision(
  toolName: string,
):
  | { decision: 'approve'; reason: string }
  | { decision: 'block'; reason: string; koryEquivalent?: string } {
  const koryEquivalent = NATIVE_TO_KORY[toolName];
  if (koryEquivalent)
    return {
      decision: 'block',
      koryEquivalent,
      reason: `Use ${koryEquivalent}; Koryphaios owns host tool execution.`,
    };
  if (toolName === 'run_subagent' || toolName === 'Task' || toolName === 'Agent')
    return {
      decision: 'block',
      reason: 'Use kory__delegate_to_worker; Koryphaios owns orchestration.',
    };
  if (SAFE_NATIVE_CONTROL_TOOLS.has(toolName.toLowerCase()))
    return { decision: 'approve', reason: 'Provider-local bookkeeping only' };
  return {
    decision: 'block',
    reason: `Unknown native tool ${toolName} is blocked in managed mode. Use a kory__ MCP tool.`,
  };
}

type BridgeRouteAuth =
  | { kind: 'signed'; grant: VerifiedBridgeGrant }
  | { kind: 'local'; session: SessionToken };

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
    auth.session.permissions.find((permission) => permission.startsWith(prefix))?.slice(prefix.length) ??
    (auth.session.permissions.includes('*') ? 'manager' : null)
  );
}

function hasBridgeRole(auth: BridgeRouteAuth, sessionId: string, role: string): boolean {
  if (auth.kind === 'signed') {
    return auth.grant.sessionId === sessionId && auth.grant.role === role;
  }
  return localAuth.hasPermission(auth.session, `mcp:${sessionId}:${role}`);
}

export const mcpBridgeRoutes = new Elysia({ prefix: '/api/v1/mcp-bridge' })

  // ── Authoritative tool catalog (called by the MCP bridge server) ──
  .post(
    '/catalog',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'mcp');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { sessionId, role } = body as { sessionId: string; role: string };
      if (!sessionId) throw new ValidationError('sessionId is required');
      if (role !== 'manager' && role !== 'worker' && role !== 'critic' && role !== 'coder') {
        throw new ValidationError('A valid CLI role is required');
      }
      if (!hasBridgeRole(auth, sessionId, role)) {
        throw new AuthorizationError('The CLI capability is not scoped to this session and role');
      }
      const { tools, sessions } = getContext();
      if (!(await sessions.get(sessionId))) throw new SessionNotFoundError(sessionId);

      return {
        ok: true,
        tools: tools.getToolDefsForRole(role).map((tool) => ({
          ...tool,
          name: `kory__${tool.name}`,
        })),
      };
    },
    { body: t.Object({ sessionId: t.String(), role: t.String() }) },
  )

  // ── Execute a Kory tool by name (called by the MCP bridge server) ────────
  .post(
    '/execute',
    async ({ request, body, set }) => {
      const auth = authenticateBridgeRoute(request, set, body, 'mcp');
      if (!auth) throw new AuthenticationError('Unauthorized');
      const { sessionId, toolName, input, role, workingDirectory } = body as {
        sessionId: string;
        toolName: string;
        input: Record<string, unknown>;
        role?: string;
        workingDirectory?: string;
      };
      if (!sessionId || !toolName) {
        throw new ValidationError('sessionId and toolName are required');
      }
      const { tools, sessions, goals, kory } = getContext();
      const session = await sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }
      if (role !== 'manager' && role !== 'worker' && role !== 'critic' && role !== 'coder') {
        throw new ValidationError('A valid CLI role is required');
      }
      if (!hasBridgeRole(auth, sessionId, role)) {
        throw new AuthorizationError('The CLI capability is not scoped to this session and role');
      }
      const normalizedRole = role;
      if (!tools.isAllowedForRole(toolName, normalizedRole)) {
        throw new AuthorizationError(`${normalizedRole} is not allowed to call ${toolName}`);
      }
      const activeGoal = (await goals.list()).find(
        (goal) =>
          goal.execution?.sessionId === sessionId &&
          (goal.status === 'queued' || goal.status === 'planning' || goal.status === 'running'),
      );
      const activeGoalItem = activeGoal?.checklist.find((item) => item.status === 'running');
      // The authenticated session owns the workspace and its saved policy.
      const root = session.workingDirectory || workingDirectory || process.cwd();
      const mcpSettings = loadAgentSettings(root);
      const permissionPolicy = resolveToolPermissionPolicy(
        mcpSettings,
        normalizedRole === 'critic' ? 'plan' : 'act',
      );
      const mcpNaturalSandboxed = normalizedRole === 'critic' || permissionPolicy.mode !== 'yolo';
      const ctx: ToolContext = {
        sessionId,
        ...(activeGoal ? { goalId: activeGoal.id } : {}),
        ...(activeGoalItem ? { goalItemId: activeGoalItem.id } : {}),
        workingDirectory: root,
        signal: undefined,
        isSandboxed: mcpNaturalSandboxed,
        sandboxOptions: resolveSandboxOptions(mcpSettings, mcpNaturalSandboxed),
        permissionPolicy,
        approvedToolCallIds: new Set(),
        waitForUserInput: (question, options, opts) =>
          kory.requestToolApproval(sessionId, question, options, opts),
        recordChange: (change) => {
          kory.recordChange?.(sessionId, change);
        },
      };
      const result = await tools.execute(ctx, {
        id: `mcp-bridge-${Date.now()}`,
        name: toolName,
        input,
      });
      return {
        ok: true,
        output: result.output,
        isError: result.isError,
        durationMs: result.durationMs,
      };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        toolName: t.String(),
        input: t.Record(t.String(), t.Unknown()),
        role: t.Optional(t.String()),
        workingDirectory: t.Optional(t.String()),
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
        const session = await sessions.get(session_id);
        if (!session) return { decision: 'block' as const, reason: 'Kory session not found' };
        const role = scopedCliRole(auth, session_id);
        if (!role)
          return { decision: 'block' as const, reason: 'CLI capability is not scoped to this session' };
        const decision = managedNativeToolDecision(tool_name);
        // Route native CLI tool calls through Kory's permission system.
        // If the tool is one Kory can handle (read, write, exec, etc.), block
        // the native call and tell the CLI to use the kory__ equivalent instead.
        if (decision.decision === 'block') {
          return {
            decision: 'block' as const,
            reason: decision.reason,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: decision.koryEquivalent
                ? `Call ${decision.koryEquivalent} via the kory MCP server instead.`
                : decision.reason,
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
      const session = await sessions.get(session_id);
      if (!session) return { decision: 'block' as const, reason: 'Kory session not found' };
      const role = scopedCliRole(auth, session_id);
      if (!role)
        return { decision: 'block' as const, reason: 'CLI capability is not scoped to this session' };
      return managedNativeToolDecision(tool_name);
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
        const session = await sessions.get(session_id);
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
      providerLog.info({ sessionId: session_id }, 'CLI session started via hook');
      return { ok: true };
    },
    { body: t.Object({ session_id: t.String() }) },
  )

  // ── SessionEnd hook: flush ──────────────────────────────────────────────
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
