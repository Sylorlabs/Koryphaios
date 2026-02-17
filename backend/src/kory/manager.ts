// Kory Manager Agent — the orchestrator brain.
// Implements "Fast Path" for simple tasks and "Delegation" for complex ones.

import type {
  AgentIdentity,
  AgentStatus,
  WorkerDomain,
  WSMessage,
  ProviderName,
  KoryphaiosConfig,
  KoryAskUserPayload,
  ChangeSummary,
  StreamUsagePayload,
} from "@koryphaios/shared";
import { normalizeReasoningLevel, determineAutoReasoningLevel } from "@koryphaios/shared";
import { DOMAIN } from "../constants";
import { ProviderRegistry, resolveModel, resolveTrustedContextWindow, isLegacyModel, type StreamRequest, type ProviderEvent, type Provider } from "../providers";
import { ToolRegistry, type ToolCallInput, type ToolContext } from "../tools";
import { wsBroker } from "../pubsub";
import { koryLog } from "../logger";
import { nanoid } from "nanoid";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import { getDb } from "../db/sqlite";
import type { ISessionStore } from "../stores/session-store";
import type { IMessageStore } from "../stores/message-store";
import { SnapshotManager } from "./snapshot-manager";
import { GitManager } from "./git-manager";
import { TaskStore, type ITaskStore } from "../stores/task-store";
import { z } from "zod";

// ─── Conversation Types ────────────────────────────────────────────────────

interface CompletedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ConversationMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_call_id?: string;
  tool_calls?: CompletedToolCall[];
}

// ─── Tracing ───────────────────────────────────────────────────────────────

const TRACE_DIR = ".koryphaios/traces";
let traceFile: string | undefined;

function initTraceLog(workingDir: string) {
  const tracePath = join(workingDir, TRACE_DIR);
  mkdirSync(tracePath, { recursive: true });
  traceFile = join(tracePath, `${Date.now()}.jsonl`);
  koryLog.info({ traceFile }, "Tracing enabled. Log file:");
}

interface TraceEvent {
  timestamp: number;
  agentId: string;
  type: string;
  details: Record<string, any>;
  durationMs?: number;
  cost?: number;
}

function emitTrace(agentId: string, type: string, details: Record<string, any> = {}, durationMs?: number, cost?: number) {
  if (!traceFile) return;
  const event: TraceEvent = { timestamp: Date.now(), agentId, type, details, durationMs, cost };
  try {
    appendFileSync(traceFile, JSON.stringify(event) + "\n");
  } catch (e) {
    koryLog.warn({ e }, "Failed to write trace event");
  }
}

// ─── Default Model Assignments per Domain ───────────────────────────────────

for (const [domain, modelId] of Object.entries(DOMAIN.DEFAULT_MODELS)) {
  const def = resolveModel(modelId);
  if (!def) {
    throw new Error(`DOMAIN.DEFAULT_MODELS["${domain}"] references unknown model: "${modelId}".`);
  }
}

// ─── Kory Identity ──────────────────────────────────────────────────────────

const KORY_IDENTITY: AgentIdentity = {
  id: "kory-manager",
  name: "Kory",
  role: "manager",
  model: "pending",
  provider: "auto" as ProviderName,
  domain: "general",
  glowColor: "rgba(255,215,0,0.6)", // Gold
};

function koryIdentityWithModel(model: string, provider?: ProviderName): AgentIdentity {
  return { ...KORY_IDENTITY, model, provider: provider ?? KORY_IDENTITY.provider };
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const MANAGER_PROMPT = `You are Kory, the Lead Architect and Orchestrator.
Your goal is to solve the user's request EFFICIENTLY and ensuring a WORKING result.

DECISION PROTOCOL:
1. SIMPLE TASKS (e.g. typos, single file edits, direct commands):
   - EXECUTE them yourself immediately. Do not plan. Do not delegate.
   
2. COMPLEX TASKS (e.g. refactoring, new features, multi-file changes):
   - ANALYZE the request.
   - CREATE a plan.
   - DELEGATE to a Worker.

You have full filesystem access. Be decisive.
At the end of any task, provide clear "Next Steps" for the user to verify the work (e.g., "Run 'npm start' to see the changes").`;

const WORKER_PROMPT = `You are an expert specialist Worker Agent.
Your goal is to deliver PRODUCTION-READY code for a beginner user.
1. EXECUTE the plan using tools.
2. VERIFY everything. Run tests or build commands to ensure NO ERRORS.
3. FIX any issues you find immediately. Do not leave broken code.
4. If you cannot fix it, explain exactly why and what the user should do.
You are autonomous within this task.`;

// ─── Kory Manager Class ─────────────────────────────────────────────────────

export interface KoryTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  assignedModel: string;
  assignedProvider: ProviderName;
  status: "pending" | "active" | "done" | "failed" | "interrupted";
  plan?: string;
  result?: string;
  error?: string;
}

