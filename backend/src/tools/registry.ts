// Tool system — abstract base and registry.
// Ported from OpenCode's tools/tools.go pattern.

import type { ChangeSummary } from "@koryphaios/shared";

export interface ToolContext {
  sessionId: string;
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

/** Role filter: manager gets manager+worker+any (full); worker gets worker+any; critic gets critic+any (read-only only). */
function roleIncludesTool(role: "manager" | "worker" | "critic", toolRole?: "manager" | "worker" | "critic" | "any"): boolean {
  const r = toolRole as string | undefined;
  if (!r || r === "any") return true;
  if (role === "manager") return r === "manager" || r === "worker";
  return r === role;
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
  getToolDefsForRole(role: "manager" | "worker" | "critic") {
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
