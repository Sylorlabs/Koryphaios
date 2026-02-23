// Kory Manager Agent — the orchestrator brain.
// The manager is the only agent the user talks to. Sub-agents (workers) run only when the manager
// explicitly calls the delegate_to_worker tool; the code never auto-spawns workers.

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
import { AGENT, DOMAIN } from "../constants";
import { ProviderRegistry, resolveModel, resolveTrustedContextWindow, isLegacyModel, getNonLegacyModels, withTimeoutSignal, type StreamRequest, type ProviderEvent } from "../providers";
import type { ProviderMessage } from "../providers/types";
import { ToolRegistry, type ToolCallInput, type ToolContext } from "../tools";
import { wsBroker } from "../pubsub";
import { koryLog } from "../logger";
import { nanoid } from "nanoid";
import { sanitizeForPrompt } from "../security";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { join } from "node:path";
import { getDb } from "../db/sqlite";
import type { ISessionStore } from "../stores/session-store";
import type { IMessageStore } from "../stores/message-store";
import { SnapshotManager } from "./snapshot-manager";
import { GitManager } from "./git-manager";
import { parseCriticVerdict, formatMessagesForCritic as formatMessagesForCriticUtil } from "./critic-util";

// ─── Default Model Assignments per Domain ───────────────────────────────────

for (const [domain, modelId] of Object.entries(DOMAIN.DEFAULT_MODELS)) {
  const def = resolveModel(modelId);
  if (!def) {
    throw new Error(`DOMAIN.DEFAULT_MODELS["${domain}"] references unknown model: "${modelId}".`);
  }
}

// ─── Clarification Gate ─────────────────────────────────────────────────────

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

const ClarifyProceedSchema = z.object({ action: z.literal("proceed") }).strict();
const ClarifyQuestionSchema = z.string().trim().min(1).max(140);
const ClarifySchema = z.object({
  action: z.literal("clarify"),
  questions: z.array(ClarifyQuestionSchema).min(1),
  reason: z.string().trim().min(1),
  assumptions: z.array(z.string().trim().min(1)).default([]),
}).strict();

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
  if (!trimmed) return trimmed;
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) return fenced;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const objectStarts = (trimmed.match(/\{/g) ?? []).length;
  const objectEnds = (trimmed.match(/\}/g) ?? []).length;
  if (objectStarts > 1 && objectEnds > 1) return "";
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

/**
 * Parse and validate a raw LLM response as a clarification decision.
 * Returns null if the response is invalid, ambiguous, or violates question rules.
 */
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

/**
 * Resolve a clarification decision, falling back to "proceed" on any parse failure.
 */
export function resolveClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision {
  return parseClarificationDecision(raw, maxQuestions) ?? { action: "proceed" };
}

// ─── Kory Identity ──────────────────────────────────────────────────────────

let KORY_IDENTITY: AgentIdentity = {
  id: "kory-manager",
  name: "Kory",
  role: "manager",
  model: "pending",
  provider: "copilot",
  domain: "general",
  glowColor: "rgba(255,215,0,0.6)", // Gold
};

function koryIdentityWithModel(model: string, provider: ProviderName): AgentIdentity {
  KORY_IDENTITY = { ...KORY_IDENTITY, model, provider };
  return KORY_IDENTITY;
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const KORY_SYSTEM_PROMPT = `You are Kory, the manager agent. The user talks to you only. Sub-agents (workers) run only when you explicitly call delegate_to_worker—never automatically.

• Handle requests yourself: answer questions, use tools (read_file, grep, bash, web_search, etc.), do small edits. For conversation, clarification, or straightforward work, you are the sole agent.
• Sub-agents (workers: general, ui, backend, test, review) exist only for you to invoke when you decide a task needs a specialist coder. Call delegate_to_worker only for substantial implementation, refactoring, or multi-step coding—not for chat, simple questions, or minor edits.
• When you delegate, the worker reports back; you verify and synthesize.`;
const WORKER_SYSTEM_PROMPT = `You are a specialist Worker Agent. EXECUTE the assigned task using tools. QUALITY FIRST. VERIFY.`;

// ─── Kory Manager Class ─────────────────────────────────────────────────────

export interface KoryTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  assignedModel: string;
  assignedProvider: ProviderName;
  status: "pending" | "active" | "done" | "failed";
  result?: string;
  error?: string;
}

