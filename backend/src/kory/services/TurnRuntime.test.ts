import { describe, expect, mock, test } from 'bun:test';
import type { ProviderEvent, StreamRequest } from '../../providers/types';
import { SessionStore } from '../../stores/session-store';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import { SessionRunStore } from '../../runs/session-run-store';
import { ManagerRunLifecycle } from './ManagerRunLifecycle';
import { TurnRuntime } from './TurnRuntime';
import type { TurnRuntimeDependencies, TurnStreamInput } from './TurnRuntime.types';

async function fixture(events: ProviderEvent[] | (() => AsyncIterable<ProviderEvent>)) {
  const lifecycle = new ManagerRunLifecycle();
  const handle = await lifecycle.begin('turn-runtime-test', 'user_turn');
  const phase = mock(lifecycle.phase.bind(lifecycle));
  const executeWithRetry = mock((_request: StreamRequest) =>
    typeof events === 'function'
      ? events()
      : (async function* () {
          yield* events;
        })(),
  );
  const dependencies: TurnRuntimeDependencies = {
    providers: { executeWithRetry },
    lifecycle: {
      phase,
      runRef: () => ({ sessionId: handle.sessionId, runId: handle.runId, revision: 1 }),
    },
    assertActive: () => {},
    archive: { record: mock(async () => 'archive-1') },
    processes: { registerExternal: mock(async () => 'process-1') },
  };
  const emit = mock((_type: string, _payload: unknown) => {});
  const input: TurnStreamInput = {
    handle,
    provider: 'copilot',
    agentId: 'kory-manager',
    request: {
      model: 'test-model',
      messages: [],
      sessionId: handle.sessionId,
      workingDirectory: '/isolated/project',
      systemPrompt: 'test system',
      harnessRole: 'manager',
      reasoningLevel: 'high',
      fastMode: true,
      forceFreshConversation: true,
      providerConversationRevision: 7,
      promptManifestHash: 'manifest',
      taskContractHash: 'contract',
    },
    effects: {
      emit,
      heartbeat: mock(() => {}),
      fileEdit: mock(() => {}),
      usage: mock(() => {}),
    },
  };
  return {
    runtime: new TurnRuntime(dependencies),
    dependencies,
    input,
    executeWithRetry,
    lifecycle,
    phase,
    emit,
  };
}

