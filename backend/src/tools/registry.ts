// Tool system — abstract base and registry.
// Ported from OpenCode's tools/tools.go pattern.

import type { ChangeSummary } from "@koryphaios/shared";
import { toolLog } from "../logger";

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
  /** Optional callback for streaming file edit deltas to the UI */
  emitFileEdit?: (event: { path: string; delta: string; totalLength: number; operation: "create" | "edit" }) => void;
  emitFileComplete?: (event: { path: string; totalLines: number; operation: "create" | "edit" }) => void;
  /** Optional callback to request user input (blocking) */
  waitForUserInput?: (question: string, options: string[]) => Promise<string>;
  /** Optional callback to record code changes for summary and keep/reject */
  recordChange?: (change: ChangeSummary) => void;
  /** Optional: manager-only. When the manager calls delegate_to_worker, this runs the worker pipeline and returns a summary. */
  delegateToWorker?: (task: string, domain?: string) => Promise<string>;
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
  readonly role?: "manager" | "worker" | "critic" | "any";

  /** Execute the tool with the given input. */
  run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput>;
}

type ToolExecutionRole = "manager" | "worker" | "critic" | "coder";

/** Role filter: manager gets manager+worker+any (full); worker gets worker+any; critic gets critic+any (read-only only). */
function roleIncludesTool(role: ToolExecutionRole, toolRole?: "manager" | "worker" | "critic" | "any"): boolean {
  const normalizedRole: "manager" | "worker" | "critic" = role === "coder" ? "worker" : role;
  const r = toolRole as string | undefined;
  if (!r || r === "any") return true;
  if (normalizedRole === "manager") return r === "manager" || r === "worker";
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
      .filter((t) => roleIncludesTool(role, t.role))
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

    const start = performance.now();
    try {
      const result = await tool.run(ctx, call);
      result.durationMs = performance.now() - start;
      return result;
    } catch (err: any) {
      // Log full error details for debugging
      toolLog.error({
        err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
        toolName: call.name,
        callId: call.id,
        sessionId: ctx.sessionId,
        durationMs: performance.now() - start,
      }, "Tool execution failed");
      
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
