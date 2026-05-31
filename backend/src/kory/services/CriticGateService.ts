/**
 * CriticGateService
 * Handles the critic review gate for worker task validation
 * Extracted from manager.ts runCriticGate() method
 */

import type { ProviderName } from '@koryphaios/shared';
import { AGENT } from '../../constants';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent } from '../../providers/types';
import type { ProviderMessage } from '../../providers/types';
import { getModelsForProvider } from '../../providers/types';
import { ToolRegistry, type ToolContext } from '../../tools';
import { withTimeoutSignal } from '../../providers';
import { koryLog } from '../../logger';
import { parseCriticVerdict, formatMessagesForCritic } from '../critic-util';
import type { EventEmitterService } from './EventEmitterService';

interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface InternalMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: CompletedToolCall[];
}

interface CriticGateResult {
  passed: boolean;
  feedback?: string;
}

export interface CriticGateServiceDependencies {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  events: EventEmitterService;
  workingDirectory: string;
}

const CRITIC_SYSTEM_PROMPT = `You are the Critic agent. You may only use read_file, grep, glob, and ls to inspect the codebase. You see the worker conversation below. Review the work and output either PASS or FAIL. If FAIL, give brief, actionable feedback. Your final message must end with a line that starts with exactly PASS or exactly FAIL (e.g. "PASS" or "FAIL: missing tests").`;

export class CriticGateService {
  private providers: ProviderRegistry;
  private tools: ToolRegistry;
  private events: EventEmitterService;
  private workingDirectory: string;

  constructor(deps: CriticGateServiceDependencies) {
    this.providers = deps.providers;
    this.tools = deps.tools;
    this.events = deps.events;
    this.workingDirectory = deps.workingDirectory;
  }

  /**
   * Run the critic gate on worker output
   * Critic can only read files and grep. It sees the full worker transcript (truncated)
   * and outputs PASS or FAIL with feedback.
   */
  async runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
  ): Promise<CriticGateResult> {
    const routing = this.resolveCriticRouting(preferredModel);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) {
      return { passed: true }; // No critic available, auto-pass
    }

    const transcriptText = formatMessagesForCritic(workerMessages ?? [], 12_000);

    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: this.workingDirectory,
      allowedPaths: [this.workingDirectory],
      isSandboxed: true,
    };

    const messages: InternalMessage[] = [
      {
        role: 'user',
        content: `Worker transcript to review:\n\n${transcriptText}\n\nUse read_file/grep/glob/ls as needed. Then output PASS or FAIL and brief feedback.`,
      },
    ];

    let lastContent = '';
    let turnCount = 0;

    while (turnCount < 5) {
      turnCount++;
      const criticSignal = withTimeoutSignal(undefined, AGENT.LLM_STREAM_TIMEOUT_MS);

      const stream = this.providers.executeWithRetry(
        {
          model: routing.model,
          systemPrompt: CRITIC_SYSTEM_PROMPT,
          messages: this.toProviderMessages(messages),
          tools: this.tools.getToolDefsForRole('critic'),
          maxTokens: 2048,
          signal: criticSignal,
        },
        routing.provider,
        this.buildFallbackChain(routing.model),
      );

      let assistantContent = '';
      const completedToolCalls: CompletedToolCall[] = [];
      const pendingToolCalls = new Map<string, { name: string; input: string }>();

      for await (const event of stream) {
        if (event.type === 'content_delta') {
          assistantContent += event.content ?? '';
        } else if (event.type === 'tool_use_start') {
          pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
        } else if (event.type === 'tool_use_delta') {
          const tc = pendingToolCalls.get(event.toolCallId!);
          if (tc) tc.input += event.toolInput ?? '';
        } else if (event.type === 'tool_use_stop') {
          const call = pendingToolCalls.get(event.toolCallId!);
          if (call) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = JSON.parse(call.input || '{}') as Record<string, unknown>;
            } catch {
              /* Expected: malformed tool input JSON, defaults to {} */
            }
            completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
            pendingToolCalls.delete(event.toolCallId!);
          }
        }
      }

      messages.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: completedToolCalls.length
          ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
          : undefined,
      });
      lastContent = assistantContent;

      if (completedToolCalls.length === 0) break;

      // Execute tool calls
      for (const tc of completedToolCalls) {
        const result = await this.tools.execute(criticCtx, {
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
      }
    }

    const passed = parseCriticVerdict(lastContent);
    return { passed, feedback: lastContent.trim() };
  }

  private resolveCriticRouting(preferredModel?: string): {
    model: string;
    provider: ProviderName | undefined;
  } {
    // Use the enhanced routing if available, otherwise fallback
    if (preferredModel && preferredModel !== 'auto') {
      const available = this.providers.getAvailable();
      for (const provider of available) {
        const models = getModelsForProvider(provider.name);
        if (models.some((m) => m.id === preferredModel)) {
          return { model: preferredModel, provider: provider.name as ProviderName };
        }
      }
    }

    // Default to first available provider's first model
    const available = this.providers.getAvailable();
    if (available.length > 0) {
      const first = available[0]!;
      const models = getModelsForProvider(first.name);
      if (models.length > 0) {
        return { model: models[0]!.id, provider: first.name as ProviderName };
      }
    }

    return { model: 'claude-sonnet-4-5', provider: undefined };
  }

  private buildFallbackChain(startModelId: string): string[] {
    const chain: string[] = [startModelId];
    const available = this.providers.getAvailable();

    for (const provider of available) {
      const models = getModelsForProvider(provider.name);
      for (const model of models) {
        if (model.id !== startModelId && !model.deprecated) {
          chain.push(model.id);
        }
      }
    }

    return chain.slice(0, 5); // Max 5 fallbacks
  }

  private toProviderMessages(messages: InternalMessage[]): ProviderMessage[] {
    return messages.map((m) => {
      const out: ProviderMessage = { role: m.role, content: m.content };
      if (m.role === 'tool' && m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
      if (m.role === 'assistant' && m.tool_calls?.length) out.tool_calls = m.tool_calls;
      return out;
    });
  }
}

export const createCriticGateService = (deps: CriticGateServiceDependencies) =>
  new CriticGateService(deps);