export class KoryManager {
  private activeWorkers = new Map<string, { agent: AgentIdentity; status: AgentStatus; task: KoryTask; abort: AbortController; sessionId: string }>();
  private workerUsage = new Map<string, { tokensIn: number; tokensOut: number; usageKnown: boolean }>();
  private tasks: KoryTask[] = [];
  private memoryDir: string;
  private isProcessing = false;
  private isYoloMode = false;
  private pendingUserInputs = new Map<string, (selection: string) => void>();
  private sessionChanges = new Map<string, ChangeSummary[]>();
  private snapshotManager: SnapshotManager;
  public readonly git: GitManager;
  private lastKnownGoodHash = new Map<string, string>();
  /** AbortController for the current manager run per session (so cancelSessionWorkers can abort manager too). */
  private managerAbortBySession = new Map<string, AbortController>();

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
  }

  setYoloMode(enabled: boolean) {
    this.isYoloMode = enabled;
    koryLog.info({ enabled }, "YOLO mode state updated");
  }

  /** Reasoning level the manager uses for delegated workers (from config). */
  private getWorkerReasoningLevel(): string {
    return (this.config.agents?.manager as { reasoningLevel?: string } | undefined)?.reasoningLevel ?? AGENT.DEFAULT_REASONING_LEVEL;
  }

  private async extractAllowedPaths(sessionId: string, plan: string, preferredModel?: string): Promise<string[]> {
    const routing = this.resolveActiveRouting(preferredModel, "general", true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return [];

    const prompt = `Identify paths to modify or read. PLAN: ${plan}. Return ONLY JSON array.`;
    let result = "";
    try {
      const stream = provider.streamResponse({ model: routing.model, systemPrompt: "JSON only.", messages: [{ role: "user", content: prompt }], maxTokens: 300 });
      for await (const event of stream) if (event.type === "content_delta") result += event.content ?? "";
      return JSON.parse(result.trim().match(/\[.*\]/s)?.[0] || "[]");
    } catch { return []; }
  }

  private updateWorkflowState(sessionId: string, state: string) {
    getDb().run("UPDATE sessions SET workflow_state = ? WHERE id = ?", [state, sessionId]);
  }

  handleUserInput(sessionId: string, selection: string, text?: string) {
    const key = `${sessionId}`;
    const resolver = this.pendingUserInputs.get(key);
    if (resolver) { resolver(text || selection); this.pendingUserInputs.delete(key); }
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

  private async handleManagerInquiry(sessionId: string, agentId: string, question: string, preferredModel?: string): Promise<string> {
    this.emitThought(sessionId, "analyzing", `Worker help: "${question}"`);
    const routing = this.resolveActiveRouting(preferredModel, "general", true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return "Error.";

    let decision = "ANSWER";
    try {
      const stream = provider.streamResponse({ model: routing.model, systemPrompt: "Reply: WEB_SEARCH or ANSWER.", messages: [{ role: "user", content: question }], maxTokens: 10 });
      for await (const event of stream) if (event.type === "content_delta") decision += event.content ?? "";
      decision = decision.trim().toUpperCase();
    } catch { }

    if (decision.includes("WEB_SEARCH")) {
      const toolCtx: ToolContext = { sessionId, workingDirectory: this.workingDirectory };
      const searchResult = await this.tools.execute(toolCtx, { id: nanoid(10), name: "web_search", input: { query: question } });
      return `MANAGER ADVICE: ${searchResult.output}`;
    }
    return `MANAGER ANSWER: I recommend proceeding with the current task.`;
  }

  private async waitForUserInputInternal(sessionId: string, question: string, options: string[]): Promise<string> {
    this.emitWSMessage(sessionId, "kory.ask_user", { question, options, allowOther: true } satisfies KoryAskUserPayload);
    return new Promise<string>((resolve) => { this.pendingUserInputs.set(`${sessionId}`, resolve); });
  }

  /** Main entry point for processing a task. */
  async processTask(sessionId: string, userMessage: string, preferredModel?: string, reasoningLevel?: string): Promise<void> {
    this.isProcessing = true;
    this.sessionChanges.delete(sessionId);
    userMessage = sanitizeForPrompt(userMessage);

    // Resolve provider before any UI updates or work. No provider = manager responds once and returns.
    let routing = this.resolveActiveRouting(preferredModel, "general", true);
    let provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider && (!preferredModel || preferredModel === "auto")) {
      const fallback = this.providers.getFirstAvailableRouting();
      if (fallback) {
        routing = { model: fallback.model, provider: fallback.provider };
        provider = this.providers.resolveProvider(routing.model, routing.provider);
      }
    }
    if (!provider) {
      this.updateWorkflowState(sessionId, "idle");
      this.emitError(sessionId, "No provider. No analyzing request. Add a provider in Settings.");
      this.isProcessing = false;
      return;
    }

    this.updateWorkflowState(sessionId, "analyzing");
    try {
      this.emitThought(sessionId, "analyzing", `Analyzing request...`);
      await this.handleDirectly(sessionId, userMessage, reasoningLevel, preferredModel);

      this.updateWorkflowState(sessionId, "idle");
      const changes = this.sessionChanges.get(sessionId) || [];
      if (changes.length > 0) this.emitWSMessage(sessionId, "session.changes", { changes });

    } catch (err) {
      this.updateWorkflowState(sessionId, "error");
      this.emitError(sessionId, `Error: ${String(err)}`);
    } finally { this.isProcessing = false; }
  }

  private buildFallbackChain(startModelId: string): string[] {
    const fallbacks = this.config.fallbacks ?? {};
    const chain: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [startModelId];
    while (stack.length > 0 && chain.length < 25) {
      const modelId = stack.pop()!;
      if (seen.has(modelId) || isLegacyModel(modelId)) continue;
      seen.add(modelId);
      chain.push(modelId);
      const next = fallbacks[modelId];
      if (Array.isArray(next)) for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    }
    return chain;
  }

  /** Resolves the routing (model/provider) for a domain, prioritizing user selection. When avoidLegacy is true (manager), never returns a legacy/deprecated model. */
  private resolveActiveRouting(preferredModel?: string, domain: WorkerDomain = "general", avoidLegacy = false): { model: string; provider: ProviderName | undefined } {
    let out: { model: string; provider: ProviderName | undefined };
    if (preferredModel && preferredModel.includes(":")) {
      const [p, m] = preferredModel.split(":");
      out = { provider: p as ProviderName, model: m };
    } else {
      const assignment = this.config.assignments?.[domain];
      if (assignment && assignment.includes(":")) {
        const [p, m] = assignment.split(":");
        out = { provider: p as ProviderName, model: m };
      } else {
        const modelId = DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
        const def = resolveModel(modelId)!;
        out = { model: modelId, provider: def.provider };
      }
    }
    if (avoidLegacy && isLegacyModel(out.model)) {
      const nonLegacy = getNonLegacyModels();
      const sameProvider = nonLegacy.find((m) => m.provider === out.provider);
      const fallback = sameProvider ?? nonLegacy[0];
      if (fallback) out = { model: fallback.id, provider: fallback.provider };
    }
    return out;
  }

  /**
   * Run the worker pipeline (confirm if needed, routeToWorker, return summary).
   * Used when the manager explicitly calls delegate_to_worker. Only the manager LLM decides to spawn a worker.
   */
  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string
  ): Promise<string> {
    if (!this.isYoloMode) {
      const selection = await this.waitForUserInputInternal(sessionId, "Ready to proceed with the delegated task?", ["Yes, proceed", "Cancel"]);
      if (selection.includes("Cancel")) return "Cancelled by user.";
    } else {
      this.emitThought(sessionId, "executing", "YOLO mode: Proceeding with delegated task.");
    }
    this.updateWorkflowState(sessionId, "executing");
    const domainOverride = (domainHint && ["general", "ui", "backend", "test", "review"].includes(domainHint)) ? domainHint as WorkerDomain : undefined;
    const result = await this.routeToWorker(sessionId, task, preferredModel, reasoningLevel, ["."], domainOverride);
    this.updateWorkflowState(sessionId, "idle");
    if (result.success) {
      return result.criticFeedback ?? (result.workerTranscript ? "Worker completed. See transcript." : "Done.");
    }
    return result.workerTranscript ? `Worker did not pass review. ${result.criticFeedback ?? ""}` : "Worker failed.";
  }

  private async routeToWorker(sessionId: string, userMessage: string, preferredModel?: string, reasoningLevel?: string, allowedPaths: string[] = [], domainOverride?: WorkerDomain): Promise<{ success: boolean; workerTranscript?: string; criticFeedback?: string }> {
    let domain: WorkerDomain;
    if (domainOverride) domain = domainOverride;
    else try { domain = this.classifyDomainLLM(userMessage); } catch { domain = "general"; }
    const isSandboxed = !this.requiresSystemAccess(userMessage);

    if (this.git.isGitRepo()) {
      const hash = this.git.getCurrentHash();
      if (hash) this.lastKnownGoodHash.set(sessionId, hash);
    } else {
      this.snapshotManager.createSnapshot(sessionId, "latest", allowedPaths.length > 0 ? allowedPaths : ["."], this.workingDirectory);
    }

    let workerTask = await this.generateWorkerTask(sessionId, userMessage, domain, preferredModel);
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      this.emitThought(sessionId, "delegating", `Delegating to ${domain} worker...`);
      const routing = this.resolveActiveRouting(preferredModel, domain);
      const provider = this.providers.getAvailable().find(p => p.name === routing.provider);
      if (!provider) {
        const alt = this.providers.getAvailable()[0];
        if (!alt) return { success: false };
        const res = await this.executeWithProvider(sessionId, alt, routing.model, workerTask, domain, reasoningLevel, true, allowedPaths, isSandboxed);
        if (res.success) {
          const criticResult = await this.runCriticGate(sessionId, res.workerMessages, preferredModel);
          if (criticResult.passed) return { success: true, workerTranscript: formatMessagesForCriticUtil(res.workerMessages ?? []), criticFeedback: criticResult.feedback };
          workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
        } else return { success: false };
      }

      const result = await this.executeWithProvider(sessionId, provider, routing.model, workerTask, domain, reasoningLevel, true, allowedPaths, isSandboxed);
      if (result.success) {
        const criticResult = await this.runCriticGate(sessionId, result.workerMessages, preferredModel);
        if (criticResult.passed) return { success: true, workerTranscript: formatMessagesForCriticUtil(result.workerMessages ?? []), criticFeedback: criticResult.feedback };
        workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
      }
      if (!this.providers.isQuotaError(result.error)) return { success: false };
    }
    return { success: false };
  }

  /** Critic can only read files and grep. It sees the full worker transcript (truncated) and outputs PASS or FAIL with feedback. */
  private async runCriticGate(sessionId: string, workerMessages: any[] | undefined, preferredModel?: string): Promise<{ passed: boolean; feedback?: string }> {
    const hardCheckResult = await this.runHardChecks(sessionId);
    if (!hardCheckResult.passed) return { passed: false, feedback: hardCheckResult.output };

    const routing = this.resolveActiveRouting(preferredModel, "critic");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return { passed: true };

    const transcriptText = formatMessagesForCriticUtil(workerMessages ?? [], 12_000);
    const criticSystemPrompt = `You are the Critic agent. You may only use read_file, grep, glob, and ls to inspect the codebase. You see the worker conversation below. Review the work and output either PASS or FAIL. If FAIL, give brief, actionable feedback. Your final message must end with a line that starts with exactly PASS or exactly FAIL (e.g. "PASS" or "FAIL: missing tests").`;
    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: this.workingDirectory,
      allowedPaths: [],
      isSandboxed: true,
    };

    const messages: any[] = [
      { role: "user", content: `Worker transcript to review:\n\n${transcriptText}\n\nUse read_file/grep/glob/ls as needed. Then output PASS or FAIL and brief feedback.` },
    ];

    let lastContent = "";
    let turnCount = 0;
    while (turnCount < 5) {
      turnCount++;
      const criticSignal = withTimeoutSignal(undefined, AGENT.LLM_STREAM_TIMEOUT_MS);
      const stream = this.providers.executeWithRetry(
        {
          model: routing.model,
          systemPrompt: criticSystemPrompt,
          messages: this.toProviderMessages(messages),
          tools: this.tools.getToolDefsForRole("critic"),
          maxTokens: 2048,
          signal: criticSignal,
        },
        routing.provider,
        this.buildFallbackChain(routing.model)
      );
      let assistantContent = "";
      const completedToolCalls: any[] = [];
      let pendingToolCalls = new Map<string, { name: string; input: string }>();

      for await (const event of stream) {
        if (event.type === "content_delta") assistantContent += event.content ?? "";
        else if (event.type === "tool_use_start") pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        else if (event.type === "tool_use_delta") { const tc = pendingToolCalls.get(event.toolCallId!); if (tc) tc.input += event.toolInput ?? ""; }
        else if (event.type === "tool_use_stop") {
          const call = pendingToolCalls.get(event.toolCallId!);
          if (call) {
            let parsedInput = {};
            try { parsedInput = JSON.parse(call.input || "{}"); } catch { }
            completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
            pendingToolCalls.delete(event.toolCallId!);
          }
        }
      }

      messages.push({ role: "assistant", content: assistantContent });
      lastContent = assistantContent;

      if (completedToolCalls.length === 0) break;
      for (const tc of completedToolCalls) {
        const result = await this.tools.execute(criticCtx, { id: tc.id, name: tc.name, input: tc.input });
        messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id } as any);
      }
    }

    const passed = parseCriticVerdict(lastContent);
    return { passed, feedback: lastContent.trim() };
  }

  private async runHardChecks(sessionId: string): Promise<{ passed: boolean; output: string }> {
    const pkgPath = join(this.workingDirectory, "package.json");
    if (!existsSync(pkgPath)) return { passed: true, output: "" };
    const bash = this.tools.get("bash")!;
    const result = await bash.run({ sessionId, workingDirectory: this.workingDirectory, isSandboxed: true }, { id: nanoid(), name: "bash", input: { command: "npm test", timeout: 60 } });
    return { passed: !result.isError, output: result.output };
  }

  private requiresSystemAccess(m: string): boolean { return ["install", "sudo", "apt"].some(k => m.toLowerCase().includes(k)); }

  private classifyDomainLLM(message: string): WorkerDomain {
    const lower = message.toLowerCase();
    const scores: Record<string, number> = {};
    for (const [domain, keywords] of Object.entries(DOMAIN.KEYWORDS)) {
      scores[domain] = (keywords as readonly string[]).filter(k => lower.includes(k)).length;
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return (best && best[1] > 0 ? best[0] : "general") as WorkerDomain;
  }

  /** Manager handles simple tasks directly with full tool access (unsandboxed). Asks user before first tool run unless YOLO. Manager never uses legacy models. */
  private async handleDirectly(sessionId: string, userMessage: string, reasoningLevel?: string, preferredModel?: string): Promise<void> {
    const routing = this.resolveActiveRouting(preferredModel, "general", true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) throw new Error("No provider.");
    const providerName = provider.name as ProviderName;

    const abort = new AbortController();
    this.managerAbortBySession.set(sessionId, abort);

    try {
      this.emitWSMessage(sessionId, "agent.status", { agentId: KORY_IDENTITY.id, status: "thinking" });
      let tokensIn = 0;
      let tokensOut = 0;
      let usageKnown = false;
      this.emitUsageUpdate(sessionId, KORY_IDENTITY.id, routing.model, providerName, tokensIn, tokensOut, usageKnown);

      const managerCtx: ToolContext = {
        sessionId,
        workingDirectory: this.workingDirectory,
        allowedPaths: [],
        isSandboxed: false,
        signal: abort.signal,
        waitForUserInput: (question: string, options: string[]) => this.waitForUserInputInternal(sessionId, question, options),
        emitFileEdit: (e) => this.emitWSMessage(sessionId, "stream.file_delta", { agentId: KORY_IDENTITY.id, ...e }),
        emitFileComplete: (e) => this.emitWSMessage(sessionId, "stream.file_complete", { agentId: KORY_IDENTITY.id, ...e }),
        recordChange: (c) => {
          const arr = this.sessionChanges.get(sessionId) || [];
          arr.push(c);
          this.sessionChanges.set(sessionId, arr);
        },
        delegateToWorker: (task: string, domainHint?: string) =>
          this.runWorkerPipeline(sessionId, task, preferredModel, this.getWorkerReasoningLevel(), domainHint),
      };

      const history = this.loadHistory(sessionId);
      const messages: any[] = [...history, { role: "user", content: userMessage }];
      let turnCount = 0;
      let firstAskForDirectTools = true;
      let stoppedByUser = false;

      while (turnCount < 25) {
        if (abort.signal.aborted) { stoppedByUser = true; break; }
        turnCount++;
        let result: { success: boolean; content?: string; usage?: { tokensIn: number; tokensOut: number }; completedToolCalls?: any[] };
        try {
          result = await this.processManagerTurn(sessionId, routing.model, provider, messages, managerCtx, abort.signal);
        } catch (err: any) {
          if (err?.name === "AbortError") { stoppedByUser = true; break; }
          throw err;
        }
        if (typeof result.usage?.tokensIn === "number") tokensIn = Math.max(tokensIn, result.usage.tokensIn);
        if (typeof result.usage?.tokensOut === "number") tokensOut = Math.max(tokensOut, result.usage.tokensOut);

        if (!result.success) break;

        const { completedToolCalls } = result;
        if (completedToolCalls && completedToolCalls.length > 0) {
          if (!this.isYoloMode && firstAskForDirectTools) {
            const selection = await this.waitForUserInputInternal(sessionId, "Manager will run tools to complete this task. Proceed?", ["Yes, proceed", "Cancel"]);
            firstAskForDirectTools = false;
            if (selection.includes("Cancel")) {
              if (this.messages) this.messages.add(sessionId, { id: nanoid(12), sessionId, role: "assistant", content: "[Cancelled by user.]", model: routing.model, provider: providerName, createdAt: Date.now() });
              break;
            }
          }
          for (const tc of completedToolCalls) {
            if (abort.signal.aborted) { stoppedByUser = true; break; }
            const toolResult = await this.executeManagerToolCall(sessionId, tc, managerCtx);
            this.emitWSMessage(sessionId, "stream.tool_result", { agentId: KORY_IDENTITY.id, toolResult });
            messages.push({ role: "tool", content: JSON.stringify(toolResult), tool_call_id: tc.id });
          }
        }
      }

      const lastAssistant = messages.filter((m: any) => m.role === "assistant").pop();
      const content = (lastAssistant?.content ?? "").trim();
      const toPersist = stoppedByUser ? "[Stopped by user.]" : (content || "[Task completed using tools.]");
      if (this.messages) this.messages.add(sessionId, { id: nanoid(12), sessionId, role: "assistant", content: toPersist, model: routing.model, provider: providerName, createdAt: Date.now() });
      this.emitWSMessage(sessionId, "agent.status", { agentId: KORY_IDENTITY.id, status: "done" });

      const changes = this.sessionChanges.get(sessionId) || [];
      if (changes.length > 0) this.emitWSMessage(sessionId, "session.changes", { changes });
    } finally {
      this.managerAbortBySession.delete(sessionId);
      this.updateWorkflowState(sessionId, "idle");
    }
  }

  private async processManagerTurn(
    sessionId: string,
    modelId: string,
    provider: any,
    messages: any[],
    ctx: ToolContext,
    signal?: AbortSignal
  ): Promise<{ success: boolean; content?: string; usage?: { tokensIn: number; tokensOut: number }; completedToolCalls?: any[] }> {
    if (signal?.aborted) throw new DOMException("Manager run aborted", "AbortError");
    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt: KORY_SYSTEM_PROMPT,
        messages: this.toProviderMessages(messages),
        tools: this.tools.getToolDefsForRole("manager"),
        maxTokens: 16384,
        signal: streamSignal,
      },
      provider.name
    );

    let assistantContent = "";
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: any[] = [];
    let hasToolCalls = false;
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const event of stream) {
      if (signal?.aborted) throw new DOMException("Manager run aborted", "AbortError");
      if (event.type === "error") {
        throw new Error((event as any).error ?? "LLM stream error");
      }
      if (event.type === "content_delta") {
        assistantContent += event.content ?? "";
        this.emitWSMessage(sessionId, "stream.delta", { agentId: KORY_IDENTITY.id, content: event.content, model: modelId });
      } else if (event.type === "usage_update") {
        if (typeof event.tokensIn === "number") tokensIn = Math.max(tokensIn, event.tokensIn);
        if (typeof event.tokensOut === "number") tokensOut = Math.max(tokensOut, event.tokensOut);
        this.emitUsageUpdate(sessionId, KORY_IDENTITY.id, modelId, provider.name, tokensIn, tokensOut, true);
      } else if (event.type === "tool_use_start") {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        this.emitWSMessage(sessionId, "stream.tool_call", { agentId: KORY_IDENTITY.id, toolCall: { id: event.toolCallId, name: event.toolName, input: {} } });
      } else if (event.type === "tool_use_delta") {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? "";
      } else if (event.type === "tool_use_stop") {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try { parsedInput = JSON.parse(call.input || "{}"); } catch { }
          completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    messages.push({ role: "assistant", content: assistantContent });

    if (hasToolCalls && completedToolCalls.length > 0) {
      return { success: true, content: assistantContent, usage: { tokensIn, tokensOut }, completedToolCalls };
    }
    return { success: false, content: assistantContent, usage: { tokensIn, tokensOut } };
  }

  private async executeManagerToolCall(sessionId: string, tc: any, ctx: ToolContext): Promise<any> {
    if (tc.name === "ask_user") {
      const question = (tc.input?.question as string) ?? "Proceed?";
      const options = (tc.input?.options as string[]) ?? ["Yes", "No"];
      const selection = await this.waitForUserInputInternal(sessionId, question, options);
      return { callId: tc.id, name: tc.name, output: `User selected: ${selection}`, isError: false, durationMs: 0 };
    }
    return await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
  }

  /**
   * Runs a worker (sub-agent). Only called from routeToWorker, which is only called from
   * runWorkerPipeline, which is invoked solely when the manager calls the delegate_to_worker tool.
   * The code never auto-spawns workers.
   */
  private async executeWithProvider(sessionId: string, provider: any, modelId: string, userMessage: string, domain: WorkerDomain, reasoningLevel: any, isAutoMode: boolean, allowedPaths: string[], isSandboxed: boolean): Promise<{ success: boolean; error?: string; workerMessages?: any[] }> {
    const workerId = `worker-${nanoid(8)}`;
    const abort = new AbortController();
    const identity: AgentIdentity = { id: workerId, name: `${domain} Worker`, role: "coder", model: modelId, provider: provider.name, domain, glowColor: DOMAIN.GLOW_COLORS[domain] };
    this.emitWSMessage(sessionId, "agent.spawned", { agent: identity, task: userMessage });
    let tokensIn = 0;
    let tokensOut = 0;
    let usageKnown = false;
    this.emitUsageUpdate(sessionId, workerId, modelId, provider.name, tokensIn, tokensOut, usageKnown);
    this.activeWorkers.set(workerId, { agent: identity, status: "thinking", task: { id: workerId, description: userMessage, domain, assignedModel: modelId, assignedProvider: provider.name, status: "active" }, abort, sessionId });

    const ctx: ToolContext = { sessionId, workingDirectory: this.workingDirectory, signal: abort.signal, allowedPaths, isSandboxed, emitFileEdit: (e) => this.emitWSMessage(sessionId, "stream.file_delta", { agentId: workerId, ...e }), emitFileComplete: (e) => this.emitWSMessage(sessionId, "stream.file_complete", { agentId: workerId, ...e }), recordChange: (c) => { const e = this.sessionChanges.get(sessionId) || []; e.push(c); this.sessionChanges.set(sessionId, e); } };
    const history = this.loadHistory(sessionId);
    const messages: any[] = [...history, { role: "user", content: userMessage }];
    const resolvedReasoningLevel = reasoningLevel === "auto" ? determineAutoReasoningLevel(userMessage) : reasoningLevel;

    try {
      let turnCount = 0;
      while (turnCount < 25) {
        turnCount++;
        const success = await this.processProviderTurn(sessionId, workerId, modelId, provider, messages, ctx, resolvedReasoningLevel);
        if (!success) break;
      }
      this.activeWorkers.delete(workerId);
      this.workerUsage.delete(workerId);
      return { success: true, workerMessages: [...messages] };
    } catch (err: any) {
      this.activeWorkers.delete(workerId);
      this.workerUsage.delete(workerId);
      return { success: false, error: err.message };
    }
  }

  private async processProviderTurn(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: any,
    messages: any[],
    ctx: ToolContext,
    reasoningLevel?: string
  ): Promise<boolean> {
    const normalizedReasoning = normalizeReasoningLevel(provider.name, modelId, reasoningLevel);
    const streamSignal = withTimeoutSignal(ctx.signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt: WORKER_SYSTEM_PROMPT,
        messages: this.toProviderMessages(messages),
        tools: this.tools.getToolDefsForRole("worker"),
        maxTokens: 16384,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
      },
      provider.name
    );

    let assistantContent = "";
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: any[] = [];
    let hasToolCalls = false;

    for await (const event of stream) {
      if (event.type === "error") {
        throw new Error((event as any).error ?? "LLM stream error");
      }
      if (event.type === "content_delta") {
        assistantContent += event.content;
        this.emitWSMessage(sessionId, "stream.delta", { agentId: workerId, content: event.content, model: modelId });
      } else if (event.type === "usage_update") {
        this.updateUsageFromEvent(sessionId, workerId, modelId, provider.name, event);
      } else if (event.type === "tool_use_start") {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        this.emitWSMessage(sessionId, "stream.tool_call", {
          agentId: workerId,
          toolCall: { id: event.toolCallId, name: event.toolName, input: {} },
        });
      } else if (event.type === "tool_use_delta") {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? "";
      } else if (event.type === "tool_use_stop") {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(call.input || "{}");
          } catch (e) { }
          completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    messages.push({ role: "assistant", content: assistantContent });

    if (hasToolCalls && completedToolCalls.length > 0) {
      for (const tc of completedToolCalls) {
        const result = await this.executeToolCall(sessionId, workerId, tc, ctx);
        this.emitWSMessage(sessionId, "stream.tool_result", { agentId: workerId, toolResult: result });
        messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id });
      }
      return true; // Continue to next turn
    }

    return false; // Task complete
  }

  private updateUsageFromEvent(sessionId: string, workerId: string, modelId: string, provider: string, event: any) {
    let usage = this.workerUsage.get(workerId);
    if (!usage) {
      usage = { tokensIn: 0, tokensOut: 0, usageKnown: false };
      this.workerUsage.set(workerId, usage);
    }
    if (typeof event.tokensIn === "number") usage.tokensIn = Math.max(usage.tokensIn, event.tokensIn);
    if (typeof event.tokensOut === "number") usage.tokensOut = Math.max(usage.tokensOut, event.tokensOut);
    if (typeof event.tokensIn === "number" || typeof event.tokensOut === "number") usage.usageKnown = true;
    this.emitUsageUpdate(sessionId, workerId, modelId, provider as ProviderName, usage.tokensIn, usage.tokensOut, usage.usageKnown);
  }

  private async executeToolCall(sessionId: string, workerId: string, tc: any, ctx: ToolContext): Promise<any> {
    if (tc.name === "ask_manager") {
      const ans = await this.handleManagerInquiry(sessionId, workerId, tc.input.question);
      return { callId: tc.id, name: tc.name, output: ans, isError: false, durationMs: 0 };
    }
    return await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
  }
  cancelWorker(agentId: string) {
    const worker = this.activeWorkers.get(agentId);
    if (worker) {
      this.emitWSMessage(worker.sessionId, "agent.status", { agentId, status: "done" });
      worker.abort.abort();
      this.activeWorkers.delete(agentId);
      koryLog.info({ agentId }, "Worker cancelled");
    }
  }

  cancelSessionWorkers(sessionId: string) {
    this.abortManagerRun(sessionId);
    this.emitWSMessage(sessionId, "agent.status", { agentId: KORY_IDENTITY.id, status: "done" });
    for (const [id, worker] of this.activeWorkers.entries()) {
      if (worker.sessionId === sessionId) {
        this.emitWSMessage(sessionId, "agent.status", { agentId: id, status: "done" });
        worker.abort.abort();
        this.activeWorkers.delete(id);
        koryLog.info({ agentId: id, sessionId }, "Session worker cancelled");
      }
    }
  }

  /** True if the session has an active manager run or any worker. */
  isSessionRunning(sessionId: string): boolean {
    if (this.managerAbortBySession.has(sessionId)) return true;
    for (const worker of this.activeWorkers.values()) {
      if (worker.sessionId === sessionId) return true;
    }
    return false;
  }

  getStatus() {
    return Array.from(this.activeWorkers.values()).map(w => ({
      agent: w.agent,
      status: w.status,
      task: w.task.description,
      sessionId: w.sessionId
    }));
  }

  cancel() {
    const sessionIds = new Set<string>();
    for (const worker of this.activeWorkers.values()) {
      sessionIds.add(worker.sessionId);
      this.emitWSMessage(worker.sessionId, "agent.status", { agentId: worker.agent.id, status: "done" });
      worker.abort.abort();
    }
    this.activeWorkers.clear();
    this.managerAbortBySession.forEach((ac, sid) => {
      sessionIds.add(sid);
      ac.abort();
    });
    this.managerAbortBySession.clear();
    for (const sid of sessionIds) {
      this.emitWSMessage(sid, "agent.status", { agentId: KORY_IDENTITY.id, status: "done" });
    }
    this.isProcessing = false;
    koryLog.info("All workers cancelled via global cancel");
  }

  private async generateWorkerTask(sessionId: string, message: string, domain: WorkerDomain, preferredModel?: string): Promise<string> {
    const routing = this.resolveActiveRouting(preferredModel, "general", true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return message;
    let res = "";
    try {
      for await (const event of provider.streamResponse({ model: routing.model, systemPrompt: "Be brief and actionable.", messages: [{ role: "user", content: `Worker instruction for ${domain}: ${message}` }], maxTokens: 200 })) if (event.type === "content_delta") res += event.content;
      return res.trim() || message;
    } catch { return message; }
  }

  private loadHistory(sessionId: string): any[] { return this.messages?.getRecent(sessionId, 10).map((m: any) => ({ role: m.role, content: m.content })) || []; }

  /** Build provider messages with tool_call_id for role "tool" so APIs receive valid tool results. */
  private toProviderMessages(messages: any[]): ProviderMessage[] {
    return messages.map((m: any) => {
      const out: ProviderMessage = { role: m.role, content: m.content };
      if (m.role === "tool" && m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
      return out;
    });
  }

  abortManagerRun(sessionId: string): void {
    const controller = this.managerAbortBySession.get(sessionId);
    if (controller) {
      controller.abort();
      this.managerAbortBySession.delete(sessionId);
      koryLog.info({ sessionId }, "Manager run aborted");
    }
  }

  private emitThought(sessionId: string, phase: string, thought: string) { this.emitWSMessage(sessionId, "kory.thought", { thought, phase }); }
  private emitRouting(sessionId: string, d: WorkerDomain, m: string, p: string) { this.emitWSMessage(sessionId, "kory.routing", { domain: d, selectedModel: m, selectedProvider: p, reasoning: `Routing to ${m} via ${p}` }); }
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
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      tokensUsed: tokensIn + tokensOut,
      usageKnown,
      contextKnown: context.contextKnown,
      ...(context.contextWindow ? { contextWindow: context.contextWindow } : {}),
    };
    this.emitWSMessage(sessionId, "stream.usage", payload);
  }
  private emitWSMessage(sessionId: string, type: string, payload: WSMessage["payload"]) { wsBroker.publish("custom", { type: type as WSMessage["type"], payload, timestamp: Date.now(), sessionId, agentId: KORY_IDENTITY.id }); }
}