type TaskComplexity = "SIMPLE" | "COMPLEX";

const CLARIFICATION_SYSTEM_PROMPT = `You are a deterministic intent-clarification gate.
Return JSON only. No markdown. No prose outside JSON.

Output must be EXACTLY one schema:
1) {"action":"proceed"}
2) {"action":"clarify","questions":["..."],"reason":"...","assumptions":["..."]}

Rules:
- Ask clarification only if request is underspecified/ambiguous for safe execution.
- Questions must be short, specific, and answerable in one message.
- Avoid yes/no-only questions unless they unlock a major branch (example: existing project or new?).
- Maximum questions is provided by user prompt; never exceed it.`;

const ClarifyProceedSchema = z.object({ action: z.literal("proceed") });
const ClarifyQuestionSchema = z.string().trim().min(1).max(140);
const ClarifySchema = z.object({
  action: z.literal("clarify"),
  questions: z.array(ClarifyQuestionSchema).min(1),
  reason: z.string().trim().min(1),
  assumptions: z.array(z.string().trim().min(1)).default([]),
});

type ClarificationDecision = z.infer<typeof ClarifyProceedSchema> | z.infer<typeof ClarifySchema>;

const MAJOR_BRANCH_QUESTION_PATTERNS = [
  /existing\s+project\s+or\s+new/i,
  /new\s+or\s+existing/i,
  /from\s+scratch\s+or\s+existing/i,
  /web\s+or\s+mobile/i,
  /frontend\s+or\s+backend/i,
  /local\s+or\s+production/i,
];

const YES_NO_ONLY_START = /^(is|are|do|does|did|can|could|should|would|will|have|has|had|was|were|may)\b/i;

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function isMajorBranchYesNoQuestion(question: string): boolean {
  return MAJOR_BRANCH_QUESTION_PATTERNS.some((pattern) => pattern.test(question));
}

function isDisallowedYesNoOnlyQuestion(question: string): boolean {
  const normalized = question.trim();
  if (!normalized.endsWith("?")) return false;
  if (!YES_NO_ONLY_START.test(normalized)) return false;
  if (/\bor\b/i.test(normalized)) return false;
  return !isMajorBranchYesNoQuestion(normalized);
}

export function parseClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision | null {
  try {
    const parsed = JSON.parse(extractJsonObject(raw));

    const proceed = ClarifyProceedSchema.safeParse(parsed);
    if (proceed.success) return proceed.data;

    const clarify = ClarifySchema.safeParse(parsed);
    if (!clarify.success) return null;

    if (clarify.data.questions.length > maxQuestions) return null;
    if (clarify.data.questions.some((question) => isDisallowedYesNoOnlyQuestion(question))) return null;
    return clarify.data;
  } catch {
    return null;
  }
}

export function resolveClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision {
  return parseClarificationDecision(raw, maxQuestions) ?? { action: "proceed" };
}

