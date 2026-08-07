// MCP bridge + hooks bridge API routes.
//
// These endpoints let the Kory MCP bridge server (kory-mcp-bridge.ts) and the
// CLI lifecycle hooks (devin/claude/antigravity) proxy tool calls and permission
// decisions back into Koryphaios's ToolRegistry + permission system.
//
// Routes:
//   POST /api/v1/mcp-bridge/execute  — execute a Kory tool by name
//   POST /api/v1/mcp-bridge/hooks/pre-tool   — PreToolUse hook → approve/block/rewrite
//   POST /api/v1/mcp-bridge/hooks/post-tool  — PostToolUse hook → log + inject context
//   POST /api/v1/mcp-bridge/hooks/permission — PermissionRequest hook → approve/block
//   POST /api/v1/mcp-bridge/hooks/prompt-submit — UserPromptSubmit hook → inject context
//   POST /api/v1/mcp-bridge/hooks/stop       — Stop hook → block if critic says fail
//   POST /api/v1/mcp-bridge/hooks/session-start — SessionStart hook → register
//   POST /api/v1/mcp-bridge/hooks/session-end   — SessionEnd hook → flush

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { getContext } from '../../context';
import { providerLog, serverLog } from '../../logger';
import type { ToolContext } from '../../tools/registry';
import { loadAgentSettings } from '../../agent-settings';
import { resolveToolPermissionPolicy } from '../../tools/permission-policy';
import { AuthenticationError, AuthorizationError, SessionNotFoundError, ValidationError } from '../../errors/types';

const NATIVE_TO_KORY: Record<string, string> = {
  read: 'kory__read_file', edit: 'kory__edit_file', write: 'kory__write_file', exec: 'kory__bash',
  Read: 'kory__read_file', Edit: 'kory__edit_file', Write: 'kory__write_file', MultiEdit: 'kory__batch_edit',
  Bash: 'kory__bash', Glob: 'kory__glob', Grep: 'kory__grep', LS: 'kory__ls',
  WebFetch: 'kory__web_fetch', WebSearch: 'kory__web_search', codex_command: 'kory__bash',
  antigravity_exec: 'kory__bash', cursor_tool: 'kory__bash',
};

const SAFE_NATIVE_CONTROL_TOOLS = new Set(['finish', 'manage_task', 'todo_write', 'todowrite', 'update_plan']);

export function managedNativeToolDecision(toolName: string):
  | { decision: 'approve'; reason: string }
  | { decision: 'block'; reason: string; koryEquivalent?: string } {
  const koryEquivalent = NATIVE_TO_KORY[toolName];
  if (koryEquivalent) return { decision: 'block', koryEquivalent, reason: `Use ${koryEquivalent}; Koryphaios owns host tool execution.` };
  if (toolName === 'run_subagent' || toolName === 'Task' || toolName === 'Agent') return { decision: 'block', reason: 'Use kory__delegate_to_worker; Koryphaios owns orchestration.' };
  if (SAFE_NATIVE_CONTROL_TOOLS.has(toolName.toLowerCase())) return { decision: 'approve', reason: 'Provider-local bookkeeping only' };
  return { decision: 'block', reason: `Unknown native tool ${toolName} is blocked in managed mode. Use a kory__ MCP tool.` };
}

function scopedCliRole(auth: { permissions: string[] }, sessionId: string): string | null {
  const prefix = `mcp:${sessionId}:`;
  return auth.permissions.find((permission) => permission.startsWith(prefix))?.slice(prefix.length) ??
    (auth.permissions.includes('*') ? 'manager' : null);
}

