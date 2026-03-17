// CriticReviewService - Handles critic gate functionality and quality checks
// Extracted from KoryManager to separate concerns

import { nanoid } from "nanoid";
import type { ProviderRegistry } from "../../providers";
import type { ToolRegistry, ToolContext } from "../../tools";
import type { InternalMessage, CompletedToolCall } from "@koryphaios/shared";
import { parseCriticVerdict } from "../critic-util";
import { RoutingService } from "./RoutingService";
import { toProviderMessages, formatMessagesForCritic } from "../utils/message-formatter";
import { AGENT } from "../../constants";
import { withTimeoutSignal } from "../../providers";
import { koryLog } from "../../logger";
import { join } from "node:path";
import { existsSync } from "node:fs";

interface CriticResult {
  passed: boolean;
  feedback?: string;
}

export class CriticReviewService {
  private routingService: RoutingService;

  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private workingDirectory: string,
    config: { fallbacks?: Record<string, string[]> }
  ) {
    this.routingService = new RoutingService(providers, { 
      fallbacks: config.fallbacks ?? {},
      assignments: {},
      agents: {
        manager: { model: 'claude-3-7-sonnet', reasoningLevel: 'high' },
        coder: { model: 'claude-3-7-sonnet', maxTokens: 16384 },
        task: { model: 'gpt-5-mini', maxTokens: 8192 }
      },
    });
  }

  /**
   * Run hard checks (tests) on the codebase
   */
  async runHardChecks(workingDirectory: string): Promise<{ passed: boolean; output: string }> {
    const pkgPath = join(workingDirectory, "package.json");
    if (!existsSync(pkgPath)) return { passed: true, output: "" };
    
    const bash = this.tools.get("bash")!;
    const result = await bash.run(
      { sessionId: "critic-check", workingDirectory, isSandboxed: true },
      { id: nanoid(), name: "bash", input: { command: "npm test", timeout: 60 } }
    );
    
    return { passed: !result.isError, output: result.output };
  }

  /**
   * Run critic gate review on worker output
   */
  async runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string
  ): Promise<CriticResult> {
    // First run hard checks
    const hardCheckResult = await this.runHardChecks(this.workingDirectory);
    if (!hardCheckResult.passed) {
      return { passed: false, feedback: hardCheckResult.output };
    }

    const routing = this.routingService.resolveRouting(preferredModel, "critic");
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    
    if (!provider) {
      // No critic provider available, auto-pass
      return { passed: true };
    }

    const transcriptText = formatMessagesForCritic(workerMessages ?? [], 12_000);
    const criticSystemPrompt = `You are the Critic agent. You may only use read_file, grep, glob, and ls to inspect the codebase. You see the worker conversation below. Review the work and output either PASS or FAIL. If FAIL, give brief, actionable feedback. Your final message must end with a line that starts with exactly PASS or exactly FAIL (e.g. "PASS" or "FAIL: missing tests").`;
    
    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: this.workingDirectory,
      allowedPaths: [this.workingDirectory],
      isSandboxed: true,
    };

    const messages: InternalMessage[] = [
      {
        role: "user",
        content: `Worker transcript to review:\n\n${transcriptText}\n\nUse read_file/grep/glob/ls as needed. Then output PASS or FAIL and brief feedback.`,
      },
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
          messages: toProviderMessages(messages),
          tools: this.tools.getToolDefsForRole("critic"),
          maxTokens: 2048,
          signal: criticSignal,
        },
        routing.provider,
        this.routingService.buildFallbackChain(routing.model)
      );

      const completedToolCalls: CompletedToolCall[] = [];
      const pendingToolCalls = new Map<string, { name: string; input: string }>();
      let assistantContent = "";

      for await (const event of stream) {
        if (event.type === "content_delta") {
          assistantContent += event.content ?? "";
        } else if (event.type === "tool_use_start") {
          pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        } else if (event.type === "tool_use_delta") {
          const tc = pendingToolCalls.get(event.toolCallId!);
          if (tc) tc.input += event.toolInput ?? "";
        } else if (event.type === "tool_use_stop") {
          const call = pendingToolCalls.get(event.toolCallId!);
          if (call) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = JSON.parse(call.input || "{}") as Record<string, unknown>;
            } catch {
              // Malformed input defaults to empty object
            }
            completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
            pendingToolCalls.delete(event.toolCallId!);
          }
        }
      }

      messages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: completedToolCalls.length
          ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
          : undefined,
      });
      
      lastContent = assistantContent;

      if (completedToolCalls.length === 0) break;
      
      // Execute tool calls
      for (const tc of completedToolCalls) {
        const result = await this.tools.execute(criticCtx, { id: tc.id, name: tc.name, input: tc.input });
        messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id });
      }
    }

    const passed = parseCriticVerdict(lastContent);
    return { passed, feedback: lastContent.trim() };
  }

}
