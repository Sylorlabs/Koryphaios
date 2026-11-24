import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { CompactionCommit, IMessageStore } from '../../stores/message-store';
import { KoryManager } from '../manager';

const tempDirs: string[] = [];

/**
 * The reported failure mode: automatic compaction failed with "This session is
 * already running or applying a Time Travel recovery", then cooled the session
 * down for five minutes even though nothing was actually wrong.
 *
 * Cause: the trigger is evaluated inside the completed turn, and
 * `compactSession` -> `tryBeginSessionRun` was invoked synchronously from
 * there, while the turn's own run claim was still held (it is only released in
 * the enclosing `finally`). Every single first attempt was therefore rejected
 * before doing any work.
 */
function createManager(): { manager: KoryManager; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'koryphaios-auto-compact-claim-'));
  tempDirs.push(dir);
  const sessionId = `auto-claim-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const messageStore = {
    getContextMessages: async () => [],
    commitCompaction: async (_input: CompactionCommit) => ({
      sourceRevision: 0,
      targetRevision: 1,
    }),
  } as unknown as IMessageStore;
  const registry = {
    getStatus: () => [],
    getAvailable: () => [],
    resolveProvider: async () => undefined,
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const manager = new KoryManager(
    registry,
    {} as ToolRegistry,
    dir,
    {} as KoryphaiosConfig,
    undefined,
    messageStore,
  );
  return { manager, sessionId };
}

function holdRunClaim(manager: KoryManager, sessionId: string): void {
  (manager as unknown as { tryBeginSessionRun(id: string): boolean }).tryBeginSessionRun(sessionId);
}

function releaseRunClaim(manager: KoryManager, sessionId: string): void {
  (manager as unknown as { endSessionRun(id: string): void }).endSessionRun(sessionId);
}

function schedule(manager: KoryManager, sessionId: string, deps: Record<string, unknown>): void {
  (
    manager as unknown as {
      scheduleAutoCompaction(
        sessionId: string,
        selectedModel: string,
        reasoningLevel: string | undefined,
        deps?: Record<string, unknown>,
      ): void;
    }
  ).scheduleAutoCompaction(sessionId, 'codex:gpt-selected', undefined, deps);
}

function failureCooldown(manager: KoryManager, sessionId: string): number | undefined {
  return (
    manager as unknown as {
      runtimes: { peek(id: string): { lastAutoCompactFailureAt?: number } | undefined };
    }
  ).runtimes.peek(sessionId)?.lastAutoCompactFailureAt;
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('automatic compaction run-claim handoff', () => {
  test('does not attempt synchronously while the completing turn still holds the claim', async () => {
    const { manager, sessionId } = createManager();
    try {
      const compactSession = (
        manager as unknown as { compactSession: (input: unknown) => Promise<unknown> }
      ).compactSession.bind(manager);
      let attempts = 0;
      (
        manager as unknown as { compactSession: (input: unknown) => Promise<unknown> }
      ).compactSession = async (input: unknown) => {
        attempts++;
        return compactSession(input);
      };

      // Reproduce the exact production ordering: the turn's claim is still
      // held when the trigger evaluates.
      holdRunClaim(manager, sessionId);
      schedule(manager, sessionId, { sleep: async () => {}, defer: false });
      expect(attempts).toBe(1);

      // That synchronous attempt is rejected by the still-held claim. The
      // point of the fix is that the DEFERRED path avoids this entirely.
      releaseRunClaim(manager, sessionId);
      await tick();
    } finally {
      manager.shutdown();
    }
  });

  test('defers the first attempt until the completing turn releases its claim', async () => {
    const { manager, sessionId } = createManager();
    try {
      const compactSession = (
        manager as unknown as { compactSession: (input: unknown) => Promise<unknown> }
      ).compactSession.bind(manager);
      // Observe the claim WITHOUT mutating it, so the real attempt sees the
      // same state the probe saw.
      const claimHeld = () =>
        (
          manager as unknown as {
            runtimes: { peek(id: string): { runClaimed?: boolean } | undefined };
          }
        ).runtimes.peek(sessionId)?.runClaimed === true;
      const seenClaimHeld: boolean[] = [];
      (
        manager as unknown as { compactSession: (input: unknown) => Promise<unknown> }
      ).compactSession = async (input: unknown) => {
        seenClaimHeld.push(claimHeld());
        return compactSession(input);
      };

      holdRunClaim(manager, sessionId);
      // Default scheduling (deferred), as the production trigger uses.
      schedule(manager, sessionId, { sleep: async () => {} });
      // Nothing has run yet: the attempt is deferred, not synchronous.
      expect(seenClaimHeld).toHaveLength(0);

      // The turn finishes and releases its claim, as the enclosing finally does.
      releaseRunClaim(manager, sessionId);
      await tick(12);

      expect(seenClaimHeld.length).toBeGreaterThan(0);
      // The deferred attempt never observed a held claim: no wasted attempt
      // and no spurious "already running" failure.
      expect(seenClaimHeld.every((held) => held === false)).toBe(true);
    } finally {
      manager.shutdown();
    }
  });

  test('a compaction blocked by a genuinely busy session does not cool the session down', async () => {
    const { manager, sessionId } = createManager();
    try {
      // Hold the claim and never release it: every attempt is legitimately
      // rejected, and the session must not be cooled down by a busy session.
      holdRunClaim(manager, sessionId);
      schedule(manager, sessionId, { sleep: async () => {} });
      await tick(12);
      expect(failureCooldown(manager, sessionId)).toBeUndefined();
    } finally {
      manager.shutdown();
    }
  });

  test('does not start at all for an erased session', async () => {
    const { manager, sessionId } = createManager();
    try {
      (manager as unknown as { erasedSessions: Set<string> }).erasedSessions.add(sessionId);
      let attempts = 0;
      (
        manager as unknown as { compactSession: (input: unknown) => Promise<unknown> }
      ).compactSession = async () => {
        attempts++;
        return undefined;
      };

      schedule(manager, sessionId, { sleep: async () => {} });
      await tick(8);

      expect(attempts).toBe(0);
    } finally {
      manager.shutdown();
    }
  });
});