describe('TurnRuntime provider stream', () => {
  test('assembles interleaved tool arguments and forwards provider options with the exact lease', async () => {
    const f = await fixture([
      { type: 'thinking_delta', thinkingTokens: 4 },
      { type: 'content_delta', content: 'Checking.' },
      { type: 'tool_use_start', toolCallId: 'a', toolName: 'read_file' },
      { type: 'tool_use_start', toolCallId: 'b', toolName: 'list_files' },
      { type: 'tool_use_delta', toolCallId: 'a', toolInput: '{"path":' },
      { type: 'tool_use_delta', toolCallId: 'b', toolInput: '{}' },
      { type: 'tool_use_delta', toolCallId: 'a', toolInput: '"a.ts"}' },
      { type: 'tool_use_stop', toolCallId: 'b' },
      { type: 'tool_use_stop', toolCallId: 'a' },
    ]);
    const result = await f.runtime.stream(f.input);
    expect(result.content).toBe('Checking.');
    expect(result.reasoningContent).toBeUndefined(); // Token counts are not reasoning text.
    expect(result.completedToolCalls).toEqual([
      { id: 'b', name: 'list_files', input: {} },
      { id: 'a', name: 'read_file', input: { path: 'a.ts' } },
    ]);
    expect(f.executeWithRetry.mock.calls[0][0]).toMatchObject(f.input.request);
    expect(f.executeWithRetry.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(f.phase.mock.calls.every(([handle]) => handle === f.input.handle)).toBe(true);
    expect(f.input.effects.emit).toHaveBeenCalledWith('stream.thinking', {
      agentId: 'kory-manager',
      thinking: '',
      thinkingTokens: 4,
    });
  });

  test('retains verbatim reasoning on a tool-only turn and resets it for the next stream', async () => {
    const events: ProviderEvent[] = [
      { type: 'thinking_delta', thinking: '  Inspect\n' },
      { type: 'thinking_delta', thinking: 'the file.\t' },
      { type: 'tool_use_start', toolCallId: 'read', toolName: 'read_file' },
      { type: 'tool_use_stop', toolCallId: 'read' },
    ];
    const f = await fixture(events);
    const result = await f.runtime.stream(f.input);
    expect(result.content).toBe('');
    expect(result.reasoningContent).toBe('  Inspect\nthe file.\t');
    expect(result.completedToolCalls).toEqual([{ id: 'read', name: 'read_file', input: {} }]);
    events.splice(0, events.length, { type: 'content_delta', content: 'No reasoning supplied.' });
    expect((await f.runtime.stream(f.input)).reasoningContent).toBeUndefined();
  });

  test('preserves cache occupancy maxima and sticky estimated usage across samples', async () => {
    const f = await fixture([
      {
        type: 'usage_update',
        tokensIn: 100,
        tokensCache: 30,
        tokensOut: 8,
        tokensCacheRead: 20,
        tokensCacheWrite: 10,
        estimated: true,
      },
      {
        type: 'usage_update',
        tokensIn: 90,
        tokensOut: 12,
        tokensCacheRead: 5,
        tokensCacheWrite: 2,
        estimated: false,
      },
    ]);
    const result = await f.runtime.stream(f.input);
    expect(result.usage).toEqual({
      tokensIn: 130,
      tokensOut: 12,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      usageKnown: true,
      estimated: true,
    });
    expect(f.input.effects.usage).toHaveBeenLastCalledWith(result.usage);
    expect(f.phase).not.toHaveBeenCalled();
  });

  test('keeps a provider seat wait non-terminal until content resumes', async () => {
    const f = await fixture([
      { type: 'waiting', waitingReason: 'Waiting for an Omnirush seat' },
      { type: 'content_delta', content: 'Ready.' },
    ]);

    const result = await f.runtime.stream(f.input);

    expect(result.content).toBe('Ready.');
    expect(f.input.effects.heartbeat).toHaveBeenCalledWith('waiting');
    expect(f.emit).toHaveBeenCalledWith('agent.status', {
      agentId: 'kory-manager',
      status: 'waiting',
      detail: 'Waiting for an Omnirush seat',
    });
    expect(f.emit).not.toHaveBeenCalledWith('system.error', expect.anything());
  });

  test('publishes durable streaming phase once, not once per provider chunk', async () => {
    const f = await fixture([
      { type: 'content_delta', content: 'One' },
      { type: 'content_delta', content: ' two' },
      { type: 'content_delta', content: ' three' },
    ]);

    const result = await f.runtime.stream(f.input);

    expect(result.content).toBe('One two three');
    expect(f.phase).toHaveBeenCalledTimes(1);
    expect(f.phase).toHaveBeenCalledWith(f.input.handle, 'streaming', 'provider_content');
  });

  test('retains output-limit completion separately from provider errors', async () => {
    const limited = await fixture([
      { type: 'content_delta', content: 'Partial answer' },
      { type: 'complete', finishReason: 'max_tokens' },
    ]);
    await expect(limited.runtime.stream(limited.input)).resolves.toMatchObject({
      content: 'Partial answer',
      finishReason: 'max_tokens',
    });

    const failed = await fixture([{ type: 'error', error: 'quota exhausted' }]);
    await expect(failed.runtime.stream(failed.input)).rejects.toThrow('quota exhausted');
  });

  test('cancels a repeated streamed output and reports the loop', async () => {
    const f = await fixture([
      { type: 'content_delta', content: 'the the the the the ' },
      { type: 'content_delta', content: 'the the the the the ' },
      { type: 'content_delta', content: 'late output that must not be consumed' },
    ]);
    const controller = new AbortController();
    f.input.request.signal = controller.signal;
    const cancel = mock((reason: DOMException) => controller.abort(reason));
    f.input.cancel = cancel;
    const loopDetected = mock(() => {});
    f.input.effects.loopDetected = loopDetected;

    const result = await f.runtime.stream(f.input);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0].name).toBe('OutputLoopStop');
    expect(loopDetected).toHaveBeenCalledWith({ unitLength: 4, repetitions: 10 });
    expect(result.content).toContain('the the the the the');
    expect(result.content).not.toContain('late output');
  });

  test('surfaces an expected-warm provider cache rewrite once per turn', async () => {
    const f = await fixture([
      {
        type: 'usage_update',
        tokensIn: 20_000,
        tokensOut: 10,
        tokensCacheRead: 0,
        tokensCacheWrite: 12_000,
        cacheExpectedWarm: true,
        cacheUnexpectedMiss: true,
        cacheLaneKind: 'manager',
      },
      {
        type: 'usage_update',
        tokensIn: 20_100,
        tokensOut: 12,
        tokensCacheRead: 0,
        tokensCacheWrite: 12_100,
        cacheExpectedWarm: true,
        cacheUnexpectedMiss: true,
        cacheLaneKind: 'manager',
      },
    ]);
    await f.runtime.stream(f.input);
    const notices = f.emit.mock.calls.filter(([type]) => type === 'system.notification');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.[1]).toMatchObject({ type: 'warning' });
    expect(String((notices[0]?.[1] as { message?: string })?.message)).toContain(
      'provider-side cache miss',
    );
  });

  test('retains inspectable CLI tool traffic for context category attribution', async () => {
    const tool = {
      type: 'tool_executed' as const,
      toolName: 'read_file',
      toolInput: '{"path":"a.ts"}',
      toolOutput: 'contents'.repeat(100),
    };
    const f = await fixture([tool, { type: 'usage_update', tokensIn: 2_000, tokensOut: 10 }]);
    const result = await f.runtime.stream(f.input);
    expect(result.usage.nativeToolContextTokens).toBe(
      Math.ceil((tool.toolName.length + tool.toolInput.length + tool.toolOutput.length) / 4),
    );
    expect(f.input.effects.usage).toHaveBeenLastCalledWith(result.usage);
  });

  test('Stop salvages partial output, closes the iterator and ignores late tool events', async () => {
    const abort = new AbortController();
    let closed = false;
    const f = await fixture(async function* () {
      try {
        yield { type: 'content_delta', content: 'Saved partial' };
        abort.abort();
        yield { type: 'tool_use_start', toolCallId: 'late', toolName: 'write_file' };
      } finally {
        closed = true;
      }
    });
    f.input.request.signal = abort.signal;
    const result = await f.runtime.stream(f.input);
    expect(result.content).toBe('Saved partial');
    expect(result.completedToolCalls).toEqual([]);
    expect(f.phase).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
    expect(f.executeWithRetry.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  test('does not mistake provider AbortError or timeout for an authorized Stop', async () => {
    for (const error of [
      new DOMException('stopped', 'AbortError'),
      new Error('provider failed'),
      new DOMException('deadline', 'TimeoutError'),
    ]) {
      const f = await fixture(async function* () {
        yield { type: 'content_delta', content: 'Partial' };
        throw error;
      });
      await expect(f.runtime.stream(f.input)).rejects.toThrow(error.message);
    }
    const f = await fixture([{ type: 'error', error: 'quota exhausted' }]);
    await expect(f.runtime.stream(f.input)).rejects.toThrow('quota exhausted');
  });

  test('rejects cancelled and mismatched sessions before dispatch', async () => {
    const f = await fixture([]);
    f.input.request.sessionId = 'another-session';
    await expect(f.runtime.stream(f.input)).rejects.toThrow('does not match');
    f.input.request.sessionId = f.input.handle.sessionId;
    f.input.request.signal = AbortSignal.abort();
    await expect(f.runtime.stream(f.input)).rejects.toThrow('aborted');
    expect(f.executeWithRetry).not.toHaveBeenCalled();
  });

  test('reports native work without scheduling duplicate tool calls and registers background evidence', async () => {
    const f = await fixture([
      { type: 'file_edit', filePath: 'a.ts', fileContent: 'new', fileOldContent: 'old' },
      {
        type: 'tool_executed',
        toolName: 'bash',
        toolInput: '{"command":"build"}',
        toolOutput: 'Running in background with ID: bg1. Output written to: /tmp/bg1.output',
      },
    ]);
    const result = await f.runtime.stream(f.input);
    expect(result.observedNativeTool).toBe(true);
    expect(result.completedToolCalls).toEqual([]);
    expect(f.input.effects.fileEdit).toHaveBeenCalledWith('a.ts', 'new', 'edit', 'old');
    expect(f.dependencies.processes.registerExternal).toHaveBeenCalledWith({
      name: 'cli:bg1',
      command: 'build',
      sessionId: f.input.handle.sessionId,
      outputFile: '/tmp/bg1.output',
    });
    expect(f.dependencies.archive!.record).toHaveBeenCalledTimes(2);
    expect(f.dependencies.archive!.record).toHaveBeenCalledWith(
      f.input.handle.sessionId,
      'tool_result',
      'bash {"command":"build"}',
      'Running in background with ID: bg1. Output written to: /tmp/bg1.output',
      false,
      '{"command":"build"}',
      { sessionId: f.input.handle.sessionId, runId: f.input.handle.runId, revision: 1 },
    );
    expect(f.input.effects.emit).toHaveBeenCalledWith(
      'stream.tool_result',
      expect.objectContaining({
        sourceProvider: 'copilot',
        toolResult: expect.objectContaining({ archiveId: 'archive-1' }),
      }),
    );
  });

  test('preserves missing tool identity without inventing a name or executing it', async () => {
    const f = await fixture([
      { type: 'tool_executed', toolInput: '{"path":"a.ts"}', toolOutput: 'contents' },
    ]);
    const result = await f.runtime.stream(f.input);
    expect(result.completedToolCalls).toEqual([]);
    expect(f.input.effects.emit).toHaveBeenCalledWith(
      'stream.tool_call',
      expect.objectContaining({
        toolCall: expect.objectContaining({ name: '', input: { path: 'a.ts' } }),
      }),
    );
    expect(f.input.effects.emit).toHaveBeenCalledWith(
      'stream.tool_result',
      expect.objectContaining({
        toolResult: expect.objectContaining({ name: '', output: 'contents' }),
      }),
    );
  });

  test('late events retain their old handle and cannot transition a replacement durable run', async () => {
    const session = await new SessionStore().create('local-user', 'runtime lease regression');
    const coordinator = new SessionRunCoordinator(new SessionRunStore(), () => undefined);
    const lifecycle = new ManagerRunLifecycle(coordinator);
    const handle = await lifecycle.begin(session.id, 'user_turn');
    let replacement: Awaited<ReturnType<typeof lifecycle.begin>> | undefined;
    const f = await fixture(async function* () {
      yield { type: 'content_delta', content: 'first run' };
      await lifecycle.finish(handle, 'complete', 'test_owner_finished');
      replacement = await lifecycle.begin(session.id, 'user_turn');
      yield { type: 'thinking_delta', thinking: 'late reasoning from first run' };
      yield { type: 'tool_use_start', toolCallId: 'old-tool', toolName: 'read_file' };
      yield { type: 'tool_use_stop', toolCallId: 'old-tool' };
    });
    f.dependencies.lifecycle = lifecycle;
    f.input.handle = handle;
    f.input.request.sessionId = session.id;
    await f.runtime.stream(f.input);
    expect(replacement).toBeDefined();
    expect(coordinator.get(session.id)).toMatchObject({
      runId: replacement!.runId,
      phase: 'analyzing',
      status: 'active',
    });
    await lifecycle.finish(replacement!, 'cancel', 'test_cleanup');
  });

  test('does not publish a phase projection when the durable transition fails', async () => {
    const f = await fixture([{ type: 'content_delta', content: 'uncommitted' }]);
    f.dependencies.lifecycle = {
      phase: async () => {
        throw new Error('durable write failed');
      },
      runRef: () => ({
        sessionId: f.input.handle.sessionId,
        runId: f.input.handle.runId,
        revision: 1,
      }),
    };
    await expect(f.runtime.stream(f.input)).rejects.toThrow('durable write failed');
    expect(f.input.effects.emit).not.toHaveBeenCalled();
    expect(f.input.effects.heartbeat).not.toHaveBeenCalled();
  });

  test('survives gateway tool framing quirks instead of failing the turn', async () => {
    const start: ProviderEvent = {
      type: 'tool_use_start',
      toolCallId: 'a',
      toolName: 'write_file',
    };
    const stop: ProviderEvent = { type: 'tool_use_stop', toolCallId: 'a' };
    // Every one of these used to abort the turn. A gateway glitch must cost at
    // most the affected tool call, never the whole answer.
    const cases: ProviderEvent[][] = [
      [{ type: 'tool_use_delta', toolCallId: 'unknown', toolInput: '{}' }],
      [{ type: 'tool_use_stop', toolCallId: 'unknown' }],
      [start, start, stop],
      [start, stop, start, stop],
      [start],
      [start, { type: 'tool_use_delta', toolCallId: 'a', toolInput: '{bad' }, stop],
      [start, { type: 'tool_use_delta', toolCallId: 'a', toolInput: 'null' }, stop],
      [start, { type: 'tool_use_delta', toolCallId: 'a', toolInput: '[]' }, stop],
      [start, { type: 'tool_use_delta', toolCallId: 'a', toolInput: 'x'.repeat(1_048_577) }, stop],
      [{ type: 'tool_use_start', toolCallId: '', toolName: 'write_file' }],
    ];
    for (const events of cases) {
      const f = await fixture(events);
      await expect(f.runtime.stream(f.input)).resolves.toBeDefined();
    }
  });

  test('streams arguments to the only in-flight call when the gateway drops the id', async () => {
    const f = await fixture([
      { type: 'tool_use_start', toolCallId: 'call-1', toolName: 'read_file' },
      { type: 'tool_use_delta', toolInput: '{"path":' },
      { type: 'tool_use_delta', toolInput: '"a.ts"}' },
      { type: 'tool_use_stop' },
    ]);

    const result = await f.runtime.stream(f.input);

    expect(result.completedToolCalls).toEqual([
      { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  test('runs two calls that reuse one provider id instead of rejecting both', async () => {
    const f = await fixture([
      { type: 'tool_use_start', toolCallId: 'call_0', toolName: 'read_file' },
      { type: 'tool_use_delta', toolCallId: 'call_0', toolInput: '{"path":"a.ts"}' },
      { type: 'tool_use_stop', toolCallId: 'call_0' },
      { type: 'tool_use_start', toolCallId: 'call_0', toolName: 'list_files' },
      { type: 'tool_use_delta', toolCallId: 'call_0', toolInput: '{}' },
      { type: 'tool_use_stop', toolCallId: 'call_0' },
    ]);

    const result = await f.runtime.stream(f.input);

    expect(result.completedToolCalls.map((call) => call.name)).toEqual(['read_file', 'list_files']);
    expect(new Set(result.completedToolCalls.map((call) => call.id)).size).toBe(2);
  });

  test('drops a call with unusable arguments and tells the user instead of aborting', async () => {
    const f = await fixture([
      { type: 'tool_use_start', toolCallId: 'a', toolName: 'write_file' },
      { type: 'tool_use_delta', toolCallId: 'a', toolInput: '{not json' },
      { type: 'tool_use_stop', toolCallId: 'a' },
      { type: 'content_delta', content: 'Continuing without that call.' },
    ]);

    const result = await f.runtime.stream(f.input);

    expect(result.content).toBe('Continuing without that call.');
    expect(result.completedToolCalls).toEqual([]);
    expect(f.emit).toHaveBeenCalledWith(
      'system.notification',
      expect.objectContaining({ type: 'warning' }),
    );
  });

  test('repairs a truncated argument object rather than discarding the call', async () => {
    const f = await fixture([
      { type: 'tool_use_start', toolCallId: 'a', toolName: 'read_file' },
      { type: 'tool_use_delta', toolCallId: 'a', toolInput: '{"path":"a.ts"' },
      { type: 'tool_use_stop', toolCallId: 'a' },
    ]);

    const result = await f.runtime.stream(f.input);

    expect(result.completedToolCalls).toEqual([
      { id: 'a', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });
});
