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
import { providerLog } from '../../logger';
import type { ToolContext } from '../../tools/registry';
import { loadAgentSettings } from '../../agent-settings';
import { resolveToolPermissionPolicy } from '../../tools/permission-policy';

const NATIVE_TO_KORY: Record<string, string> = {
  read: 'kory__read_file', edit: 'kory__edit_file', write: 'kory__write_file', exec: 'kory__bash',
  Read: 'kory__read_file', Edit: 'kory__edit_file', Write: 'kory__write_file', MultiEdit: 'kory__batch_edit',
  Bash: 'kory__bash', Glob: 'kory__glob', Grep: 'kory__grep', LS: 'kory__ls',
  WebFetch: 'kory__web_fetch', WebSearch: 'kory__web_search', codex_command: 'kory__bash',
  antigravity_exec: 'kory__bash', cursor_tool: 'kory__bash',
};

function scopedCliRole(auth: { permissions: string[] }, sessionId: string): string | null {
  const prefix = `mcp:${sessionId}:`;
  return auth.permissions.find((permission) => permission.startsWith(prefix))?.slice(prefix.length) ??
    (auth.permissions.includes('*') ? 'manager' : null);
}

export const mcpBridgeRoutes = new Elysia({ prefix: '/api/v1/mcp-bridge' })

  // ── Execute a Kory tool by name (called by the MCP bridge server) ────────
  .post('/execute', async ({ request, body, set }) => {
    const auth = requireLocalRouteAuth(request, set);
    if (!auth) return { ok: false, error: 'Unauthorized' };
    const { sessionId, toolName, input, role, workingDirectory } = body as {
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
      role?: string;
      workingDirectory?: string;
    };
    if (!sessionId || !toolName) {
      set.status = 400;
      return { ok: false, error: 'sessionId and toolName are required' };
    }
    try {
      const { tools, sessions, goals, kory } = getContext();
      const session = await sessions.get(sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: `Session ${sessionId} not found` };
      }
      if (role !== 'manager' && role !== 'worker' && role !== 'critic' && role !== 'coder') {
        set.status = 400;
        return { ok: false, error: 'A valid CLI role is required' };
      }
      if (!localAuth.hasPermission(auth, `mcp:${sessionId}:${role}`)) {
        set.status = 403;
        return { ok: false, error: 'The CLI bearer is not scoped to this session and role' };
      }
      const normalizedRole = role;
      if (!tools.isAllowedForRole(toolName, normalizedRole)) {
        set.status = 403;
        return { ok: false, error: `${normalizedRole} is not allowed to call ${toolName}` };
      }
      const activeGoal = (await goals.list()).find(
        (goal) =>
          goal.execution?.sessionId === sessionId &&
          (goal.status === 'queued' || goal.status === 'planning' || goal.status === 'running'),
      );
      const activeGoalItem = activeGoal?.checklist.find((item) => item.status === 'running');
      // The authenticated session owns the workspace and its saved policy.
      const root = (session as any).workingDirectory || workingDirectory || process.cwd();
      const ctx: ToolContext = {
        sessionId,
        ...(activeGoal ? { goalId: activeGoal.id } : {}),
        ...(activeGoalItem ? { goalItemId: activeGoalItem.id } : {}),
        workingDirectory: root,
        signal: undefined,
        isSandboxed: normalizedRole === 'critic',
        permissionPolicy: resolveToolPermissionPolicy(
          loadAgentSettings(root),
          normalizedRole === 'critic' ? 'plan' : 'act',
        ),
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
    } catch (err: any) {
      providerLog.error({ err, toolName, sessionId }, 'MCP bridge execute failed');
      set.status = 500;
      return { ok: false, error: err?.message ?? String(err) };
    }
  }, { body: t.Object({ sessionId: t.String(), toolName: t.String(), input: t.Record(t.String(), t.Unknown()), role: t.Optional(t.String()), workingDirectory: t.Optional(t.String()) }) })

  // ── PreToolUse hook: approve/block/rewrite a CLI tool call ──────────────
  .post('/hooks/pre-tool', async ({ request, body, set }) => {
    const auth = requireLocalRouteAuth(request, set);
    if (!auth) return { ok: false, error: 'Unauthorized' };
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
      const root = (session as any).workingDirectory || process.cwd();
      const permissionMode = role === 'critic' ? 'plan' : loadAgentSettings(root).permissionMode;
      if (permissionMode === 'yolo') {
        return { decision: 'approve' as const, reason: 'Authenticated YOLO turn permits native tools' };
      }
      // Route native CLI tool calls through Kory's permission system.
      // If the tool is one Kory can handle (read, write, exec, etc.), block
      // the native call and tell the CLI to use the kory__ equivalent instead.
      const koryEquivalent = NATIVE_TO_KORY[tool_name];
      if (koryEquivalent) {
        return {
          decision: 'block' as const,
          reason: `Koryphaios owns tool execution. Use the ${koryEquivalent} MCP tool instead of the native ${tool_name} tool.`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `Your native ${tool_name} tool was blocked. Call ${koryEquivalent} via the kory MCP server instead.`,
          },
        };
      }
      // Block native subagent spawning — route through kory__delegate_to_worker.
      if (tool_name === 'run_subagent' || tool_name === 'Task' || tool_name === 'Agent') {
        return {
          decision: 'block' as const,
          reason: 'Koryphaios owns orchestration. Use kory__delegate_to_worker to delegate tasks.',
        };
      }
      // Unknown/native tool not in the mapping — allow it (the CLI's own tools
      // that Kory doesn't have an equivalent for, like TodoWrite, are fine).
      return { decision: 'approve' as const };
    } catch (err: any) {
      providerLog.error({ err }, 'PreToolUse hook failed');
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
    } catch {
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
    const root = (session as any).workingDirectory || process.cwd();
    if (role !== 'critic' && loadAgentSettings(root).permissionMode === 'yolo') {
      return { decision: 'approve' as const, reason: 'Authenticated YOLO turn permits native tools' };
    }
    const koryEquivalent = NATIVE_TO_KORY[tool_name];
    if (koryEquivalent) {
      return { decision: 'block' as const, reason: `Use ${koryEquivalent} instead.` };
    }
    return { decision: 'approve' as const };
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
    } catch {
      return { ok: true, additionalContext: '' };
    }
  }, { body: t.Object({ session_id: t.String() }) })

  // ── Stop hook: let the critic gate decide if the CLI may stop ───────────
  .post('/hooks/stop', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
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
    } catch {
      return { decision: 'approve' as const };
    }
  }, { body: t.Object({ session_id: t.String() }) })

  // ── SessionStart hook: register the CLI session ─────────────────────────
  .post('/hooks/session-start', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { session_id } = body as { session_id: string };
    providerLog.info({ sessionId: session_id }, 'CLI session started via hook');
    return { ok: true };
  }, { body: t.Object({ session_id: t.String() }) })

  // ── SessionEnd hook: flush ──────────────────────────────────────────────
  .post('/hooks/session-end', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { session_id } = body as { session_id: string };
    providerLog.info({ sessionId: session_id }, 'CLI session ended via hook');
    return { ok: true };
  }, { body: t.Object({ session_id: t.String() }) });
