import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { IMessageStore } from '../../stores/message-store';
import type { ISessionStore } from '../../stores/session-store';
import type { InternalMessage } from '../../providers/types';
import { KoryManager } from '../manager';
import { getContextArchive } from '../context-archive';

const tempDirs: string[] = [];

function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'koryphaios-pruning-'));
  tempDirs.push(dir);
  return dir;
}

function createManager(dir: string): KoryManager {
  const providers = {
    getAvailable: () => [],
    getStatus: () => [],
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  // Pruning runs against the chat's own isolated checkout, so the manager needs
  // a readable session row it can migrate that checkout from and persist back.
  const rows = new Map<string, { id: string; workingDirectory: string; version: number }>();
  const sessions = {
    get: async (id: string) => rows.get(id) ?? { id, workingDirectory: dir, version: 1 },
    update: async (id: string, updates: { gitWorkspace?: unknown }, version: number) => {
      const current = (await sessions.get(id)) as { version: number };
      if (current.version !== version) return undefined;
      const next = { ...current, ...updates, version: version + 1 };
      rows.set(id, next);
      return next;
    },
  };
  return new KoryManager(
    providers,
    {} as ToolRegistry,
    dir,
    {} as KoryphaiosConfig,
    sessions as unknown as ISessionStore,
    {} as IMessageStore,
  );
}

type PrunableMessage = InternalMessage & {
  archiveId?: string;
  archiveTurn?: number;
  pruneApplied?: boolean;
};

/** Reach the private pruning routine the manager applies each tool-loop turn. */
function prune(
  manager: KoryManager,
  sessionId: string,
  messages: PrunableMessage[],
  currentTurn: number,
): Promise<void> {
  return (
    manager as unknown as {
      applyContextPruning(
        sessionId: string,
        messages: InternalMessage[],
        currentTurn: number,
      ): Promise<void>;
    }
  ).applyContextPruning(sessionId, messages, currentTurn);
}

function toolMessage(
  callId: string,
  output: string,
  archiveId: string,
  archiveTurn: number,
  isError = false,
): PrunableMessage {
  return {
    role: 'tool',
    content: JSON.stringify({ callId, name: 'bash', output, isError, durationMs: 5 }),
    tool_call_id: callId,
    archiveId,
    archiveTurn,
  } as PrunableMessage;
}

function parsedOutput(message: PrunableMessage): { output: string; isError: boolean } {
  return JSON.parse(message.content) as { output: string; isError: boolean };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('manager context pruning', () => {
  test('reclaims a tool output whose ORIGINAL size blew the live-context bound', async () => {
    // The 30k dispatch cap already truncated the live content, so a bound
    // measured against the live content could never fire and an enormous
    // output stayed resident for the whole turn. The archive knows the true
    // original size, so that is what must drive the decision.
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const sessionId = 'prune-oversized';
      const huge = 'x'.repeat(500_000);
      const archiveId = await getContextArchive()!.record(
        sessionId,
        'terminal',
        'bash build',
        huge,
      );
      const capped = 'y'.repeat(30_000);
      const message = toolMessage('call-1', capped, archiveId, 1);

      await prune(manager, sessionId, [message], 1);

      expect(message.pruneApplied).toBe(true);
      const { output } = parsedOutput(message);
      expect(output).toContain('was too large for the live context and was pruned');
      expect(output).toContain(`fetch_context id=${archiveId}`);
      // The stub replaces the truncated 30k blob rather than keeping it.
      expect(message.content.length).toBeLessThan(1_000);
    } finally {
      manager.shutdown();
    }
  });

  test('keeps a small recent output fully intact', async () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const sessionId = 'prune-recent-small';
      const archiveId = await getContextArchive()!.record(sessionId, 'tool_result', 'ls', 'a b c');
      const message = toolMessage('call-1', 'a b c', archiveId, 1);
      const before = message.content;

      await prune(manager, sessionId, [message], 1);

      expect(message.pruneApplied).toBeUndefined();
      expect(message.content).toBe(before);
    } finally {
      manager.shutdown();
    }
  });

  test('prunes a stale output past the keep-recent-turns bound', async () => {
    const dir = createDir();
    writeFileSync(
      join(dir, 'koryphaios.json'),
      JSON.stringify({ agentSettings: { contextKeepRecentTurns: 2, contextPruneMinChars: 10 } }),
    );
    const manager = createManager(dir);
    try {
      const sessionId = 'prune-stale';
      const archiveId = await getContextArchive()!.record(
        sessionId,
        'tool_result',
        'grep',
        'z'.repeat(5_000),
      );
      const message = toolMessage('call-1', 'z'.repeat(5_000), archiveId, 1);

      // turn 4 - turn 1 = 3 > 2 keeps
      await prune(manager, sessionId, [message], 3);
      expect(message.pruneApplied).toBeUndefined();

      // turn 5 - turn 1 = 4 > 2 prunes
      await prune(manager, sessionId, [message], 5);
      expect(message.pruneApplied).toBe(true);
      expect(parsedOutput(message).output).toContain('pruned to save context');
    } finally {
      manager.shutdown();
    }
  });

  test('honors a user/agent hide regardless of the age settings', async () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const sessionId = 'prune-hidden';
      const archiveId = await getContextArchive()!.record(
        sessionId,
        'tool_result',
        'read_file',
        'contents',
      );
      const message = toolMessage('call-1', 'contents', archiveId, 1);
      await getContextArchive()!.setPrunedForAgent(sessionId, archiveId, true);

      await prune(manager, sessionId, [message], 1);

      expect(message.pruneApplied).toBe(true);
      expect(parsedOutput(message).output).toContain('pruned to save context');
    } finally {
      manager.shutdown();
    }
  });

  test('preserves the failure bit when stubbing a failed tool result', async () => {
    // Hardcoding isError:false told the model a command that had failed had
    // succeeded — strictly worse than losing the output.
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const sessionId = 'prune-error';
      const archiveId = await getContextArchive()!.record(
        sessionId,
        'terminal',
        'bash deploy',
        'command not found',
        true,
      );
      const message = toolMessage('call-1', 'command not found', archiveId, 1, true);
      await getContextArchive()!.setPrunedForAgent(sessionId, archiveId, true);

      await prune(manager, sessionId, [message], 1);

      expect(message.pruneApplied).toBe(true);
      expect(parsedOutput(message).isError).toBe(true);
    } finally {
      manager.shutdown();
    }
  });

  test('does not restub an already-stubbed message', async () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const sessionId = 'prune-idempotent';
      const archiveId = await getContextArchive()!.record(
        sessionId,
        'tool_result',
        'read_file',
        'z'.repeat(5_000),
      );
      const message = toolMessage('call-1', 'z'.repeat(5_000), archiveId, 1);
      await getContextArchive()!.setPrunedForAgent(sessionId, archiveId, true);

      await prune(manager, sessionId, [message], 9);
      const afterFirst = message.content;
      await prune(manager, sessionId, [message], 12);

      expect(message.content).toBe(afterFirst);
    } finally {
      manager.shutdown();
    }
  });

  test('never touches a message that has no archive id', async () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const message: PrunableMessage = {
        role: 'tool',
        content: JSON.stringify({ callId: 'c', name: 'x', output: 'q'.repeat(90_000) }),
        tool_call_id: 'c',
      } as PrunableMessage;
      const before = message.content;

      await prune(manager, 'prune-no-archive', [message], 99);

      expect(message.content).toBe(before);
      expect(message.pruneApplied).toBeUndefined();
    } finally {
      manager.shutdown();
    }
  });
});