export class KoryManager {
  private activeWorkers = new Map<string, { agent: AgentIdentity; status: AgentStatus; task: KoryTask; abort: AbortController; sessionId: string }>();
  private tasks: KoryTask[] = []; // Note: Not currently used for persistence, only active workers.
  private memoryDir: string;
  private isProcessing = false;
  private isYoloMode = false;
  private pendingUserInputs = new Map<string, { sessionId: string; resolve: (selection: string) => void }>();
  private sessionChanges = new Map<string, ChangeSummary[]>();
  private snapshotManager: SnapshotManager;
  public readonly git: GitManager;
  private lastKnownGoodHash = new Map<string, string>();
  private taskStore: ITaskStore; // For persisting tasks

  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private workingDirectory: string,
    private config: KoryphaiosConfig,
    private sessions?: ISessionStore,
    private messages?: IMessageStore,
  ) {
    this.memoryDir = join(workingDirectory, ".koryphaios/memory");
    mkdirSync(this.memoryDir, { recursive: true });
    this.snapshotManager = new SnapshotManager(workingDirectory);
    this.git = new GitManager(workingDirectory);
    this.taskStore = new TaskStore(); // Initialize TaskStore
    initTraceLog(workingDirectory);
  }

  setYoloMode(enabled: boolean) {
    this.isYoloMode = enabled;
    koryLog.info({ enabled }, "YOLO mode state updated");
  }

  cancel() {
    for (const [workerId, state] of this.activeWorkers) {
      state.abort.abort();
      this.activeWorkers.delete(workerId);
      this.taskStore.update(state.task.id, { status: "interrupted" });
    }
    this.isProcessing = false;
    koryLog.info("Kory manager cancelled all active operations.");
  }

  cancelWorker(agentId: string) {
    const state = this.activeWorkers.get(agentId);
    if (state) {
      state.abort.abort();
      this.activeWorkers.delete(agentId);
      this.taskStore.update(state.task.id, { status: "interrupted" });
      koryLog.info({ agentId }, "Cancelled worker");
    }
  }

  cancelSessionWorkers(sessionId: string) {
    for (const [workerId, state] of this.activeWorkers) {
      if (state.sessionId === sessionId) {
        state.abort.abort();
        this.activeWorkers.delete(workerId);
        this.taskStore.update(state.task.id, { status: "interrupted" });
      }
    }
    koryLog.info({ sessionId }, "Cancelled all session workers");
  }

  getStatus() {
    return Array.from(this.activeWorkers.values()).map(w => ({
      identity: w.agent,
      status: w.status,
      task: w.task.description
    }));
  }

  isSessionRunning(sessionId: string): boolean {
    for (const state of this.activeWorkers.values()) {
      if (state.sessionId === sessionId) return true;
    }
    return false;
  }

  private updateWorkflowState(sessionId: string, state: string) {
    getDb().run("UPDATE sessions SET workflow_state = ? WHERE id = ?", [state, sessionId]);
  }

  handleUserInput(sessionId: string, selection: string, text?: string, requestId?: string) {
    const reply = text || selection;
    if (requestId) {
      const exact = this.pendingUserInputs.get(requestId);
      if (exact?.sessionId === sessionId) {
        exact.resolve(reply);
        this.pendingUserInputs.delete(requestId);
        return;
      }
    }

    // Backward-compatible fallback for older clients that don't send requestId.
    const fallbackKey = Array.from(this.pendingUserInputs.entries()).find(([, pending]) => pending.sessionId === sessionId)?.[0];
    if (!fallbackKey) return;
    const pending = this.pendingUserInputs.get(fallbackKey);
    if (!pending) return;
    pending.resolve(reply);
    this.pendingUserInputs.delete(fallbackKey);
  }

  handleSessionResponse(sessionId: string, accepted: boolean) {
    if (accepted) {
      this.emitThought(sessionId, "synthesizing", "User accepted changes.");
    } else {
      this.emitThought(sessionId, "synthesizing", "User rejected changes. Rolling back...");
      const prevHash = this.lastKnownGoodHash.get(sessionId);
      if (prevHash && this.git.isGitRepo()) {
        this.git.rollback(prevHash);
      } else {
        this.snapshotManager.restoreSnapshot(sessionId, "latest", this.workingDirectory);
      }
    }
    this.lastKnownGoodHash.delete(sessionId);
    this.sessionChanges.delete(sessionId);
  }

  getSessionChanges(sessionId: string): ChangeSummary[] {
    return this.sessionChanges.get(sessionId) ?? [];
  }

  async applySessionChanges(
    sessionId: string,
    opts: { acceptAll?: boolean; rejectAll?: boolean; acceptPaths?: string[]; rejectPaths?: string[] }
  ): Promise<{ ok: boolean; remaining: ChangeSummary[]; applied?: string[]; rejected?: string[]; error?: string }> {
    const pending = this.sessionChanges.get(sessionId) ?? [];
    if (pending.length === 0) {
      return { ok: true, remaining: [] };
    }

    if (opts.acceptAll) {
      this.handleSessionResponse(sessionId, true);
      return { ok: true, remaining: [], applied: pending.map((c) => c.path) };
    }

    if (opts.rejectAll) {
      this.handleSessionResponse(sessionId, false);
      return { ok: true, remaining: [] };
    }

    const rejectSet = new Set((opts.rejectPaths ?? []).map((p) => p.trim()).filter(Boolean));
    const acceptSet = new Set((opts.acceptPaths ?? []).map((p) => p.trim()).filter(Boolean));

    if (rejectSet.size === 0 && acceptSet.size === 0) {
      return { ok: true, remaining: pending };
    }

    const toReject = pending.filter((c) => rejectSet.has(c.path));
    const toAccept = pending.filter((c) => acceptSet.has(c.path));

    const rejected: string[] = [];
    for (const change of toReject) {
      const ok = await this.rejectSingleChange(change, sessionId);
      if (!ok) {
        return { ok: false, remaining: pending, error: `Failed to reject ${change.path}` };
      }
      rejected.push(change.path);
    }

    const remaining = pending.filter((c) => !rejectSet.has(c.path) && !acceptSet.has(c.path));
    this.sessionChanges.set(sessionId, remaining);
    return { ok: true, remaining, applied: toAccept.map((c) => c.path), rejected };
  }

  private async rejectSingleChange(change: ChangeSummary, sessionId: string): Promise<boolean> {
    const relPath = change.path.replace(/^\/+/, "");
    const absPath = join(this.workingDirectory, relPath);

    if (change.operation === "create") {
      try {
        rmSync(absPath, { force: true, recursive: true });
        return true;
      } catch {
        return false;
      }
    }

    if (this.git.isGitRepo()) {
      const restored = await this.git.restoreFile(relPath);
      if (restored) return true;
    }

    const snapshot = this.snapshotManager.restoreFiles(sessionId, "latest", this.workingDirectory, [relPath]);
    return snapshot.success && snapshot.restored.length > 0;
  }

  // ─── INTELLIGENT ROUTING & EXECUTION ──────────────────────────────────────

  /**
   * Main entry point for processing a task.
   * Pipeline:
   * 1) Optional clarification gate (ask targeted questions for vague prompts)
   * 2) Complexity classification
   * 3) Fast path (manager direct execution) or complex worker workflow
   */
  async processTask(sessionId: string, userMessage: string, preferredModel?: string, reasoningLevel?: string): Promise<void> {
    this.isProcessing = true;
    this.sessionChanges.delete(sessionId);
    this.updateWorkflowState(sessionId, "analyzing");

    const routing = this.resolveActiveRouting(preferredModel, "general");

    try {
      this.emitThought(sessionId, "analyzing", `Analyzing intent...`);

      const executionMessage = (await this.maybeClarify(sessionId, userMessage, routing)).enrichedMessage;
      
      const taskStart = performance.now();
      const complexity = await this.classifyComplexity(sessionId, executionMessage, routing);
      const complexityDuration = performance.now() - taskStart;
      emitTrace(KORY_IDENTITY.id, "complexity_classification", { complexity, durationMs: complexityDuration });
      this.emitThought(sessionId, "planning", `Task classified as: ${complexity}`);

      if (complexity === "SIMPLE") {
        // FAST PATH: Manager does it directly using tools
        this.updateWorkflowState(sessionId, "executing");
        await this.executeDirectly(sessionId, executionMessage, routing);
      } else {
        // SLOW PATH: Delegate to Specialist Worker
        await this.handleComplexWorkflow(sessionId, executionMessage, preferredModel, reasoningLevel, routing);
      }

      // Notify changes
      const changes = this.sessionChanges.get(sessionId) || [];
      if (changes.length > 0) this.emitWSMessage(sessionId, "session.changes", { changes });

    } catch (err) {
      this.updateWorkflowState(sessionId, "error");
      this.emitError(sessionId, `Error: ${String(err)}`);
    } finally { 
      this.isProcessing = false; 
      this.updateWorkflowState(sessionId, "idle");
    }
  }

  private shouldTryClarification(message: string): boolean {
    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();
    const likelyAmbiguousShort = trimmed.length < 10 && /\b(fix|make|build|help)\b/.test(lower);
    if (likelyAmbiguousShort) return true;

    const specificityMarkers = [
      /`[^`]+`/g, // inline code
      /```[\s\S]*?```/g, // fenced code
      /\b[a-z0-9_\-/]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|cpp|c|h|hpp|json|yml|yaml|md)\b/gi, // file names
      /\b(src|backend|frontend|api|components|services|tests?)\//gi, // paths
      /\b(port|localhost|127\.0\.0\.1|http:\/\/|https:\/\/|npm|bun|pnpm|yarn|cargo|pytest|jest|vitest)\b/gi, // runtime/tool anchors
      /\b(function|class|method|interface|endpoint|route|schema|migration)\s+[A-Za-z_][\w-]*/g, // named symbols
      /^\s*[-*]\s+/gm, // bullet lists
      /^\s*\d+[.)]\s+/gm, // numbered lists
    ].reduce((count, pattern) => count + ((trimmed.match(pattern) ?? []).length > 0 ? 1 : 0), 0);

    if (trimmed.length > 80 && specificityMarkers >= 2) return false;

    const hasConcreteAnchors = specificityMarkers >= 2;
    if (hasConcreteAnchors) return false;

    const clearlySimple = trimmed.length < 20 && (lower.includes("fix") || lower.includes("typo"));
    if (clearlySimple) return false;

    return true;
  }

  private async maybeClarify(
    sessionId: string,
    userMessage: string,
    routing: { model: string; provider?: ProviderName }
  ): Promise<{ enrichedMessage: string; asked: boolean; questions?: string[]; answers?: string[] }> {
    const clarifyEnabled = this.config.interaction?.clarifyFirstEnabled ?? false;
    const maxQuestions = Math.min(Math.max(this.config.interaction?.maxClarifyQuestions ?? 4, 1), 4);

    if (!clarifyEnabled || !this.shouldTryClarification(userMessage)) {
      return { enrichedMessage: userMessage, asked: false };
    }

    emitTrace(KORY_IDENTITY.id, "clarification_attempted", { enabled: clarifyEnabled });
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return { enrichedMessage: userMessage, asked: false };

    let rawDecision = "";
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10_000);

    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt: CLARIFICATION_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `User request:\n${userMessage}\n\nMax questions: ${maxQuestions}. Return JSON only.`,
        }],
        maxTokens: 300,
        signal: abortController.signal,
      });

      for await (const event of stream) {
        if (event.type === "content_delta") rawDecision += event.content ?? "";
      }
    } catch (err) {
      emitTrace(KORY_IDENTITY.id, "clarification_fallback", { reason: "provider_error" });
      koryLog.warn({ err }, "Clarification gate failed, continuing without clarification");
      return { enrichedMessage: userMessage, asked: false };
    } finally {
      clearTimeout(timeout);
    }

    const decision = resolveClarificationDecision(rawDecision, maxQuestions);
    if (decision.action === "proceed") {
      emitTrace(KORY_IDENTITY.id, "clarification_proceeded", { action: decision.action });
      return { enrichedMessage: userMessage, asked: false };
    }

    emitTrace(KORY_IDENTITY.id, "clarification_asked_count", { count: decision.questions.length });
    this.emitThought(sessionId, "analyzing", `Need clarification: ${decision.reason}`);
    const answers: string[] = [];

    try {
      for (const question of decision.questions) {
        const answer = await this.askUser(sessionId, {
          question,
          options: [],
          allowOther: true,
        });
        answers.push(answer);
      }
    } catch (err) {
      emitTrace(KORY_IDENTITY.id, "clarification_fallback", { reason: "user_input_failed" });
      koryLog.warn({ err }, "Clarification Q&A failed, continuing without clarification");
      return { enrichedMessage: userMessage, asked: false };
    }

    const clarifications = decision.questions.map((question, index) => `- Q${index + 1}: ${question}\n- A${index + 1}: ${answers[index] ?? ""}`).join("\n");
    const assumptions = decision.assumptions.length > 0
      ? `\n\nAssumptions:\n${decision.assumptions.map((assumption) => `- ${assumption}`).join("\n")}`
      : "";

    return {
      enrichedMessage: `${userMessage}\n\nClarifications:\n${clarifications}${assumptions}`,
      asked: true,
      questions: decision.questions,
      answers,
    };
  }

  private async askUser(sessionId: string, payload: KoryAskUserPayload): Promise<string> {
    const requestId = `${sessionId}:${nanoid(8)}`;
    this.updateWorkflowState(sessionId, "waiting_user");
    this.emitWSMessage(sessionId, "kory.ask_user", { ...payload, requestId });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingUserInputs.delete(requestId);
        this.updateWorkflowState(sessionId, "analyzing");
        emitTrace(KORY_IDENTITY.id, "clarification_timeout", { requestId });
        reject(new Error("Timed out waiting for user clarification input"));
      }, 120_000);

      this.pendingUserInputs.set(requestId, {
        sessionId,
        resolve: (selection: string) => {
        clearTimeout(timeout);
        this.updateWorkflowState(sessionId, "analyzing");
        resolve(selection);
        }
      });
    });
  }

  private async classifyComplexity(sessionId: string, message: string, routing: { model: string; provider?: ProviderName }): Promise<TaskComplexity> {
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return "SIMPLE"; // Fallback

    // Heuristic: If it's very short, likely simple.
    if (message.length < 20 && (message.includes("fix") || message.includes("typo"))) return "SIMPLE";

    try {
      let response = "";
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt: "Classify the task as 'SIMPLE' (one-step fix, typos, direct command) or 'COMPLEX' (refactor, new feature, planning needed). Reply ONLY with the word.",
        messages: [{ role: "user", content: message }],
        maxTokens: 10
      });
      for await (const event of stream) {
        if (event.type === "content_delta") response += event.content;
      }
      const clean = response.trim().toUpperCase();
      return clean.includes("COMPLEX") ? "COMPLEX" : "SIMPLE";
    } catch (err) { 
      koryLog.warn({ err }, "Complexity classification failed, defaulting to SIMPLE");
      return "SIMPLE"; // default to fast path on failure
    }
  }

  /**
   * Fast Path: Manager executes tools directly.
   * This drastically reduces latency for common tasks.
   */
  private async executeDirectly(sessionId: string, userMessage: string, routing: { model: string; provider?: ProviderName }): Promise<void> {
    this.emitWSMessage(sessionId, "agent.spawned", {
      agent: koryIdentityWithModel(routing.model, routing.provider),
      task: userMessage
    });

    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) throw new Error("Provider not found");

    // Manager uses Privileged Context (isSandboxed: false)
    const ctx: ToolContext = { 
      sessionId, 
      workingDirectory: this.workingDirectory, 
      allowedPaths: ["/"], // Privileged
      isSandboxed: false,
      emitFileEdit: (e) => this.emitWSMessage(sessionId, "stream.file_delta", { agentId: KORY_IDENTITY.id, ...e }), 
      emitFileComplete: (e) => this.emitWSMessage(sessionId, "stream.file_complete", { agentId: KORY_IDENTITY.id, ...e }), 
      recordChange: (c) => { const e = this.sessionChanges.get(sessionId) || []; e.push(c); this.sessionChanges.set(sessionId, e); } 
    };

    const history = this.loadHistory(sessionId);
    const messages: ConversationMessage[] = [...history, { role: "user" as const, content: userMessage }];

    const startTime = performance.now();
    // Single-shot execution loop (max 5 turns to prevent runaways)
    await this.runExecutionLoop(sessionId, KORY_IDENTITY.id, provider, routing.model, MANAGER_PROMPT, messages, ctx, 5);
    const durationMs = performance.now() - startTime;
    emitTrace(KORY_IDENTITY.id, "direct_execution", { task: userMessage, durationMs });
  }

  /**
   * Complex Path: Spawn a worker, plan, and execute.
   */
  private async handleComplexWorkflow(
    sessionId: string, 
    userMessage: string, 
    preferredModel: string | undefined, 
    reasoningLevel: string | undefined,
    managerRouting: { model: string; provider?: ProviderName }
  ): Promise<void> {
    
    // 1. Planning (Manager)
    this.updateWorkflowState(sessionId, "planning");
    this.emitThought(sessionId, "planning", "Creating execution plan...");
    
    let plan = "";
    const planStartTime = performance.now();
    const planStream = this.providers.executeWithRetry({ 
      model: managerRouting.model, 
      systemPrompt: "Create a concise, step-by-step implementation plan.", 
      messages: [{ role: "user", content: userMessage }], 
      maxTokens: 500 
    }, managerRouting.provider);
    
    for await (const event of planStream) {
      if (event.type === "content_delta") { 
        plan += event.content; 
        this.emitWSMessage(sessionId, "stream.delta", { agentId: KORY_IDENTITY.id, content: event.content, model: managerRouting.model }); 
      }
    }
    const planDuration = performance.now() - planStartTime;
    emitTrace(KORY_IDENTITY.id, "planning", { task: userMessage, plan, durationMs: planDuration });

    // 2. Snapshot
    if (this.git.isGitRepo()) {
      const hash = this.git.getCurrentHash();
      if (hash) this.lastKnownGoodHash.set(sessionId, hash);
    } else {
      this.snapshotManager.createSnapshot(sessionId, "latest", ["."], this.workingDirectory);
    }

    // 3. Delegation (Worker)
    const domain = await this.classifyDomainLLM(userMessage, managerRouting);
    const workerRouting = this.resolveActiveRouting(preferredModel, domain);
    const workerProvider = await this.providers.resolveProvider(workerRouting.model, workerRouting.provider);

    if (!workerProvider) {
      this.emitError(sessionId, "No provider available for worker.");
      return;
    }

    this.updateWorkflowState(sessionId, "executing");
    this.emitThought(sessionId, "delegating", `Delegating to ${domain} worker...`);

    const workerId = `worker-${nanoid(6)}`;
    const identity: AgentIdentity = { 
      id: workerId, 
      name: `${domain} Worker`, 
      role: "coder", 
      model: workerRouting.model, 
      provider: workerProvider.name, 
      domain, 
      glowColor: DOMAIN.GLOW_COLORS[domain] 
    };

    this.emitWSMessage(sessionId, "agent.spawned", { agent: identity, task: plan });

    const abort = new AbortController();
    this.activeWorkers.set(workerId, { 
      agent: identity, 
      status: "thinking", 
      task: { id: workerId, description: userMessage, domain, assignedModel: workerRouting.model, assignedProvider: workerProvider.name, status: "active" }, 
      abort, 
      sessionId 
    });

    const ctx: ToolContext = { 
      sessionId, 
      workingDirectory: this.workingDirectory, 
      allowedPaths: ["."], // Workers are Sandboxed
      isSandboxed: true,
      signal: abort.signal,
      emitFileEdit: (e) => this.emitWSMessage(sessionId, "stream.file_delta", { agentId: workerId, ...e }), 
      emitFileComplete: (e) => this.emitWSMessage(sessionId, "stream.file_complete", { agentId: workerId, ...e }), 
      recordChange: (c) => { const e = this.sessionChanges.get(sessionId) || []; e.push(c); this.sessionChanges.set(sessionId, e); } 
    };

    // Worker Prompt: Inherit plan + user request
    const workerMessages: ConversationMessage[] = [
      { role: "user" as const, content: `CONTEXT: You are working on a project in ${this.workingDirectory}.\n\nTASK: ${userMessage}\n\nPLAN:\n${plan}\n\nExecute this plan.` }
    ];

    try {
      // 4. Execution Loop (Worker)
      // Allow more turns for complex tasks
      await this.runExecutionLoop(sessionId, workerId, workerProvider, workerRouting.model, WORKER_PROMPT, workerMessages, ctx, 15);
      
      // 5. Success & Commit
      if (this.git.isGitRepo()) {
        const changes = this.getSessionChanges(sessionId);
        if (changes.length > 0) {
          this.emitThought(sessionId, "finalizing", "Generating commit message...");
          
          let commitMsg = "feat: update project";
          try {
            let msgContent = "";
            const msgStartTime = performance.now();
            const msgStream = this.providers.executeWithRetry({
              model: managerRouting.model,
              systemPrompt: "Generate a conventional commit message for these changes. Output ONLY the message.",
              messages: [{ role: "user", content: `Task: ${userMessage}\nChanges: ${JSON.stringify(changes)}` }],
              maxTokens: 60
            }, managerRouting.provider);
            
            for await (const event of msgStream) {
              if (event.type === "content_delta") msgContent += event.content;
            }
            commitMsg = msgContent.trim().replace(/^["']|["']$/g, "");
            const msgDuration = performance.now() - msgStartTime;
            emitTrace(KORY_IDENTITY.id, "commit_message_gen", { task: userMessage, changes: changes.length, durationMs: msgDuration });
          } catch (err) {
            koryLog.warn({ err }, "Failed to generate commit message, using default.");
          }

          this.emitThought(sessionId, "finalizing", `Committing: ${commitMsg}`);
          
          // Stage all changed files
          for (const change of changes) {
             await this.git.stageFile(change.path);
          }
          await this.git.commit(commitMsg);
          this.emitWSMessage(sessionId, "session.git_commit", { message: commitMsg });
        }
      }

    } finally {
      this.activeWorkers.delete(workerId);
    }
  }

  /**
   * Generic execution loop handling tools, streaming, and tool outputs.
   * Used by both Manager (Simple) and Worker (Complex).
   */
  private async runExecutionLoop(
    sessionId: string, 
    agentId: string, 
    provider: Provider, 
    modelId: string, 
    systemPrompt: string, 
    initialMessages: ConversationMessage[], 
    ctx: ToolContext,
    maxTurns: number
  ) {
    const messages: ConversationMessage[] = [...initialMessages];
    let turns = 0;
    
    // Tools available depend on role (Manager gets all, Worker gets subset)
    const role = agentId === KORY_IDENTITY.id ? "manager" : "worker";
    const tools = this.tools.getToolDefsForRole(role);

    const loopStart = performance.now();

    while (turns < maxTurns) {
      turns++;
      let content = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let usageKnown = false;
      
      const turnStart = performance.now();
    // ─── Safety Guardrails ────────────────────────────────────────────────────
    const maxTokensPerTurn = this.config.safety?.maxTokensPerTurn ?? 4096;
    const toolExecutionTimeoutMs = this.config.safety?.toolExecutionTimeoutMs ?? 60_000;

    // Cap tokens per turn
    const cappedMaxTokens = maxTokensPerTurn;

    const stream = this.providers.executeWithRetry({ 
      model: modelId, 
      systemPrompt, 
      messages: messages.map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id, tool_calls: m.tool_calls })), 
      tools, 
      maxTokens: cappedMaxTokens
    }, provider.name);

      const pendingToolCalls = new Map<string, { name: string; input: string }>();
      const completedToolCalls: CompletedToolCall[] = [];
      let hasToolCalls = false;

      for await (const event of stream) {
        if (event.type === "content_delta") {
          content += event.content;
          this.emitWSMessage(sessionId, "stream.delta", { agentId, content: event.content, model: modelId });
        } else if (event.type === "usage_update") {
          if (typeof event.tokensIn === "number") tokensIn = Math.max(tokensIn, event.tokensIn);
          if (typeof event.tokensOut === "number") tokensOut = Math.max(tokensOut, event.tokensOut);
          usageKnown = true;
          this.emitUsageUpdate(sessionId, agentId, modelId, provider.name, tokensIn, tokensOut, usageKnown);
        } else if (event.type === "tool_use_start") {
          hasToolCalls = true;
          pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
          this.emitWSMessage(sessionId, "stream.tool_call", { agentId, toolCall: { id: event.toolCallId, name: event.toolName, input: {} } });
        } else if (event.type === "tool_use_delta") {
          const tc = pendingToolCalls.get(event.toolCallId!);
          if (tc) tc.input += event.toolInput ?? "";
        } else if (event.type === "tool_use_stop") {
          const call = pendingToolCalls.get(event.toolCallId!);
          if (call) {
            completedToolCalls.push({ id: event.toolCallId!, type: "function", function: { name: call.name, arguments: call.input } });
            pendingToolCalls.delete(event.toolCallId!);
          }
        }
      }
      const turnDuration = performance.now() - turnStart;
      emitTrace(agentId, "llm_turn", { turn: turns, durationMs: turnDuration, tokensIn, tokensOut, usageKnown });

      // Append assistant response to history
      const assistantMsg: ConversationMessage = { role: "assistant", content };
      if (completedToolCalls.length > 0) {
        assistantMsg.tool_calls = completedToolCalls;
      }
      messages.push(assistantMsg);

      // Save to store if Manager
      if (agentId === KORY_IDENTITY.id && content.trim()) {
        this.messages?.add(sessionId, { id: nanoid(12), sessionId, role: "assistant", content, model: modelId, provider: provider.name, createdAt: Date.now() });
      }

      if (!hasToolCalls) {
        // Natural stop
        break; 
      }

      // Execute tools
      for (const tc of completedToolCalls) {
        const { name, arguments: argsStr } = tc.function;
        const callId = tc.id;
        
        let toolOutput;
        const toolStart = performance.now();
        try {
          const args = JSON.parse(argsStr);
          toolOutput = await this.tools.execute(ctx, { id: callId, name, input: args });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolOutput = { callId, name, output: `Error: ${message}`, isError: true, durationMs: 0 };
        }
        const toolDuration = performance.now() - toolStart;
        emitTrace(agentId, "tool_execution", { tool: name, args: argsStr, output: toolOutput.output, isError: toolOutput.isError, durationMs: toolDuration });

        this.emitWSMessage(sessionId, "stream.tool_result", { agentId, toolResult: toolOutput });
        messages.push({ role: "tool", tool_call_id: callId, content: toolOutput.output });
      }
    }
    const loopDuration = performance.now() - loopStart;
    emitTrace(agentId, "execution_loop_complete", { turns, durationMs: loopDuration });
  }

  // ─── UTILS ────────────────────────────────────────────────────────────────

  private async classifyDomainLLM(m: string, managerRouting: { model: string; provider?: ProviderName }): Promise<WorkerDomain> {
    const lower = m.toLowerCase();
    const domainKeywords = DOMAIN.KEYWORDS as Record<string, readonly string[]>;
    
    let bestDomain: WorkerDomain = "general";
    let bestScore = 0;
    
    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      const score = keywords.filter(kw => lower.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain as WorkerDomain;
      }
    }
    
    return bestDomain;
  }

  private buildFallbackChain(startModelId: string): string[] {
    const fallbacks = this.config.fallbacks ?? {};
    const chain: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [startModelId];
    while (stack.length > 0 && chain.length < 25) {
      const modelId = stack.pop()!;
      if (seen.has(modelId)) continue;
      if (isLegacyModel(modelId) && modelId !== startModelId) continue;
      seen.add(modelId);
      chain.push(modelId);
      const next = fallbacks[modelId];
      if (Array.isArray(next)) for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    }
    return chain;
  }

  private resolveActiveRouting(preferredModel?: string, domain: WorkerDomain = "general"): { model: string; provider: ProviderName | undefined } {
    if (preferredModel && preferredModel.includes(":")) {
      const [p, m] = preferredModel.split(":");
      return { provider: p as ProviderName, model: m };
    }
    const assignment = this.config.assignments?.[domain];
    if (assignment && assignment.includes(":")) {
      const [p, m] = assignment.split(":");
      return { provider: p as ProviderName, model: m };
    }
    const modelId = DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
    const def = resolveModel(modelId)!;
    return { model: modelId, provider: def.provider };
  }

  private loadHistory(sessionId: string): ConversationMessage[] { return this.messages?.getRecent(sessionId, 10).map((m) => ({ role: m.role as ConversationMessage["role"], content: m.content })) || []; }
  private emitThought(sessionId: string, phase: string, thought: string) { this.emitWSMessage(sessionId, "kory.thought", { thought, phase }); }
  private emitError(sessionId: string, error: string) { this.emitWSMessage(sessionId, "system.error", { error }); }
  private emitUsageUpdate(
    sessionId: string,
    agentId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean
  ) {
    const context = resolveTrustedContextWindow(model, provider);
    const payload: StreamUsagePayload = {
      agentId, model, provider, tokensIn, tokensOut, tokensUsed: tokensIn + tokensOut, usageKnown, contextKnown: context.contextKnown,
      ...(context.contextWindow ? { contextWindow: context.contextWindow } : {}),
    };
    this.emitWSMessage(sessionId, "stream.usage", payload);
  }
  private emitWSMessage(sessionId: string, type: string, payload: WSMessage["payload"]) { wsBroker.publish("custom", { type: type as WSMessage["type"], payload, timestamp: Date.now(), sessionId, agentId: KORY_IDENTITY.id }); }
}
