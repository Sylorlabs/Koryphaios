import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, ModelDef, ProviderName } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { Provider, ProviderEvent, StreamRequest } from '../../providers/types';
import type { CompactionCommit, IMessageStore } from '../../stores/message-store';
import { db, sessions as sessionRows } from '../../db';
import { registerLiveModelResolver } from '../../providers/models';
import { KoryManager } from '../manager';
import { getContextArchive, usageSnapshotMatchesBoundary } from '../context-archive';

const tempDirs: string[] = [];
const VERIFIED_WINDOW = 200_000;

function checkpointJson(): string {
  return JSON.stringify({
    projectBrief: 'Session checkpoint after compaction.',
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
  boundary: () => { messageId: string | null; contextRevision: number };
  committed: () => CompactionCommit | undefined;
}

async function createHarness(options?: { replyTokensOut?: number }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'koryphaios-compaction-usage-'));
  tempDirs.push(dir);
  const sessionId = `compaction-usage-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await db.insert(sessionRows).values({
    id: sessionId,
    title: 'Compaction usage',
    workingDirectory: dir,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // commitCompaction moves the boundary exactly as the real store does: a new
  // active message id and an advanced conversation revision. That transition
  // is what invalidates the previous usage snapshot.
  const state = {
    messageId: 'assistant-final' as string | null,
    contextRevision: 0,
  };
  let committed: CompactionCommit | undefined;
  const provider = {
    name: 'codex',
    config: {},
    isAvailable: () => true,
    listModels: () => [],
    async *streamResponse(_request: StreamRequest) {
      yield {
        type: 'content_delta',
        content: checkpointJson(),
      } satisfies ProviderEvent;
      yield { type: 'usage_update', tokensIn: 5_000, tokensOut: options?.replyTokensOut ?? 0 } satisfies ProviderEvent;
    },
  } as unknown as Provider;

  const messageStore = {
    getContextMessages: async () => [
      { id: 'm0', sessionId, role: 'user', content: 'Do the work.', createdAt: 0 },
      {
        id: 'assistant-final',
        sessionId,
        role: 'assistant',
        content: 'Work is in progress with concrete detail.',
        createdAt: 1,
      },
    ],
    getActiveBoundary: async () => ({
      messageId: state.messageId,
      contextRevision: state.contextRevision,
    }),
    commitCompaction: async (input: CompactionCommit) => {
      committed = input;
      state.messageId = `compact-${input.id}`;
      state.contextRevision = 1;
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
    boundary: () => ({ messageId: state.messageId, contextRevision: state.contextRevision }),
    committed: () => committed,
  };
}

afterEach(() => {
  registerLiveModelResolver(() => undefined);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function installVerifiedWindow(window = VERIFIED_WINDOW) {
  registerLiveModelResolver(
    (modelId: string, provider: ProviderName) =>
      ({
        id: modelId,
        name: modelId,
        provider,
        contextWindow: window,
        contextVerified: true,
      }) as unknown as ModelDef,
  );
}

describe('context usage across a compaction', () => {
  test('records occupancy at the post-compaction boundary so the meter does not blank', async () => {
    installVerifiedWindow();
    const harness = await createHarness();
    try {
      // A usage snapshot from before the compaction, stamped on the OLD
      // boundary. A compaction invalidates it by construction.
      const archive = getContextArchive();
      expect(archive).not.toBeNull();
      await archive!.recordUsage(harness.sessionId, {
        used: 180_000,
        max: VERIFIED_WINDOW,
        contextKnown: true,
        model: 'gpt-selected',
        provider: 'codex',
        activeMessageId: 'assistant-final',
        contextRevision: 0,
        ts: Date.now(),
      });

      const result = await harness.manager.compactSession({
        sessionId: harness.sessionId,
        selectedModel: 'codex:gpt-selected',
        automatic: true,
      });
      expect(harness.committed()).toBeDefined();

      // The stale snapshot must no longer be reusable...
      const after = await getContextArchive()!.getLastUsage(harness.sessionId);
      expect(usageSnapshotMatchesBoundary(after, harness.boundary())).toBe(true);
      expect(after?.activeMessageId).toBe(`compact-${result.compactionId}`);
      expect(after?.contextRevision).toBe(1);
      expect(after?.contextKnown).toBe(true);
      expect(after?.max).toBe(VERIFIED_WINDOW);
      // The checkpoint's real occupancy, not the pre-compaction 180k.
      expect(after?.used).toBe(result.checkpointTokens);
      expect(after?.used).not.toBe(180_000);
      // Never exact: the provider has not re-reported since the rewrite, so
      // this must not arm the auto-compaction trigger.
      expect(after?.estimated).toBe(true);
    } finally {
      harness.manager.shutdown();
    }
  });

  test('the post-compaction snapshot is served by the reload route and the model preview', async () => {
    installVerifiedWindow();
    const harness = await createHarness();
    try {
      const result = await harness.manager.compactSession({
        sessionId: harness.sessionId,
        selectedModel: 'codex:gpt-selected',
        automatic: true,
      });

      // Reload path: what GET /api/sessions/:id/context returns as lastUsage.
      const persisted = await getContextArchive()!.getLastUsage(harness.sessionId);
      expect(usageSnapshotMatchesBoundary(persisted, harness.boundary())).toBe(true);

      // Preview path: the composer's model-preview must reuse it rather than
      // reporting "no authoritative usage" and blanking the bar.
      const preview = await harness.manager.previewModelContext(
        harness.sessionId,
        'gpt-selected',
        'codex',
      );
      expect(preview.usageKnown).toBe(true);
      expect(preview.used).toBe(result.checkpointTokens);
      expect(preview.contextKnown).toBe(true);
      expect(preview.contextWindow).toBe(VERIFIED_WINDOW);
    } finally {
      harness.manager.shutdown();
    }
  });

  test('refuses to stamp usage onto a boundary that advanced past the checkpoint', async () => {
    installVerifiedWindow();
    const harness = await createHarness();
    try {
      // Simulate a concurrent turn that moves the boundary after compaction
      // committed but before the usage snapshot lands.
      const original = harness.boundary();
      const store = (
        harness.manager as unknown as { messages: IMessageStore }
      ).messages;
      const racedStore = {
        ...store,
        getActiveBoundary: async () => ({ messageId: 'user-newer', contextRevision: 2 }),
      } as unknown as IMessageStore;
      (harness.manager as unknown as { messages: IMessageStore }).messages = racedStore;

      const result = await harness.manager.compactSession({
        sessionId: harness.sessionId,
        selectedModel: 'codex:gpt-selected',
        automatic: true,
      });
      expect(harness.committed()).toBeDefined();

      const after = await getContextArchive()!.getLastUsage(harness.sessionId);
      // No snapshot may claim the newer boundary.
      expect(after).toBeUndefined();
      expect(original.contextRevision).toBe(0);
      expect(result.compactionId).toBeTruthy();
    } finally {
      harness.manager.shutdown();
    }
  });

  test('a failed compaction leaves the previous snapshot intact', async () => {
    installVerifiedWindow();
    const harness = await createHarness();
    try {
      const archive = getContextArchive()!;
      await archive.recordUsage(harness.sessionId, {
        used: 120_000,
        max: VERIFIED_WINDOW,
        contextKnown: true,
        model: 'gpt-selected',
        provider: 'codex',
        activeMessageId: 'assistant-final',
        contextRevision: 0,
        ts: Date.now(),
      });

      // No conversation to compact.
      const empty = harness.manager as unknown as { messages: IMessageStore };
      const previous = empty.messages;
      empty.messages = {
        ...previous,
        getContextMessages: async () => [],
      } as unknown as IMessageStore;

      await expect(
        harness.manager.compactSession({
          sessionId: harness.sessionId,
          selectedModel: 'codex:gpt-selected',
          automatic: true,
        }),
      ).rejects.toThrow(/not enough conversation/i);

      const after = await archive.getLastUsage(harness.sessionId);
      expect(after?.used).toBe(120_000);
      expect(usageSnapshotMatchesBoundary(after, harness.boundary())).toBe(true);
    } finally {
      harness.manager.shutdown();
    }
  });
});