describe('manager tool message construction', () => {
  function buildToolMessage(
    manager: KoryManager,
    output: string,
    archiveId: string | undefined,
    turnCount: number,
  ): PrunableMessage {
    return (
      manager as unknown as {
        buildManagerToolMessage(
          tc: { id: string },
          toolResult: { output: string; isError: boolean; durationMs: number },
          archiveId: string | undefined,
          turnCount: number,
        ): PrunableMessage;
      }
    ).buildManagerToolMessage(
      { id: 'call-9' } as never,
      { output, isError: false, durationMs: 3 } as never,
      archiveId,
      turnCount,
    );
  }

  test('caps a huge tool output and points at the durable preview', () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const message = buildToolMessage(manager, 'z'.repeat(400_000), 'cx_7', 3);
      const parsed = JSON.parse(message.content) as { output: string };
      expect(message.content.length).toBeLessThan(31_000);
      expect(parsed.output).toContain('truncated 370000 chars');
      expect(parsed.output).toContain('fetch_context id=cx_7');
      // Prune metadata is present, so applyContextPruning can reclaim it.
      expect(message.archiveId).toBe('cx_7');
      expect(message.archiveTurn).toBe(3);
    } finally {
      manager.shutdown();
    }
  });

  test('leaves a small tool output untouched but still prunable', () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const message = buildToolMessage(manager, 'small output', 'cx_8', 2);
      expect(JSON.parse(message.content)).toMatchObject({ output: 'small output' });
      expect(message.archiveId).toBe('cx_8');
      expect(message.archiveTurn).toBe(2);
    } finally {
      manager.shutdown();
    }
  });

  test('omits prune metadata when no archive entry exists', () => {
    const dir = createDir();
    const manager = createManager(dir);
    try {
      const message = buildToolMessage(manager, 'q'.repeat(90_000), undefined, 1);
      expect(message.archiveId).toBeUndefined();
      expect(message.archiveTurn).toBeUndefined();
      expect(message.content.length).toBeLessThan(31_000);
    } finally {
      manager.shutdown();
    }
  });
});
