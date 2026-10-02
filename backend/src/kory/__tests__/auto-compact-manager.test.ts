import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import type { CompactionCommit, IMessageStore } from '../../stores/message-store';
import { db, sessions as sessionRows } from '../../db';
import { wsBroker } from '../../pubsub';
import { KoryManager } from '../manager';

const tempDirs: string[] = [];

function checkpointJson(brief: string): string {
  return JSON.stringify({
    projectBrief: brief,
    decisions: ['Use revisioned active context.'],
    filesAndCodeState: ['backend compaction path is active.'],
    completedWork: ['Summarization is wired.'],
    activeWork: ['Run remaining verification.'],
    openIssues: ['None invented.'],
    nextActions: ['Continue from this checkpoint.'],
    criticalContext: ['Source transcript remains in revision zero.'],
    confidenceAndRisk: 'High confidence in the contract.',
    durableMemory: '# Session Memory\n\nCompaction uses revisioned checkpoints.',
  });
}

interface Harness {
  manager: KoryManager;
  sessionId: string;
  providerCalls: () => number;
  committed: () => CompactionCommit | undefined;
}

async function createHarness(
  providerImpl: (callIndex: number, request: StreamRequest) => AsyncGenerator<ProviderEvent>,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'koryphaios-auto-compact-'));
  tempDirs.push(dir);
  const sessionId = `auto-compact-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await db.insert(sessionRows).values({
    id: sessionId,
    title: 'Auto compact',
    workingDirectory: dir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let calls = 0;
  let committed: CompactionCommit | undefined;
  const provider = {
    name: 'codex',
    config: {},
    isAvailable: () => true,
    listModels: () => [],
    async *streamResponse(request: StreamRequest) {
      calls++;
      yield* providerImpl(calls, request);
    },
  } as unknown as Provider;
  const messageStore = {
    getContextMessages: async () =>
      messages.map((message, index) => ({
        id: `m${index}`,
        sessionId,
        role: message.role,
        content: message.content,
        createdAt: index,
      })),
    commitCompaction: async (input: CompactionCommit) => {
      committed = input;
      return { sourceRevision: 0, targetRevision: 1 };
    },
  } as unknown as IMessageStore;
  const registry = {
    getStatus: () => [
      { name: 'codex', authenticated: true, adapterAvailable: true, models: ['gpt-selected'] },
    ],
    resolveProvider: async (model: string, name: string) =>
      model === 'gpt-selected' && name === 'codex' ? provider : undefined,
  } as unknown as ProviderRegistry;
  const manager = new KoryManager(
    registry,
    {} as ToolRegistry,
    dir,
    {} as KoryphaiosConfig,
    undefined,
    messageStore,
  );
  return {
    manager,
    sessionId,
    providerCalls: () => calls,
    committed: () => committed,
  };
}

function captureWsEvents() {
  const seen: Array<{ type?: string; sessionId?: string; payload?: Record<string, unknown> }> = [];
  const originalPublish = wsBroker.publish;
  wsBroker.publish = ((eventType: string, message: Record<string, unknown>) => {
    seen.push({
      type: message.type as string | undefined,
      sessionId: message.sessionId as string | undefined,
      payload: message.payload as Record<string, unknown> | undefined,
    });
    return (originalPublish as (...args: unknown[]) => unknown).call(wsBroker, eventType, message);
  }) as typeof wsBroker.publish;
  return {
    seen,
    restore: () => {
      wsBroker.publish = originalPublish;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for auto-compaction');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function scheduleAuto(manager: KoryManager, sessionId: string): void {
  (
    manager as unknown as {
      scheduleAutoCompaction(
        sessionId: string,
        selectedModel: string,
        reasoningLevel: string | undefined,
        deps?: { sleep?: (ms: number) => Promise<void> },
      ): void;
    }
  ).scheduleAutoCompaction(sessionId, 'codex:gpt-selected', undefined, {
    sleep: async () => {},
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('automatic compaction retry and cooldown', () => {
  test('retries a failing compaction, then banners once and cools down', async () => {
    const harness = await createHarness(
      async function* () {
        yield { type: 'error' as const, error: 'JSON Parse error: boom' };
      },
      [
        { role: 'user', content: 'Implement real compaction with enough text to be valid.' },
        { role: 'assistant', content: 'Implementation is in progress with concrete code changes.' },
      ],
    );
    const capture = captureWsEvents();
    try {
      scheduleAuto(harness.manager, harness.sessionId);
      await waitFor(() => harness.providerCalls() >= 3);
      // Give the scheduler a beat to record the cooldown after the last attempt.
      await waitFor(() =>
        (
          harness.manager as unknown as {
            lastAutoCompactFailureBySession: Map<string, number>;
          }
        ).lastAutoCompactFailureBySession.has(harness.sessionId),
      );
      expect(harness.providerCalls()).toBe(3);
      expect(harness.committed()).toBeUndefined();

      const sessionEvents = capture.seen.filter((event) => event.sessionId === harness.sessionId);
      expect(sessionEvents.filter((event) => event.type === 'compaction.failed')).toHaveLength(3);
      const banners = sessionEvents.filter((event) => event.type === 'system.error');
      expect(banners).toHaveLength(1);
      expect(String((banners[0]?.payload as { error?: string })?.error ?? '')).toContain(
        'Automatic compaction failed',
      );

      // A second trigger while cooling down must not start another attempt.
      scheduleAuto(harness.manager, harness.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.providerCalls()).toBe(3);
    } finally {
      capture.restore();
      harness.manager.shutdown();
    }
  });

  test('a transient provider blip is retried inside one compaction attempt', async () => {
    // The reported failure mode: the provider's stream dies mid-turn. Before the
    // shared retry policy this surfaced as "compaction failed" and lost the
    // session summary; now the same turn is repeated and commits.
    const harness = await createHarness(
      async function* (callIndex) {
        if (callIndex === 1) {
          yield {
            type: 'error' as const,
            error:
              'SSE Error: {"type":"error","error":{"type":"api_error","message":"Temporary service interruption."}}',
            errorTransient: true,
          };
          return;
        }
        yield { type: 'content_delta' as const, content: checkpointJson('Recovered summary') };
        yield { type: 'complete' as const };
      },
      [
        { role: 'user', content: 'Implement real compaction with enough text to be valid.' },
        { role: 'assistant', content: 'Implementation is in progress with concrete code changes.' },
      ],
    );
    const capture = captureWsEvents();
    try {
      const result = await harness.manager.compactSession({
        sessionId: harness.sessionId,
        selectedModel: 'codex:gpt-selected',
      });
      expect(result.sourceMessages).toBe(2);
      expect(harness.providerCalls()).toBe(2);
      expect(harness.committed()?.summary).toContain('Recovered summary');
      const sessionEvents = capture.seen.filter((event) => event.sessionId === harness.sessionId);
      expect(sessionEvents.some((event) => event.type === 'compaction.failed')).toBe(false);
      expect(sessionEvents.some((event) => event.type === 'system.error')).toBe(false);
    } finally {
      capture.restore();
      harness.manager.shutdown();
    }
  });

  test('manual compaction failure reports compaction.failed without a system.error banner', async () => {
    const harness = await createHarness(
      async function* () {
        yield { type: 'error' as const, error: 'manual boom' };
      },
      [
        { role: 'user', content: 'Implement real compaction with enough text to be valid.' },
        { role: 'assistant', content: 'Implementation is in progress with concrete code changes.' },
      ],
    );
    const capture = captureWsEvents();
    try {
      await expect(
        harness.manager.compactSession({
          sessionId: harness.sessionId,
          selectedModel: 'codex:gpt-selected',
        }),
      ).rejects.toThrow('manual boom');
      const sessionEvents = capture.seen.filter((event) => event.sessionId === harness.sessionId);
      expect(sessionEvents.some((event) => event.type === 'compaction.failed')).toBe(true);
      expect(sessionEvents.some((event) => event.type === 'system.error')).toBe(false);
      expect(harness.committed()).toBeUndefined();
    } finally {
      capture.restore();
      harness.manager.shutdown();
    }
  });
});

describe('compaction chunking and tolerant decode', () => {
  test('decodes a JSON-string-encoded checkpoint end to end (backslash regression)', async () => {
    const inner = checkpointJson(
      'Continue the verified compaction implementation without restoring archived transcript messages.',
    );
    const harness = await createHarness(
      async function* () {
        yield { type: 'content_delta' as const, content: JSON.stringify(inner) };
        yield { type: 'usage_update' as const, tokensIn: 500, tokensOut: 120 };
        yield { type: 'complete' as const };
      },
      [
        { role: 'user', content: 'Implement real compaction with enough text to be valid.' },
        { role: 'assistant', content: 'Implementation is in progress with concrete code changes.' },
      ],
    );
    try {
      const result = await harness.manager.compactSession({
        sessionId: harness.sessionId,
        selectedModel: 'codex:gpt-selected',
      });
      expect(result.sourceMessages).toBe(2);
      expect(harness.providerCalls()).toBe(1);
      expect(harness.committed()?.summary).toContain('# Compacted Session Checkpoint');
      expect(harness.committed()?.summary).toContain(
        'Continue the verified compaction implementation',
      );
    } finally {
      harness.manager.shutdown();
    }
  });

  test('summarizes oversized transcripts in halves and merges', async () => {
    const messages = Array.from({ length: 1002 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${index} carries enough concrete project detail to compact. ${index < 501 ? 'ALPHA' : 'BETA'} detail follows with concrete file names and decisions.`,
    }));
    const harness = await createHarness(async function* (callIndex, request) {
      const prompt = (request.messages[0]?.content as string) ?? '';
      if (prompt.includes('PARTIAL CHECKPOINT A')) {
        expect(prompt).toContain('half one');
        expect(prompt).toContain('half two');
        yield { type: 'content_delta' as const, content: checkpointJson('MERGED-CHECKPOINT') };
      } else if (prompt.includes('ALPHA') && !prompt.includes('BETA')) {
        yield { type: 'content_delta' as const, content: checkpointJson('half one') };
      } else if (prompt.includes('BETA') && !prompt.includes('ALPHA')) {
        yield { type: 'content_delta' as const, content: checkpointJson('half two') };
      } else {
        throw new Error('chunking test: unexpected summarizer prompt split');
      }
      yield { type: 'usage_update' as const, tokensIn: 500, tokensOut: 120 };
      yield { type: 'complete' as const };
    }, messages);
    try {
      const result = await harness.manager.compactSession({
        sessionId: harness.sessionId,
        selectedModel: 'codex:gpt-selected',
      });
      expect(harness.providerCalls()).toBe(3);
      expect(result.sourceMessages).toBe(1002);
      expect(harness.committed()?.summary).toContain('MERGED-CHECKPOINT');
    } finally {
      harness.manager.shutdown();
    }
  });
});
