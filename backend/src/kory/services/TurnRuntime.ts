import type { StreamThinkingPayload } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { AGENT } from '../../constants';
import { withTimeoutSignal } from '../../providers/utils';
import { serverLog } from '../../logger';
import { logBackgroundRegistrationFailure } from '../../security/bash-sandbox';
import { TurnOwnershipLostError, TurnStreamFailure } from './TurnRuntime.types';
import type {
  CompletedToolCall,
  TurnRuntimeDependencies,
  TurnStreamInput,
  TurnStreamResult,
} from './TurnRuntime.types';

/** Parse a JSON string into an object, tolerating malformed input (returns {}). */
function safeParseJson(s?: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to parse JSON string in safeParseJson',
    );
    return {};
  }
}

/**
 * Executes one manager provider stream and assembles its tool requests and usage.
 * The caller retains admission, durable waits, compaction and tool scheduling.
 * This service borrows the exact SessionRun handle for phase writes; it never
 * looks up a replacement handle or treats a UI projection as lifecycle truth.
 * Native tool reports are observations, never requests to execute a tool twice.
 */
export class TurnRuntime {
  constructor(private readonly dependencies: TurnRuntimeDependencies) {}

  async stream(input: TurnStreamInput): Promise<TurnStreamResult> {
    const { request, provider, handle, agentId } = input;
    const { signal, model: modelId } = request;
    const sessionId = handle.sessionId;
    if (request.sessionId !== sessionId)
      throw new Error('Turn stream session does not match its run handle');
    if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');
    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const assertActive = () => {
      signal?.throwIfAborted();
      try {
        this.dependencies.assertActive(handle);
      } catch {
        throw new TurnOwnershipLostError();
      }
      streamSignal.throwIfAborted();
    };
    // Each sink is checked separately: a synchronous observer can cancel or
    // replace the owner before the next sink runs.
    const effects: typeof input.effects = {
      emit: (...args) => {
        assertActive();
        input.effects.emit(...args);
      },
      heartbeat: (...args) => {
        assertActive();
        input.effects.heartbeat(...args);
      },
      fileEdit: (...args) => {
        assertActive();
        input.effects.fileEdit(...args);
      },
      usage: (...args) => {
        assertActive();
        input.effects.usage(...args);
      },
    };
    assertActive();
    const stream = this.dependencies.providers.executeWithRetry(
      {
        ...request,
        signal: streamSignal,
      },
      provider,
    );
    let assistantContent = '';
    const pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    const seenToolCalls = new Set<string>();
    let observedNativeTool = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let cachedInputTokens = 0;
    let cacheWriteInputTokens = 0;
    let usageKnown = false;
    let unexpectedCacheMissReported = false;
    // Sticky: once any sample in this turn is approximate (cumulative
    // harness total), the turn's occupancy stays estimated.
    let usageEstimated = false;

    const snapshot = (): TurnStreamResult => ({
      content: assistantContent,
      completedToolCalls: [],
      observedNativeTool,
      usage: {
        tokensIn,
        tokensOut,
        cachedInputTokens,
        cacheWriteInputTokens,
        usageKnown,
        estimated: usageEstimated,
      },
    });
    try {
      for await (const event of stream) {
        // On user stop, keep everything accumulated so far — breaking (instead of
        // throwing) lets the partial response flow into `messages` and get
        // persisted. Throwing here erased the user's proof-of-work on Stop.
        if (signal?.aborted) break;
        assertActive();
        if (event.type === 'error') {
          throw new Error(event.error ?? 'LLM stream error');
        }
        if (event.type === 'content_delta') {
          const delta = event.content ?? '';
          assistantContent += delta;
          // Stream live, token-by-token — so the user sees text appear immediately (no
          // "thinks then dumps" pause) and partial output survives a mid-stream error.
          if (delta) {
            assertActive();
            await this.dependencies.lifecycle.phase(handle, 'streaming', 'provider_content');
            assertActive();
            effects.heartbeat('streaming');
            effects.emit('stream.delta', {
              agentId,
              content: delta,
              model: modelId,
            });
          }
        } else if (event.type === 'thinking_delta') {
          if (event.thinking || typeof event.thinkingTokens === 'number') {
            assertActive();
            await this.dependencies.lifecycle.phase(handle, 'thinking', 'provider_reasoning');
            assertActive();
            effects.heartbeat('thinking');
            effects.emit('agent.status', {
              agentId,
              status: 'thinking',
              detail: 'Provider reported reasoning activity',
            });
            effects.emit('stream.thinking', {
              agentId,
              thinking: event.thinking ?? '',
              ...(typeof event.thinkingTokens === 'number'
                ? { thinkingTokens: event.thinkingTokens }
                : {}),
            } satisfies StreamThinkingPayload);
          }
        } else if (event.type === 'file_edit') {
          // Agentic provider (claude-code) already wrote the file — surface it in the live
          // diff preview (it's done, not a tool for us to execute).
          if (event.filePath) {
            effects.fileEdit(
              event.filePath,
              event.fileContent ?? '',
              event.fileOperation ?? 'edit',
              event.fileOldContent,
            );
            // Archive a bounded, redacted edit preview for later identification.
            assertActive();
            await this.dependencies.archive?.record(
              sessionId,
              'file_edit',
              `${event.fileOperation ?? 'edit'} ${event.filePath}`,
              event.fileContent ?? '',
            );
            assertActive();
          }
        } else if (event.type === 'tool_executed') {
          observedNativeTool = true;
          assertActive();
          await this.dependencies.lifecycle.phase(handle, 'tool_calling', 'provider_tool');
          assertActive();
          // Agentic provider already ran a non-file tool — surface it in the tool feed.
          const callId = `agent-${nanoid(8)}`;
          // CLI-native background command (Claude Code's Bash run_in_background):
          // register it so the background-terminals UI tracks it with live logs.
          const bgMatch =
            /running in background with ID:\s*(\S+?)\.[\s\S]*?written to:\s*(\S+?\.output)/i.exec(
              event.toolOutput ?? '',
            );
          if (bgMatch) {
            let bgCommand = event.toolName ?? 'background command';
            try {
              const input = JSON.parse(event.toolInput ?? '{}') as { command?: string };
              if (input.command) bgCommand = input.command;
            } catch (err: unknown) {
              logBackgroundRegistrationFailure({
                cwd: request.workingDirectory,
                error: err,
                phase: 'input_invalid',
                sessionId,
                toolCallId: callId,
              });
            }
            assertActive();
            void this.dependencies.processes
              .registerExternal({
                name: `cli:${bgMatch[1]}`,
                command: bgCommand,
                sessionId,
                outputFile: bgMatch[2],
              })
              .catch((err: unknown) => {
                // Background process registration is fire-and-forget — the command
                // is already running; failure to track it doesn't affect the user.
                logBackgroundRegistrationFailure({
                  command: bgCommand,
                  cwd: request.workingDirectory,
                  error: err,
                  phase: 'registration_failed',
                  sessionId,
                  toolCallId: callId,
                });
              });
          }
          assertActive();
          const agenticArchiveId = await this.dependencies.archive?.record(
            sessionId,
            'tool_result',
            `${event.toolName ?? 'tool'} ${(event.toolInput ?? '').slice(0, 140)}`,
            event.toolOutput ?? '',
            event.isError === true,
          );
          assertActive();
          effects.emit('stream.tool_call', {
            agentId,
            sourceProvider: provider,
            toolCall: {
              id: callId,
              name: event.toolName ?? 'tool',
              input: safeParseJson(event.toolInput),
            },
          });
          effects.heartbeat('tool_calling');
          effects.emit('stream.tool_result', {
            agentId,
            sourceProvider: provider,
            toolResult: {
              callId,
              name: event.toolName ?? 'tool',
              output: event.toolOutput ?? '',
              isError: event.isError === true,
              durationMs: 0,
              ...(agenticArchiveId ? { archiveId: agenticArchiveId } : {}),
            },
          });
        } else if (event.type === 'usage_update') {
          // Cached prompt tokens still occupy the context window — fold them in
          // so the context bar reflects real occupancy, not just billed input.
          if (typeof event.tokensIn === 'number')
            tokensIn = Math.max(tokensIn, event.tokensIn + (event.tokensCache ?? 0));
          if (typeof event.tokensOut === 'number') tokensOut = Math.max(tokensOut, event.tokensOut);
          if (typeof event.tokensCacheRead === 'number') {
            cachedInputTokens = Math.max(cachedInputTokens, event.tokensCacheRead);
          }
          if (typeof event.tokensCacheWrite === 'number') {
            cacheWriteInputTokens = Math.max(cacheWriteInputTokens, event.tokensCacheWrite);
          }
          // Agentic harnesses (Codex) report cumulative turn totals, not live
          // occupancy — keep that flag sticky for the whole turn so the
          // meter clamps it and auto-compact withholds it.
          if (event.estimated === true) usageEstimated = true;
          usageKnown = true;
          if (event.cacheUnexpectedMiss === true && !unexpectedCacheMissReported) {
            unexpectedCacheMissReported = true;
            const lane =
              event.cacheLaneKind && event.cacheLaneKind !== 'default'
                ? `${event.cacheLaneKind} `
                : '';
            effects.emit('system.notification', {
              type: 'warning',
              message: `Prompt cache expected the ${lane}lane to be warm, but the provider reported ${Math.max(0, event.tokensCacheWrite ?? 0).toLocaleString()} cache-write tokens with zero cache reads. Kory recorded this as a provider-side cache miss.`,
            });
          }
          effects.usage({
            tokensIn,
            tokensOut,
            cachedInputTokens,
            cacheWriteInputTokens,
            usageKnown,
            estimated: usageEstimated,
          });
        } else if (event.type === 'tool_use_start') {
          if (
            !event.toolCallId?.trim() ||
            !event.toolName?.trim() ||
            seenToolCalls.has(event.toolCallId)
          ) {
            throw new Error('Invalid or duplicate provider tool identity');
          }
          seenToolCalls.add(event.toolCallId);
          assertActive();
          await this.dependencies.lifecycle.phase(handle, 'tool_calling', 'tool_requested');
          assertActive();
          pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
          effects.heartbeat('tool_calling');
          effects.emit('stream.tool_call', {
            agentId,
            toolCall: { id: event.toolCallId, name: event.toolName, input: {} },
          });
        } else if (event.type === 'tool_use_delta') {
          const tc = pendingToolCalls.get(event.toolCallId!);
          if (!tc) throw new Error('Provider tool arguments have no active tool call');
          tc.input += event.toolInput ?? '';
          if (tc.input.length > 1_048_576)
            throw new Error('Provider tool arguments exceed the size limit');
        } else if (event.type === 'tool_use_stop') {
          const call = pendingToolCalls.get(event.toolCallId!);
          if (!call) throw new Error('Provider completed an unknown tool call');
          if (call) {
            let parsedInput: Record<string, unknown>;
            try {
              parsedInput = JSON.parse(call.input || '{}');
              if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
                throw new Error();
              }
            } catch {
              throw new Error('Provider tool arguments must be a valid JSON object');
            }
            effects.emit('stream.tool_call', {
              agentId,
              toolCall: { id: event.toolCallId, name: call.name, input: parsedInput },
            });
            assertActive();
            completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
            pendingToolCalls.delete(event.toolCallId!);
          }
        }
      }
      if (!signal?.aborted) {
        assertActive();
        if (pendingToolCalls.size)
          throw new Error('Provider stream ended with incomplete tool calls');
      }
    } catch (err) {
      if (!signal?.aborted) {
        if (err instanceof TurnOwnershipLostError) throw err;
        throw new TurnStreamFailure(
          err instanceof Error ? err.message : 'Provider stream failed',
          snapshot(),
        );
      }
    }

    // A user Stop preserves evidence but never releases pending tool work.
    if (signal?.aborted) return snapshot();
    assertActive();
    return { ...snapshot(), completedToolCalls };
  }
}
