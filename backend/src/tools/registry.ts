// Tool system — abstract base and registry.
// Ported from OpenCode's tools/tools.go pattern.

import type { ChangeSummary } from '@koryphaios/shared';
import type { ToolPermissionPolicy, ResolvedSandboxOptions } from './permission-policy';
import { roleIncludesTool, type ToolExecutionRole } from './tool-roles';
import { mcpProjectScope } from '../mcp/project-scope';
import { executeTool } from './execution-pipeline';
export { deriveToolContext } from './execution-pipeline';
export { roleIncludesTool } from './tool-roles';

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
  agentName?: string;
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
  /** Host-created disposable verification grant, never supplied by a model. */
  reviewWorkspaceRoot?: string;
  /** The producer checkout a review copy mirrors. File-tool targets inside it
   *  are rewritten to the same relative path under the copy's cwd, because
   *  transcripts keep spelling the producer's absolute paths. */
  reviewSourceRoot?: string;
  /** Canonical host-owned project root, distinct from a worker's disposable checkout. */
  settingsRoot?: string;
  signal?: AbortSignal;
  /** Hold user-facing answer text until the universal Critic gate settles. */
  deferResponse?: boolean;
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
  /** Host-set: this chat's workspace binding changed earlier this turn
   *  (isolate_chat/merge_chat_back). While true, workspace-mutating tools are
   *  denied — the context's workingDirectory still names the pre-change root. */
  workspaceRebindPending?: boolean;
  /** Host callback: marks that a workspace-mutating tool ran successfully this
   *  turn. Only installed for contexts whose turn can isolate mid-turn. */
  noteWorkspaceMutation?: () => void;
  /** Independent, invocation-bound UI queue for concurrent tool approvals. */
  waitForToolApproval?: (
    ctx: ToolContext,
    call: ToolCallInput,
    question: string,
    options: string[],
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Optional manager review in Guarded; other modes use their normal policy. */
  requestToolApproval?: (call: ToolCallInput, reason: string) => Promise<boolean>;
  manageReviewAgents?: (input: Record<string, unknown>) => Promise<string>;
  /** Manager-only controls for workers it spawned in this session. */
  manageAgents?: (input: Record<string, unknown>) => Promise<string>;
  /** Let the current worker/critic reclaim its own prior tool-output context. */
  pruneOwnContext?: (keepRecent?: number) => Promise<string>;
  /** Report that the agent now holds a skill's full instructions in its live
   * context (a load_skill_detail result). The host tracks this so the skill
   * feeder stops re-stuffing the same text on later turns. */
  onSkillDetailLoaded?: (skill: string) => void;
  /** Agent control over the skill feeder for this chat: report, block, or
   * unblock skills. Host-owned so the block list lives in per-session state. */
  manageSkillFeeding?: (input: Record<string, unknown>) => Promise<string>;
  /** Control over what tool output stays in this agent's context: this chat's
   *  for a Manager, only the private prompt history for a Worker or Critic. */
  manageContext?: (input: Record<string, unknown>) => Promise<string>;
  requestManagerInput?: (question: string) => Promise<string>;
  /** Calls approved by the host policy do not prompt a second time inside a
   *  tool-specific risk check such as catastrophic bash detection. */
  approvedToolCallIds?: Set<string>;
  /** Optional callback to record code changes for summary and keep/reject */
  recordChange?: (change: ChangeSummary) => void;
  /** Manager worker pipeline or Critic-owned specialist delegation. */
  delegateToWorker?: (
    task: string,
    domain?: string,
    skills?: import('../kory/skill-assignment').SkillAssignment,
    preferredModel?: string,
    reasoningLevel?: string,
    worktree?: boolean,
    fallbacks?: import('@koryphaios/shared').AgentFallbackStep[],
  ) => Promise<string>;
  /** Manager-only metadata callback scoped to this session by the host. */
  renameSession?: (title: string) => Promise<string>;
  /** Manager-only: fork a chat (default: this one) at a finished point, returning the new chat. */
  forkChat?: (input: {
    sessionId?: string;
    messageId?: string;
    title?: string;
  }) => Promise<{ sessionId: string; title: string; copiedMessageCount: number }>;
  /** Manager Auto-mode decision to hold its final answer for independent review. */
  requestCriticReview?: (reason: string) => void;
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
  /** Optional role restriction; Critic has explicit inspection/verification tools. */
  readonly role?: 'manager' | 'worker' | 'critic' | 'any';
  /** External tools are project-owned; built-in tools have no project scope. */
  readonly projectRoot?: string;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;

  /** Execute the tool with the given input. */
  run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private projectTools = new Map<string, Map<string, Tool>>();

  register(tool: Tool) {
    if (tool.projectRoot) {
      const scope = mcpProjectScope(tool.projectRoot);
      const scoped = this.projectTools.get(scope) ?? new Map<string, Tool>();
      const existing = scoped.get(tool.name);
      if (existing && existing.mcpServerName !== tool.mcpServerName) {
        throw new Error(`Ambiguous MCP tool alias: ${tool.name}`);
      }
      scoped.set(tool.name, tool);
      this.projectTools.set(scope, scoped);
      return;
    }
    this.tools.set(tool.name, tool);
  }

  /** Remove one server's tools by ownership, not a prefix that could also
   * match another server containing underscores. */
  unregisterMcpServer(name: string, projectRoot: string): void {
    const scope = mcpProjectScope(projectRoot);
    const tools = this.projectTools.get(scope);
    if (!tools) return;
    for (const [alias, tool] of tools) {
      if (tool.mcpServerName === name) tools.delete(alias);
    }
    if (tools.size === 0) this.projectTools.delete(scope);
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

  get(name: string, projectRoot = process.cwd()): Tool | undefined {
    return this.tools.get(name) ?? this.projectTools.get(mcpProjectScope(projectRoot))?.get(name);
  }

  getAll(projectRoot = process.cwd()): Tool[] {
    return [
      ...this.tools.values(),
      ...(this.projectTools.get(mcpProjectScope(projectRoot))?.values() ?? []),
    ];
  }

  /** Get stable provider tool definitions filtered by execution role. */
  getToolDefsForRole(role: ToolExecutionRole, projectRoot = process.cwd()) {
    return (
      this.getAll(projectRoot)
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

  isAllowedForRole(name: string, role: ToolExecutionRole, projectRoot = process.cwd()): boolean {
    const tool = this.get(name, projectRoot);
    return Boolean(tool && roleIncludesTool(tool.name, role, tool.role));
  }

  async execute(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const tool = this.get(call.name, ctx.settingsRoot ?? ctx.workingDirectory);
    if (!tool) {
      return {
        callId: call.id,
        name: call.name,
        output: `Unknown tool: ${call.name}`,
        isError: true,
        durationMs: 0,
      };
    }

    return executeTool(tool, ctx, call);
  }
}
