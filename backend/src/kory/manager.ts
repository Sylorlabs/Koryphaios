// Kory Manager Agent — the orchestrator brain.
// Classifies intent, routes to specialist workers, verifies output.

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
import { ProviderRegistry, resolveModel, resolveTrustedContextWindow, isLegacyModel, type StreamRequest, type ProviderEvent } from "../providers";
import { ToolRegistry, type ToolCallInput, type ToolContext } from "../tools";
import { wsBroker } from "../pubsub";
import { koryLog } from "../logger";
import { nanoid } from "nanoid";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDb } from "../db/sqlite";
import type { ISessionStore } from "../stores/session-store";
import type { IMessageStore } from "../stores/message-store";
import { SnapshotManager } from "./snapshot-manager";
import { GitManager } from "./git-manager";

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
  model: "gpt-4.1",
  provider: "copilot",
  domain: "general",
  glowColor: "rgba(255,215,0,0.6)", // Gold
};

// ─── System Prompts ──────────────────────────────────────────────────────────

const KORY_SYSTEM_PROMPT = `You are Kory, the orchestrating manager agent for Koryphaios. ANALYZE, CLASSIFY, DELEGATE, VERIFY, SYNTHESIZE.`;
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
  private tasks: KoryTask[] = [];
  private memoryDir: string;
  private isProcessing = false;
  private isYoloMode = false;
  private pendingUserInputs = new Map<string, (selection: string) => void>();
  private sessionChanges = new Map<string, ChangeSummary[]>();
  private snapshotManager: SnapshotManager;
  public readonly git: GitManager;
  private lastKnownGoodHash = new Map<string, string>();

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

  private async extractAllowedPaths(sessionId: string, plan: string, preferredModel?: string): Promise<string[]> {
    const routing = this.resolveActiveRouting(preferredModel, "general");
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
    const routing = this.resolveActiveRouting(preferredModel, "general");
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
    this.updateWorkflowState(sessionId, "analyzing");

    // Determine the active model for Kory's own reasoning turns
    const routing = this.resolveActiveRouting(preferredModel, "general");

    try {
      this.emitThought(sessionId, "analyzing", `Analyzing request...`);
      
      // Update UI state for manager
      this.emitWSMessage(sessionId, "agent.spawned", {
        agent: { ...KORY_IDENTITY, model: routing.model, provider: routing.provider || "auto" as any },
        task: userMessage
      });

      const needsWorker = await this.decideIfNeedsWorker(sessionId, userMessage, preferredModel);
      if (!needsWorker) { await this.handleDirectly(sessionId, userMessage, reasoningLevel, preferredModel); return; }

      this.updateWorkflowState(sessionId, "planning");
      let plan = "";
      const planStream = this.providers.executeWithRetry({ 
        model: routing.model, 
        systemPrompt: `Analyze: "${userMessage}". Describe plan.`, 
        messages: [{ role: "user", content: "Propose a plan." }], 
        maxTokens: 500 
      }, routing.provider, this.buildFallbackChain(routing.model));
      
      for await (const event of planStream) if (event.type === "content_delta") { 
        plan += event.content; 
        this.emitWSMessage(sessionId, "stream.delta", { agentId: KORY_IDENTITY.id, content: event.content, model: routing.model }); 
      }

      const allowedPaths = await this.extractAllowedPaths(sessionId, plan, preferredModel);

      let proceed = this.isYoloMode;
      if (!proceed) {
        const readySelection = await this.waitForUserInputInternal(sessionId, "Ready to proceed?", ["Yes, proceed", "Cancel"]);
        if (readySelection.includes("Cancel")) return;
        proceed = true;
      } else {
        this.emitThought(sessionId, "executing", "YOLO mode: Auto-proceeding.");
      }

      this.updateWorkflowState(sessionId, "executing");
      const workerSuccess = await this.routeToWorker(sessionId, userMessage, preferredModel, reasoningLevel, allowedPaths);

      if (workerSuccess) {
        this.updateWorkflowState(sessionId, "finalizing");
        this.emitThought(sessionId, "verifying", "Finalizing...");
        
        let summary = "";
        const vStream = this.providers.executeWithRetry({ 
          model: routing.model, 
          systemPrompt: "Summarize work.", 
          messages: [{ role: "user", content: "Summarize." }], 
          maxTokens: 1000 
        }, routing.provider, this.buildFallbackChain(routing.model));
        
        for await (const event of vStream) if (event.type === "content_delta") { 
          summary += event.content; 
          this.emitWSMessage(sessionId, "stream.delta", { agentId: KORY_IDENTITY.id, content: event.content, model: routing.model }); 
        }
        this.updateWorkflowState(sessionId, "idle");
      }

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

  /** Resolves the routing (model/provider) for a domain, prioritizing user selection. */
  private resolveActiveRouting(preferredModel?: string, domain: WorkerDomain = "general"): { model: string; provider: ProviderName | undefined } {
    if (preferredModel && preferredModel.includes(":")) {
      const [p, m] = preferredModel.split(":");
      return { provider: p as ProviderName, model: m };
    }
    
    // Fallback to domain-specific assignment or defaults
    const assignment = this.config.assignments?.[domain];
    if (assignment && assignment.includes(":")) {
      const [p, m] = assignment.split(":");
      return { provider: p as ProviderName, model: m };
    }
    
    const modelId = DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
    const def = resolveModel(modelId)!;
    return { model: modelId, provider: def.provider };
  }

  private async routeToWorker(sessionId: string, userMessage: string, preferredModel?: string, reasoningLevel?: string, allowedPaths: string[] = []): Promise<boolean> {
    let domain: WorkerDomain;
    try { domain = await this.classifyDomainLLM(userMessage, preferredModel); } catch { domain = "general"; }
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
        // Failover if specific provider not available
        const alt = this.providers.getAvailable()[0];
        if (!alt) return false;
        const res = await this.executeWithProvider(sessionId, alt, routing.model, workerTask, domain, reasoningLevel, true, allowedPaths, isSandboxed);
        if (res.success) {
           if ((await this.runCriticGate(sessionId, workerTask, domain, preferredModel)).passed) return true;
        }
        return false;
      }

      const result = await this.executeWithProvider(sessionId, provider, routing.model, workerTask, domain, reasoningLevel, true, allowedPaths, isSandboxed);
      if (result.success) {
        const criticResult = await this.runCriticGate(sessionId, workerTask, domain, preferredModel);
        if (criticResult.passed) return true;
        workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
      }
      if (!this.providers.isQuotaError(result.error)) return false;
    }
    return false;
  }

  private async runCriticGate(sessionId: string, task: string, domain: WorkerDomain, preferredModel?: string): Promise<{ passed: boolean; feedback?: string }> {
    const hardCheckResult = await this.runHardChecks(sessionId);
    if (!hardCheckResult.passed) return { passed: false, feedback: hardCheckResult.output };
    
    const routing = this.resolveActiveRouting(preferredModel, "critic");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return { passed: true };
    
    const stream = provider.streamResponse({ model: routing.model, systemPrompt: "PASS or FAIL.", messages: [{ role: "user", content: task }], maxTokens: 100 });
    let content = "";
    for await (const event of stream) if (event.type === "content_delta") content += event.content;
    return { passed: content.toUpperCase().includes("PASS"), feedback: content };
  }

  private async runHardChecks(sessionId: string): Promise<{ passed: boolean; output: string }> {
    const pkgPath = join(this.workingDirectory, "package.json");
    if (!existsSync(pkgPath)) return { passed: true, output: "" };
    const bash = this.tools.get("bash")!;
    const result = await bash.run({ sessionId, workingDirectory: this.workingDirectory, isSandboxed: true }, { id: nanoid(), name: "bash", input: { command: "npm test", timeout: 60 } });
    return { passed: !result.isError, output: result.output };
  }

  private requiresSystemAccess(m: string): boolean { return ["install", "sudo", "apt"].some(k => m.toLowerCase().includes(k)); }

  private async decideIfNeedsWorker(sessionId: string, m: string, preferredModel?: string): Promise<boolean> {
    const routing = this.resolveActiveRouting(preferredModel, "general");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return true;

    let res = "";
    try {
      for await (const event of provider.streamResponse({ model: routing.model, systemPrompt: "WORKER or MANAGER?", messages: [{ role: "user", content: m }], maxTokens: 5 })) if (event.type === "content_delta") res += event.content;
      return res.toUpperCase().includes("WORKER");
    } catch { return true; }
  }

  private async classifyDomainLLM(m: string, preferredModel?: string): Promise<WorkerDomain> {
    const routing = this.resolveActiveRouting(preferredModel, "general");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return "general";

    let res = "";
    try {
      for await (const event of provider.streamResponse({ model: routing.model, systemPrompt: "frontend, backend, test, review, or general?", messages: [{ role: "user", content: m }], maxTokens: 5 })) if (event.type === "content_delta") res += event.content;
      const d = res.trim().toLowerCase() as WorkerDomain;
      return ["frontend", "backend", "test", "review", "general"].includes(d) ? d : "general";
    } catch { return "general"; }
  }

  private async handleDirectly(sessionId: string, userMessage: string, reasoningLevel?: string, preferredModel?: string): Promise<void> {
    const routing = this.resolveActiveRouting(preferredModel, "general");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) throw new Error("No provider.");
    const providerName = provider.name as ProviderName;

    this.emitWSMessage(sessionId, "agent.status", { agentId: KORY_IDENTITY.id, status: "thinking" });
    let content = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let usageKnown = false;
    this.emitUsageUpdate(sessionId, KORY_IDENTITY.id, routing.model, providerName, tokensIn, tokensOut, usageKnown);
    const stream = this.providers.executeWithRetry({ model: routing.model, systemPrompt: KORY_SYSTEM_PROMPT, messages: [{ role: "user", content: userMessage }], maxTokens: 4096 }, providerName);
    for await (const event of stream) {
      if (event.type === "content_delta") {
        content += event.content;
        this.emitWSMessage(sessionId, "stream.delta", { agentId: KORY_IDENTITY.id, content: event.content, model: routing.model });
      } else if (event.type === "usage_update") {
        if (typeof event.tokensIn === "number") tokensIn = Math.max(tokensIn, event.tokensIn);
        if (typeof event.tokensOut === "number") tokensOut = Math.max(tokensOut, event.tokensOut);
        usageKnown = usageKnown || typeof event.tokensIn === "number" || typeof event.tokensOut === "number";
        this.emitUsageUpdate(sessionId, KORY_IDENTITY.id, routing.model, providerName, tokensIn, tokensOut, usageKnown);
      }
    }
    if (this.messages) this.messages.add(sessionId, { id: nanoid(12), sessionId, role: "assistant", content, model: routing.model, provider: providerName, createdAt: Date.now() });
    this.emitWSMessage(sessionId, "agent.status", { agentId: KORY_IDENTITY.id, status: "done" });
  }

  private async executeWithProvider(sessionId: string, provider: any, modelId: string, userMessage: string, domain: WorkerDomain, reasoningLevel: any, isAutoMode: boolean, allowedPaths: string[], isSandboxed: boolean): Promise<{ success: boolean; error?: string }> {
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

    try {
      let turnCount = 0;
      while (turnCount < 25) {
        turnCount++;
        const stream = this.providers.executeWithRetry({ model: modelId, systemPrompt: WORKER_SYSTEM_PROMPT, messages: messages.map(m => ({ role: m.role, content: m.content })), tools: this.tools.getToolDefsForRole("worker"), maxTokens: 16384 }, provider.name);
        let assistantContent = "";
        let pendingToolCalls = new Map<string, { name: string; input: string }>();
        const completedToolCalls: any[] = [];
        let hasToolCalls = false;

        for await (const event of stream) {
          if (event.type === "content_delta") {
            assistantContent += event.content;
            this.emitWSMessage(sessionId, "stream.delta", { agentId: workerId, content: event.content, model: modelId });
          } else if (event.type === "usage_update") {
            if (typeof event.tokensIn === "number") tokensIn = Math.max(tokensIn, event.tokensIn);
            if (typeof event.tokensOut === "number") tokensOut = Math.max(tokensOut, event.tokensOut);
            usageKnown = usageKnown || typeof event.tokensIn === "number" || typeof event.tokensOut === "number";
            this.emitUsageUpdate(sessionId, workerId, modelId, provider.name, tokensIn, tokensOut, usageKnown);
          } else if (event.type === "tool_use_start") {
            hasToolCalls = true;
            pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
            this.emitWSMessage(sessionId, "stream.tool_call", { agentId: workerId, toolCall: { id: event.toolCallId, name: event.toolName, input: {} } });
          } else if (event.type === "tool_use_delta") {
            const tc = pendingToolCalls.get(event.toolCallId!);
            if (tc) tc.input += event.toolInput ?? "";
          } else if (event.type === "tool_use_stop") {
            const call = pendingToolCalls.get(event.toolCallId!);
            if (call) {
              let parsedInput = {};
              try { parsedInput = JSON.parse(call.input || "{}"); } catch {}
              completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
              pendingToolCalls.delete(event.toolCallId!);
            }
          }
        }
        messages.push({ role: "assistant", content: assistantContent });
        if (hasToolCalls && completedToolCalls.length > 0) {
          for (const tc of completedToolCalls) {
            let result;
            if (tc.name === "ask_manager") {
               const ans = await this.handleManagerInquiry(sessionId, workerId, tc.input.question);
               result = { callId: tc.id, name: tc.name, output: ans, isError: false, durationMs: 0 };
            } else {
               result = await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
            }
            this.emitWSMessage(sessionId, "stream.tool_result", { agentId: workerId, toolResult: result });
            messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id });
          }
          continue;
        }
        break;
      }
      this.activeWorkers.delete(workerId);
      return { success: true };
    } catch (err: any) { this.activeWorkers.delete(workerId); return { success: false, error: err.message }; }
  }

  private async generateWorkerTask(sessionId: string, message: string, domain: WorkerDomain, preferredModel?: string): Promise<string> {
    const routing = this.resolveActiveRouting(preferredModel, "general");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return message;
    let res = "";
    try {
      for await (const event of provider.streamResponse({ model: routing.model, systemPrompt: "Be brief and actionable.", messages: [{ role: "user", content: `Worker instruction for ${domain}: ${message}` }], maxTokens: 200 })) if (event.type === "content_delta") res += event.content;
      return res.trim() || message;
    } catch { return message; }
  }

  private loadHistory(sessionId: string): any[] { return this.messages?.getRecent(sessionId, 10).map((m: any) => ({ role: m.role, content: m.content })) || []; }
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
  private emitWSMessage(sessionId: string, type: string, payload: any) { wsBroker.publish("custom", { type: type as any, payload, timestamp: Date.now(), sessionId, agentId: KORY_IDENTITY.id }); }
}
