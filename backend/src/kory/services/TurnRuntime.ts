import type { StreamThinkingPayload } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { AGENT } from '../../constants';
import { createIdleAbortSignal, mergeAbortSignals } from '../../providers/utils';
import { serverLog } from '../../logger';
import { logBackgroundRegistrationFailure } from '../../security/bash-sandbox';
import { normalizeToolArguments } from '../../providers/tool-arguments';
import type { ProviderEvent } from '../../providers/types';
import {
  OutputLoopDetector,
  OutputLoopStop,
  type OutputLoopDetection,
} from '../output-loop-detector';
import { TurnOwnershipLostError, TurnStreamFailure } from './TurnRuntime.types';
import { TurnUsageFold } from './turn-usage-fold';
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
    const localAbort = new AbortController();
    // Idle timeout (resets on every event) replaces the old hard 10-minute
    // wall-clock cap that cut actively-streaming models mid-generation. A
    // genuinely hung provider is still aborted after the idle window.
    const idle = createIdleAbortSignal(AGENT.LLM_STREAM_TIMEOUT_MS);
    const streamSignal = mergeAbortSignals(signal, localAbort.signal, idle.signal);
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
      loopDetected: (...args) => {
        assertActive();
        input.effects.loopDetected?.(...args);
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
    let reasoningContent: string | undefined;
    const pendingToolCalls = new Map<string, { name: string; input: string; truncated: boolean }>();
    const completedToolCalls: CompletedToolCall[] = [];
    const seenToolCalls = new Set<string>();
    // Provider call id → the identity this runtime registered. They differ only
    // when a gateway repeats an id for a second call.
    const providerCallIds = new Map<string, string>();
    let duplicateCallIdSuffix = 0;
    /**
     * Resolve the pending call a provider event belongs to.
     *
     * Gateways are not consistent about repeating `id` on continuation chunks,
     * and proxied upstreams sometimes drop it entirely. A single in-flight call
     * is unambiguous even with no id, so it is used as the fallback; with several
     * in flight, an unidentified delta is ignored rather than guessed.
     */
    const resolvePendingCall = (providerCallId: string | undefined): string | undefined => {
      const mapped = providerCallId ? providerCallIds.get(providerCallId) : undefined;
      if (mapped && pendingToolCalls.has(mapped)) return mapped;
      if (pendingToolCalls.size === 1) return [...pendingToolCalls.keys()][0];
      return undefined;
    };
    let observedNativeTool = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let cachedInputTokens = 0;
    let cacheWriteInputTokens = 0;
    let nativeToolContextChars = 0;
    let finishReason: ProviderEvent['finishReason'];
    let loopDetected = false;
    const contentLoops = new OutputLoopDetector();
    const thinkingLoops = new OutputLoopDetector();
    let thinkingPhaseAnnounced = false;
    let streamingPhaseAnnounced = false;
    const stopLoop = (detection: OutputLoopDetection) => {
      assertActive();
      loopDetected = true;
      const reason = new OutputLoopStop();
      // Abort this provider even if an optional owner callback is unavailable.
      // Do not await another event: a broken provider may never yield again.
      try {
        effects.loopDetected?.(detection);
      } finally {
        localAbort.abort(reason);
        input.cancel?.(reason);
      }
    };
    let usageKnown = false;
    let unexpectedCacheMissReported = false;
    // True while the turn's occupancy is a cumulative harness total rather
    // than a per-request context snapshot.
    let usageEstimated = false;
    const usageFold = new TurnUsageFold();

    const snapshot = (): TurnStreamResult => ({
      content: assistantContent,
      reasoningContent,
      completedToolCalls: [],
      observedNativeTool,
      loopDetected,
      ...(finishReason ? { finishReason } : {}),
      usage: {
        tokensIn,
        tokensOut,
        cachedInputTokens,
        cacheWriteInputTokens,
        usageKnown,
        estimated: usageEstimated,
        ...(nativeToolContextChars > 0
          ? { nativeToolContextTokens: Math.ceil(nativeToolContextChars / 4) }
          : {}),
      },
    });
    try {
      for await (const event of stream) {
        // On user stop, keep everything accumulated so far — breaking (instead of
        // throwing) lets the partial response flow into `messages` and get
        // persisted. Throwing here erased the user's proof-of-work on Stop.
        if (signal?.aborted) break;
        assertActive();
        // Any event means the producer is alive — push the idle deadline forward
        // so an actively-streaming model is never cut mid-generation.
        idle.reset();
        if (event.type === 'error') {
          throw new Error(event.error ?? 'LLM stream error');
        }
        if (event.type === 'complete') {
          finishReason = event.finishReason;
          continue;
        }
        if (event.type === 'content_delta') {
          const chunk = event.content ?? '';
          const checked = contentLoops.push(chunk);
          const delta = chunk.slice(0, checked.accepted);
          assistantContent += delta;
          // Stream live, token-by-token — so the user sees text appear immediately (no
          // "thinks then dumps" pause) and partial output survives a mid-stream error.
          if (delta) {
            assertActive();
            // Lifecycle phase is a durable transition, not a per-token event.
            // Re-serializing it for every provider chunk made the stream wait
            // behind SQLite/outbox work and amplified latency on fast models.
            if (!streamingPhaseAnnounced) {
              await this.dependencies.lifecycle.phase(handle, 'streaming', 'provider_content');
              streamingPhaseAnnounced = true;
            }
            assertActive();
            effects.heartbeat('streaming');
            effects.emit('stream.delta', {
              agentId,
              content: delta,
              model: modelId,
            });
          }
          if (checked.detection) {
            stopLoop(checked.detection);
            break;
          }
        } else if (event.type === 'thinking_delta') {
          // Replay the provider bytes, independently of display loop clipping.
          if (event.thinking !== undefined)
            reasoningContent = (reasoningContent ?? '') + event.thinking;
          const checked = thinkingLoops.push(event.thinking ?? '');
          if (event.thinking || typeof event.thinkingTokens === 'number') {
            assertActive();
            if (!thinkingPhaseAnnounced) {
              await this.dependencies.lifecycle.phase(handle, 'thinking', 'provider_reasoning');
              // A status change is a durable transition, not a per-token event —
              // just like the lifecycle phase above. Re-emitting it for every
              // reasoning chunk produced ~95k identical rows in one run, flooded
              // WS broadcasts, and starved /api/health under load.
              effects.emit('agent.status', {
                agentId,
                status: 'thinking',
                detail: 'Provider reported reasoning activity',
              });
              thinkingPhaseAnnounced = true;
            }
            assertActive();
            effects.heartbeat('thinking');
            effects.emit('stream.thinking', {
              agentId,
              thinking: (event.thinking ?? '').slice(0, checked.accepted),
              ...(typeof event.thinkingTokens === 'number'
                ? { thinkingTokens: event.thinkingTokens }
                : {}),
            } satisfies StreamThinkingPayload);
          }
          if (checked.detection) {
            stopLoop(checked.detection);
            break;
          }
        } else if (event.type === 'waiting') {
          const waitingReason = event.waitingReason?.trim() || 'Waiting for provider capacity';
          assertActive();
          // This is an in-flight provider queue, not a terminal error and not
          // the durable background-process wait. Keep the stream and run alive
          // while exposing the provider's reason to the client.
          effects.heartbeat('waiting');
          effects.emit('agent.status', {
            agentId,
            status: 'waiting',
            detail: waitingReason,
          });
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
              false,
              undefined,
              this.dependencies.lifecycle.runRef(handle),
            );
            assertActive();
          }
        } else if (event.type === 'tool_executed') {
          observedNativeTool = true;
          // These bytes are inspectable evidence, so categorize them as Tools
          // instead of letting all CLI tool traffic fall into harness overhead.
          nativeToolContextChars +=
            (event.toolName?.length ?? 0) +
            (event.toolInput?.length ?? 0) +
            (event.toolOutput?.length ?? 0);
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
            `${event.toolName || 'Tool name unavailable'} ${(event.toolInput ?? '').slice(0, 140)}`,
            event.toolOutput ?? '',
            event.isError === true,
            event.toolInput,
            this.dependencies.lifecycle.runRef(handle),
          );
          assertActive();
          effects.emit('stream.tool_call', {
            agentId,
            sourceProvider: provider,
            toolCall: {
              id: callId,
              name: event.toolName ?? '',
              input: safeParseJson(event.toolInput),
            },
          });
          effects.heartbeat('tool_calling');
          effects.emit('stream.tool_result', {
            agentId,
            sourceProvider: provider,
            toolResult: {
              callId,
              name: event.toolName ?? '',
              output: event.toolOutput ?? '',
              isError: event.isError === true,
              durationMs: 0,
              ...(agenticArchiveId ? { archiveId: agenticArchiveId } : {}),
            },
          });
        } else if (event.type === 'usage_update') {
          // Cached prompt tokens still occupy the context window, and a CLI
          // turn is many internal requests: the fold keeps the latest
          // per-request snapshot and lets a cumulative receipt stand in only
          // when no snapshot exists (flagged estimated). See turn-usage-fold.ts.
          usageFold.apply(event);
          ({ tokensIn, tokensOut, cachedInputTokens, cacheWriteInputTokens, usageKnown } =
            usageFold);
          usageEstimated = usageFold.estimated;
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
            ...(nativeToolContextChars > 0
              ? { nativeToolContextTokens: Math.ceil(nativeToolContextChars / 4) }
              : {}),
          });
        } else if (event.type === 'tool_use_start') {
          const providerCallId = event.toolCallId?.trim();
          const toolName = event.toolName?.trim();
          if (!providerCallId || !toolName) {
            // A call with no id or no name can neither be matched to its deltas nor
            // executed. Log it and keep the turn alive: aborting here is what made a
            // provider framing quirk look like the agent stalling.
            serverLog.warn(
              { agentId, toolCallId: event.toolCallId, toolName: event.toolName },
              'Ignoring provider tool_use_start without a call id or name',
            );
          } else {
            // Proxies that stitch two upstream turns can repeat a call id. Give the
            // second call its own identity so both can run.
            let callId = providerCallId;
            while (seenToolCalls.has(callId)) {
              duplicateCallIdSuffix += 1;
              callId = `${providerCallId}#${duplicateCallIdSuffix}`;
            }
            seenToolCalls.add(callId);
            providerCallIds.set(providerCallId, callId);
            assertActive();
            await this.dependencies.lifecycle.phase(handle, 'tool_calling', 'tool_requested');
            assertActive();
            pendingToolCalls.set(callId, { name: toolName, input: '', truncated: false });
            effects.heartbeat('tool_calling');
            effects.emit('stream.tool_call', {
              agentId,
              toolCall: { id: callId, name: toolName, input: {} },
            });
          }
        } else if (event.type === 'tool_use_delta') {
          const callId = resolvePendingCall(event.toolCallId);
          const tc = callId ? pendingToolCalls.get(callId) : undefined;
          if (!tc) {
            serverLog.warn(
              { agentId, toolCallId: event.toolCallId },
              'Ignoring provider tool arguments with no active tool call',
            );
          } else if (!tc.truncated) {
            tc.input += event.toolInput ?? '';
            if (tc.input.length > 1_048_576) {
              // Bound memory without failing the turn: the call is dropped at stop
              // with a notice instead of being executed with clipped arguments.
              tc.truncated = true;
            }
          }
        } else if (event.type === 'tool_use_stop') {
          const callId = resolvePendingCall(event.toolCallId);
          const call = callId ? pendingToolCalls.get(callId) : undefined;
          if (!callId || !call) {
            serverLog.warn(
              { agentId, toolCallId: event.toolCallId },
              'Ignoring provider tool_use_stop for an unknown tool call',
            );
          } else {
            // `toolInput` on the stop event is authoritative when the provider sends
            // the whole payload only at the end; deltas otherwise assembled it.
            let normalized = normalizeToolArguments(call.input);
            // Only fall back to the stop payload when it actually carries
            // something: an empty one is not a valid substitute for bad deltas.
            if (!normalized.recovered && event.toolInput?.trim()) {
              normalized = normalizeToolArguments(event.toolInput);
            }
            if (event.toolCallId) providerCallIds.delete(event.toolCallId);
            pendingToolCalls.delete(callId);
            if (!normalized.recovered) {
              // Executing guessed arguments is worse than dropping the call: the user
              // gets a notice and the model can retry with valid arguments.
              effects.emit('system.notification', {
                type: 'warning',
                message: `Ignored a ${call.name} tool call because the provider streamed arguments that were not valid JSON. Ask the model to retry that call.`,
              });
            } else {
              effects.emit('stream.tool_call', {
                agentId,
                toolCall: { id: callId, name: call.name, input: normalized.input },
              });
              assertActive();
              completedToolCalls.push({ id: callId, name: call.name, input: normalized.input });
            }
          }
        }
      }
      if (!signal?.aborted && !loopDetected) {
        assertActive();
        const detection = contentLoops.finish() ?? thinkingLoops.finish();
        if (detection) stopLoop(detection);
      }
      if (!signal?.aborted && !loopDetected && pendingToolCalls.size) {
        // A gateway that never sends the closing call frame used to fail the whole
        // turn. Run only calls whose arguments arrived as complete JSON; anything
        // truncated is dropped with a notice instead of being guessed at.
        for (const [callId, call] of pendingToolCalls) {
          const normalized = call.truncated
            ? { input: {}, repaired: true, recovered: false }
            : normalizeToolArguments(call.input);
          if (normalized.recovered && !normalized.repaired) {
            effects.emit('stream.tool_call', {
              agentId,
              toolCall: { id: callId, name: call.name, input: normalized.input },
            });
            completedToolCalls.push({ id: callId, name: call.name, input: normalized.input });
          } else {
            effects.emit('system.notification', {
              type: 'warning',
              message: `Ignored a ${call.name} tool call because the provider stream ended before its arguments were complete. Ask the model to retry that call.`,
            });
          }
        }
        pendingToolCalls.clear();
        providerCallIds.clear();
      }
    } catch (err) {
      if (!signal?.aborted && !loopDetected) {
        if (err instanceof TurnOwnershipLostError) throw err;
        throw new TurnStreamFailure(
          err instanceof Error ? err.message : 'Provider stream failed',
          snapshot(),
        );
      }
    } finally {
      idle.clear();
    }

    // A user Stop preserves evidence but never releases pending tool work.
    if (signal?.aborted || loopDetected) return snapshot();
    assertActive();
    return { ...snapshot(), completedToolCalls };
  }
}