export const mcpBridgeRoutes = new Elysia({ prefix: '/api/v1/mcp-bridge' })

  // ── Execute a Kory tool by name (called by the MCP bridge server) ────────
  .post('/execute', async ({ request, body, set }) => {
    const auth = requireLocalRouteAuth(request, set);
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
    if (!localAuth.hasPermission(auth, `mcp:${sessionId}:${role}`)) {
      throw new AuthorizationError('The CLI bearer is not scoped to this session and role');
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
    const permissionPolicy = resolveToolPermissionPolicy(
      loadAgentSettings(root),
      normalizedRole === 'critic' ? 'plan' : 'act',
    );
    const ctx: ToolContext = {
      sessionId,
      ...(activeGoal ? { goalId: activeGoal.id } : {}),
      ...(activeGoalItem ? { goalItemId: activeGoalItem.id } : {}),
      workingDirectory: root,
      signal: undefined,
      isSandboxed: normalizedRole === 'critic' || permissionPolicy.mode !== 'yolo',
      permissionPolicy,
      approvedToolCallIds: new Set(),
      waitForUserInput: (question, options) => kory.requestToolApproval(sessionId, question, options),
      recordChange: (change) => {
        kory.recordChange?.(sessionId, change);
      },
    };
    const result = await tools.execute(ctx, {
      id: `mcp-bridge-${Date.now()}`,
      name: toolName,
      input,
    });
    return { ok: true, output: result.output, isError: result.isError, durationMs: result.durationMs };
  }, { body: t.Object({ sessionId: t.String(), toolName: t.String(), input: t.Record(t.String(), t.Unknown()), role: t.Optional(t.String()), workingDirectory: t.Optional(t.String()) }) })

  // ── PreToolUse hook: approve/block/rewrite a CLI tool call ──────────────
  .post('/hooks/pre-tool', async ({ request, body, set }) => {
    const auth = requireLocalRouteAuth(request, set);
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
      if (!role) return { decision: 'block' as const, reason: 'CLI bearer is not scoped to this session' };
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
            additionalContext: decision.koryEquivalent ? `Call ${decision.koryEquivalent} via the kory MCP server instead.` : decision.reason,
          },
        };
      }
      // Block native subagent spawning — route through kory__delegate_to_worker.
      return { decision: 'approve' as const, reason: decision.reason };
    } catch (err: unknown) {
      // Fail closed: if the permission check itself errors, block the tool call
      // rather than potentially allowing an unauthorized operation.
      serverLog.error(
        { err: err instanceof Error ? err : String(err), tool_name, session_id },
        'PreToolUse hook failed',
      );
      return { decision: 'block' as const, reason: 'Kory permission check failed closed' };
    }
  }, { body: t.Object({ session_id: t.String(), tool_name: t.String(), tool_input: t.Record(t.String(), t.Unknown()) }) })

  // ── PostToolUse hook: log the tool execution ────────────────────────────
  .post('/hooks/post-tool', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { session_id, tool_name, tool_response } = body as {
      session_id: string;
      tool_name: string;
      tool_response?: { success?: boolean; output?: string; error?: string };
    };
    try {
      providerLog.debug(
        { sessionId: session_id, toolName: tool_name, success: tool_response?.success },
        'CLI tool execution logged via PostToolUse hook',
      );
      return { ok: true };
    } catch (err: unknown) {
      // Expected: logging is best-effort; failure to log must not break the hook response.
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'PostToolUse hook logging failed');
      return { ok: true };
    }
  }, { body: t.Object({ session_id: t.String(), tool_name: t.String(), tool_response: t.Optional(t.Record(t.String(), t.Unknown())) }) })

  // ── PermissionRequest hook: route to Kory's permission system ───────────
  .post('/hooks/permission', async ({ request, body, set }) => {
    const auth = requireLocalRouteAuth(request, set);
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
    if (!role) return { decision: 'block' as const, reason: 'CLI bearer is not scoped to this session' };
    return managedNativeToolDecision(tool_name);
  }, { body: t.Object({ session_id: t.String(), tool_name: t.String(), tool_input: t.Record(t.String(), t.Unknown()) }) })

  // ── UserPromptSubmit hook: inject Kory context (notes, smart-context) ───
  .post('/hooks/prompt-submit', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { session_id } = body as { session_id: string };
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
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'UserPromptSubmit context injection failed');
      return { ok: true, additionalContext: '' };
    }
  }, { body: t.Object({ session_id: t.String() }) })

  // ── Stop hook: let the critic gate decide if the CLI may stop ───────────
  .post('/hooks/stop', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const { session_id } = body as { session_id: string };
    try {
      const { kory } = getContext();
      const mayStop = await kory.criticGateMayStop?.(session_id);
      if (mayStop === false) {
        return {
          decision: 'block' as const,
          reason: 'The Koryphaios critic has not verified the work as complete. Continue working.',
        };
      }
      return { decision: 'approve' as const };
    } catch (err: unknown) {
      // Fail open: if the critic gate check itself errors, allow the CLI to stop
      // rather than trapping the user in a session they can't exit.
      serverLog.debug(
        { err: err instanceof Error ? err : String(err), session_id },
        'Critic gate check failed, allowing stop',
      );
      return { decision: 'approve' as const };
    }
  }, { body: t.Object({ session_id: t.String() }) })

  // ── SessionStart hook: register the CLI session ─────────────────────────
  .post('/hooks/session-start', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const { session_id } = body as { session_id: string };
    providerLog.info({ sessionId: session_id }, 'CLI session started via hook');
    return { ok: true };
  }, { body: t.Object({ session_id: t.String() }) })

  // ── SessionEnd hook: flush ──────────────────────────────────────────────
  .post('/hooks/session-end', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const { session_id } = body as { session_id: string };
    providerLog.info({ sessionId: session_id }, 'CLI session ended via hook');
    return { ok: true };
  }, { body: t.Object({ session_id: t.String() }) });
