// Tool system — abstract base and registry.
// Ported from OpenCode's tools/tools.go pattern.

import type { ChangeSummary } from '@koryphaios/shared';
import { toolLog } from '../logger';

export interface ToolContext {
  sessionId: string;
  /** Optional agent identifier for backward compatibility in tests and callsites. */
  agentId?: string;
  workingDirectory: string;
  signal?: AbortSignal;
  /** whitelisted paths for scoped access (sandboxing) */
  allowedPaths?: string[];
  /** Whether the tool execution should be strictly sandboxed */
  isSandboxed?: boolean;
  /** Explicit user-selected unrestricted mode. This intentionally suppresses
   * confirmation prompts, including destructive shell commands. */
  yoloMode?: boolean;
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
  /** Optional callback to request user input (blocking) */
  waitForUserInput?: (question: string, options: string[]) => Promise<string>;
  /** Optional callback to record code changes for summary and keep/reject */
  recordChange?: (change: ChangeSummary) => void;
  /** Optional preflight for file-mutating tools. Returning false prevents the edit. */
  preflightFileChange?: (
    proposal: FileChangeProposal,
  ) => Promise<{ allowed: boolean; reason?: string }>;
  /** Optional: manager-only. When the manager calls delegate_to_worker, this runs the worker pipeline and returns a summary. */
  delegateToWorker?: (task: string, domain?: string) => Promise<string>;
  /** Optional: manager-only. Delegates to Google Jules (cloud async agent, API only). */
  delegateToJules?: (
    task: string,
    options?: { createPr?: boolean; branch?: string },
  ) => Promise<string>;
}

export interface FileChangeProposal {
  paths: string[];
  /** Added plus removed lines in the requested edit. */
  linesChanged: number;
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
function roleIncludesTool(
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

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
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

    const proposal = estimateFileChange(call);
    if (proposal && ctx.preflightFileChange) {
      const decision = await ctx.preflightFileChange(proposal);
      if (!decision.allowed) {
        return {
          callId: call.id,
          name: call.name,
          output: decision.reason ?? 'Edit blocked by the configured autonomy limits.',
          isError: true,
          durationMs: 0,
        };
      }
    }

    const start = performance.now();
    try {
      const result = await tool.run(ctx, call);
      result.durationMs = performance.now() - start;
      return result;
    } catch (err: any) {
      // Log full error details for debugging
      toolLog.error(
        {
          err:
            err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
          toolName: call.name,
          callId: call.id,
          sessionId: ctx.sessionId,
          durationMs: performance.now() - start,
        },
        'Tool execution failed',
      );

      return {
        callId: call.id,
        name: call.name,
        output: `Tool error: ${err.message ?? String(err)}`,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
  }
}

function lineCount(value: unknown): number {
  return typeof value === 'string' ? value.split('\n').length : 0;
}

/** Estimate Kory-owned file tool impact before the tool mutates the workspace. */
function estimateFileChange(call: ToolCallInput): FileChangeProposal | null {
  const input = call.input;
  if (call.name === 'write_file' && typeof input.path === 'string') {
    return { paths: [input.path], linesChanged: lineCount(input.content) };
  }

  if ((call.name === 'edit_file' || call.name === 'patch') && typeof input.path === 'string') {
    const edits = call.name === 'patch' && Array.isArray(input.edits) ? input.edits : [input];
    const linesChanged = edits.reduce((total, edit) => {
      if (!edit || typeof edit !== 'object') return total;
      const change = edit as Record<string, unknown>;
      return total + lineCount(change.old_str) + lineCount(change.new_str);
    }, 0);
    return { paths: [input.path], linesChanged };
  }

  if (call.name === 'batch_edit' && Array.isArray(input.files)) {
    const paths: string[] = [];
    let linesChanged = 0;
    for (const file of input.files) {
      if (!file || typeof file !== 'object') continue;
      const entry = file as Record<string, unknown>;
      if (typeof entry.path === 'string') paths.push(entry.path);
      if (!Array.isArray(entry.edits)) continue;
      for (const edit of entry.edits) {
        if (!edit || typeof edit !== 'object') continue;
        const change = edit as Record<string, unknown>;
        linesChanged += lineCount(change.old_str) + lineCount(change.new_str);
      }
    }
    return paths.length > 0 ? { paths, linesChanged } : null;
  }

  return null;
}
