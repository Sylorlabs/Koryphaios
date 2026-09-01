import { describe, expect, test } from 'bun:test';
import {
  CollaborationManager,
  onGuestPrompt,
  type CollaborationRuntimeSnapshotWriter,
  type PendingPrompt,
  type PersistedCollaborationRuntime,
} from '../manager';

type RelayMessageHandler = {
  handleRelayMessage(
    message: Record<string, unknown>,
    sessionId: string,
    baseSessionId: string,
    relaySessionId: string,
  ): Promise<void>;
};

function asRelayMessageHandler(manager: CollaborationManager): RelayMessageHandler {
  return manager as unknown as RelayMessageHandler;
}

function guestPromptMessage(content: string): Record<string, unknown> {
  return {
    type: 'guest-prompt',
    guestId: 'guest-1',
    name: 'Guest',
    role: 'collaborator',
    tierId: 'collaborator',
    content,
    model: 'openai:gpt-5',
    reasoningLevel: 'high',
    commandAllowlist: ['git'],
    commandBlocklist: ['git push'],
    autoExecute: false,
  };
}

function pendingPrompt(sessionId: string, content: string, sourceCommandId: string): PendingPrompt {
  return {
    guestId: 'guest-1',
    name: 'Guest',
    role: 'collaborator',
    content,
    sessionId,
    sourceCommandId,
    timestamp: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for collaboration persistence operation');
}

describe('collaboration runtime durability', () => {
  test('failed prompt creation persistence never publishes or exposes the prompt', async () => {
    const writes: PersistedCollaborationRuntime[] = [];
    const writer: CollaborationRuntimeSnapshotWriter = async (_sessionId, snapshot) => {
      writes.push(snapshot);
      throw new Error('snapshot write failed');
    };
    const manager = new CollaborationManager(writer);
    const emitted: Array<PendingPrompt & { promptId: string }> = [];
    const unsubscribe = onGuestPrompt((prompt) => emitted.push(prompt));

    try {
      await expect(
        asRelayMessageHandler(manager).handleRelayMessage(
          guestPromptMessage('must be durable first'),
          'collab-create-failure',
          'chat-create-failure',
          'relay-create-failure',
        ),
      ).rejects.toThrow('snapshot write failed');

      expect(manager.getPendingPrompts('collab-create-failure')).toEqual([]);
      expect(emitted).toEqual([]);
      expect(writes).toHaveLength(1);
      expect(writes[0].pendingPrompts).toHaveLength(1);
      expect(writes[0].pendingPrompts[0].sourceCommandId).toBe(
        `collaboration:relay-create-failure:${writes[0].pendingPrompts[0].promptId}`,
      );
    } finally {
      unsubscribe();
    }
  });

  test('failed prompt resolution persistence retains the exact durable command', async () => {
    let writeCount = 0;
    const durableSnapshots: PersistedCollaborationRuntime[] = [];
    const writer: CollaborationRuntimeSnapshotWriter = async (_sessionId, snapshot) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error('delete snapshot failed');
      durableSnapshots.push(snapshot);
    };
    const manager = new CollaborationManager(writer);
    const emitted: Array<PendingPrompt & { promptId: string }> = [];
    const unsubscribe = onGuestPrompt((prompt) => emitted.push(prompt));

    try {
      await asRelayMessageHandler(manager).handleRelayMessage(
        guestPromptMessage('retain me on delete failure'),
        'collab-delete-failure',
        'chat-delete-failure',
        'relay-delete-failure',
      );
      const published = emitted[0];
      expect(published).toBeDefined();

      await expect(manager.resolveGuestPrompt(published.promptId, true)).rejects.toThrow(
        'delete snapshot failed',
      );

      expect(manager.getPendingPrompt(published.promptId)).toMatchObject({
        content: published.content,
        sourceCommandId: published.sourceCommandId,
      });
      expect(durableSnapshots).toHaveLength(1);
      expect(durableSnapshots[0].pendingPrompts[0]).toMatchObject({
        promptId: published.promptId,
        sourceCommandId: published.sourceCommandId,
      });

      await manager.resolveGuestPrompt(published.promptId, false);
    } finally {
      unsubscribe();
    }
  });

  test('serializes concurrent snapshots so a later write cannot complete first', async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    const events: string[] = [];
    const snapshots: PersistedCollaborationRuntime[] = [];
    const writer: CollaborationRuntimeSnapshotWriter = async (_sessionId, snapshot) => {
      const index = snapshots.push(snapshot) - 1;
      events.push(`start:${snapshot.revision}`);
      if (index === 0) await firstWrite.promise;
      if (index === 1) await secondWrite.promise;
      events.push(`finish:${snapshot.revision}`);
    };
    const manager = new CollaborationManager(writer);
    const sessionId = 'collab-concurrent-writes';
    const first = manager.createPendingGuestPrompt(
      'prompt-concurrent-1',
      pendingPrompt(sessionId, 'first', 'collaboration:relay:prompt-concurrent-1'),
    );
    const second = manager.createPendingGuestPrompt(
      'prompt-concurrent-2',
      pendingPrompt(sessionId, 'second', 'collaboration:relay:prompt-concurrent-2'),
    );

    await waitFor(() => snapshots.length === 1);
    expect(events).toEqual(['start:1']);
    expect(manager.getPendingPrompts(sessionId)).toEqual([]);

    firstWrite.resolve();
    await first;
    await waitFor(() => snapshots.length === 2);
    expect(events).toEqual(['start:1', 'finish:1', 'start:2']);
    expect(snapshots[1].revision).toBe(2);
    expect(snapshots[1].pendingPrompts.map((prompt) => prompt.promptId).sort()).toEqual([
      'prompt-concurrent-1',
      'prompt-concurrent-2',
    ]);

    secondWrite.resolve();
    await second;
    expect(events).toEqual(['start:1', 'finish:1', 'start:2', 'finish:2']);
    expect(manager.getPendingPrompts(sessionId).map((prompt) => prompt.promptId).sort()).toEqual([
      'prompt-concurrent-1',
      'prompt-concurrent-2',
    ]);

    await manager.resolveGuestPrompt('prompt-concurrent-1', false);
    await manager.resolveGuestPrompt('prompt-concurrent-2', false);
  });
});
