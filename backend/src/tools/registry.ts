// Tool system — abstract base and registry.
// Ported from OpenCode's tools/tools.go pattern.

import type { ChangeSummary } from '@koryphaios/shared';
import { toolLog } from '../logger';
import { summarizeToolErrorForAudit } from '../security/bash-sandbox';
import {
  decideToolPermission,
  type ToolPermissionPolicy,
  type ResolvedSandboxOptions,
} from './permission-policy';

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
  workingDirectory: string;
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
  delegateToWorker?: (task: string, domain?: string) => Promise<string>;
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
}

export interface ToolCallInput {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallOutput {
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
    return this.getAll()
      .filter((t) => roleIncludesTool(t.name, role, t.role))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
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

    const start = performance.now();

    // Approval receipts are single-invocation capabilities. A provider may
    // reuse a tool-call ID, so discard any stale receipt before deciding the
    // current call. The host adds it back only after this invocation's prompt.
    ctx.approvedToolCallIds?.delete(call.id);

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
    for (const file of files) {
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
    const permission = decideToolPermission(ctx.permissionPolicy, call.name, change);
    if (permission.action === 'deny') {
      return {
        callId: call.id,
        name: call.name,
        output: permission.reason,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
    if (permission.action === 'ask') {
      if (!ctx.waitForUserInput) {
        return {
          callId: call.id,
          name: call.name,
          output: `${permission.reason}, but no human approval channel is available.`,
          isError: true,
          durationMs: performance.now() - start,
        };
      }
      const selection = await ctx.waitForUserInput(
        `${permission.reason}. Allow ${call.name} once?`,
        ['Allow once', 'Reject'],
        { allowOther: false, allowKeepChatting: false },
      );
      if (selection !== 'Allow once') {
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

    try {
      const result = await tool.run(ctx, call);
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
    }
  }
}
