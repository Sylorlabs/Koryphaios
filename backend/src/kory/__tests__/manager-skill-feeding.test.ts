import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { IMessageStore } from '../../stores/message-store';
import { SessionRuntime } from '../services/SessionRuntime';
import { KoryManager } from '../manager';

const testDirectories: string[] = [];

let skillsHome = '';

beforeEach(() => {
  // Seed bundled skills into a disposable home: block/unblock validates names
  // against listSkills, which seeds the personal root on first read.
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-manager-feeding-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(skillsHome, { recursive: true, force: true });
  for (const directory of testDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

function createManager() {
  const directory = mkdtempSync(join(tmpdir(), 'kory-manager-feeding-'));
  testDirectories.push(directory);
  const providers = {
    resolveProvider: async () => undefined,
    getAvailable: () => [],
    getStatus: () => [],
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const messages = {
    getById: async () => undefined,
  } as unknown as IMessageStore;
  const manager = new KoryManager(
    providers,
    {} as ToolRegistry,
    directory,
    {} as KoryphaiosConfig,
    undefined,
    messages,
  );
  return { manager, directory };
}

function internals(manager: KoryManager): {
  runtimes: {
    get(id: string): SessionRuntime;
    peek(id: string): SessionRuntime | undefined;
    dispose(id: string): void;
  };
  manageSessionSkillFeeding(sessionId: string, request: Record<string, unknown>): Promise<string>;
} {
  const internal = manager as unknown as {
    runtimes: {
      get(id: string): SessionRuntime;
      peek(id: string): SessionRuntime | undefined;
      dispose(id: string): void;
    };
    manageSessionSkillFeeding(sessionId: string, request: Record<string, unknown>): Promise<string>;
  };
  return {
    runtimes: internal.runtimes,
    manageSessionSkillFeeding: (sessionId, request) =>
      internal.manageSessionSkillFeeding(sessionId, request),
  };
}

describe('KoryManager skill feeding control', () => {
  test('report, block, and unblock drive the per-session feeder state', async () => {
    const { manager, directory } = createManager();
    try {
      const internal = internals(manager);
      // Block/unblock validates names through the session working directory;
      // stub the session lookup like the mutation-barrier tests do.
      (
        manager as unknown as {
          resolveSessionWorkingDirectory: (sessionId: string) => Promise<string>;
        }
      ).resolveSessionWorkingDirectory = async () => directory;

      const report = await internal.manageSessionSkillFeeding('session-feed', { action: 'report' });
      expect(report).toContain('Blocked by you: none');

      await expect(
        internal.manageSessionSkillFeeding('session-feed', {
          action: 'block',
          skills: ['definitely-missing-skill'],
        }),
      ).rejects.toThrow('No active skill named definitely-missing-skill');

      const runtime = internal.runtimes.get('session-feed');
      runtime.skillDetailInContext.add('plan-mode');
      const blocked = await internal.manageSessionSkillFeeding('session-feed', {
        action: 'block',
        skills: ['plan-mode'],
        reason: 'already absorbed it',
      });
      expect(blocked).toContain('Blocked: plan-mode');
      expect(blocked).toContain('already absorbed it');
      expect(runtime.skillFeedBlocked.has('plan-mode')).toBe(true);
      // A block also drops any stale already-in-context tracking.
      expect(runtime.skillDetailInContext.has('plan-mode')).toBe(false);

      const blockedReport = await internal.manageSessionSkillFeeding('session-feed', {
        action: 'report',
      });
      expect(blockedReport).toContain('Blocked by you: plan-mode');

      // Blocking twice is a no-op, and unblock restores feeding.
      const repeat = await internal.manageSessionSkillFeeding('session-feed', {
        action: 'block',
        skills: ['plan-mode'],
      });
      expect(repeat).toContain('No change');
      const unblocked = await internal.manageSessionSkillFeeding('session-feed', {
        action: 'unblock',
        skills: ['plan-mode'],
      });
      expect(unblocked).toContain('Unblocked: plan-mode');
      expect(runtime.skillFeedBlocked.has('plan-mode')).toBe(false);

      await expect(
        internal.manageSessionSkillFeeding('session-feed', { action: 'hijack' }),
      ).rejects.toThrow('Unknown action');
    } finally {
      manager.shutdown();
    }
  });

  test('accepts the stringified array forms models actually send', async () => {
    const { manager, directory } = createManager();
    try {
      const internal = internals(manager);
      (
        manager as unknown as {
          resolveSessionWorkingDirectory: (sessionId: string) => Promise<string>;
        }
      ).resolveSessionWorkingDirectory = async () => directory;
      const runtime = internal.runtimes.get('session-feed-coerce');

      // JSON-encoded array in a string — the form a flash model sent four
      // times in a row during the live smoke.
      const blocked = await internal.manageSessionSkillFeeding('session-feed-coerce', {
        action: 'block',
        skills: '["response-style"]',
      });
      expect(blocked).toContain('Blocked: response-style');
      expect(runtime.skillFeedBlocked.has('response-style')).toBe(true);

      // Bare single name in a string.
      const second = await internal.manageSessionSkillFeeding('session-feed-coerce', {
        action: 'block',
        skills: 'plan-mode',
      });
      expect(second).toContain('Blocked: plan-mode');

      // JSON-encoded single name in a string.
      const third = await internal.manageSessionSkillFeeding('session-feed-coerce', {
        action: 'block',
        skills: '"critic-review"',
      });
      expect(third).toContain('Blocked: critic-review');

      // Comma-separated bare names.
      const fourth = await internal.manageSessionSkillFeeding('session-feed-coerce', {
        action: 'unblock',
        skills: 'response-style,plan-mode',
      });
      expect(fourth).toContain('Unblocked: response-style, plan-mode');
      expect(runtime.skillFeedBlocked.has('response-style')).toBe(false);
      expect(runtime.skillFeedBlocked.has('plan-mode')).toBe(false);
    } finally {
      manager.shutdown();
    }
  });

  test('session disposal clears the feeder state with the rest of the runtime', () => {
    const runtime = new SessionRuntime();
    runtime.skillDetailInContext.add('plan-mode');
    runtime.skillFeedBlocked.add('verification');
    runtime.emittedSkillSetKey = 'plan-mode@personal:full';
    runtime.lastFedSkills = ['plan-mode'];

    runtime.dispose();

    expect(runtime.skillDetailInContext.size).toBe(0);
    expect(runtime.skillFeedBlocked.size).toBe(0);
    expect(runtime.emittedSkillSetKey).toBeUndefined();
    expect(runtime.lastFedSkills).toBeUndefined();
  });

  test('blocks survive runtime disposal via the durable session override', async () => {
    const { manager, directory } = createManager();
    try {
      const internal = internals(manager);
      (
        manager as unknown as {
          resolveSessionWorkingDirectory: (sessionId: string) => Promise<string>;
        }
      ).resolveSessionWorkingDirectory = async () => directory;
      const saved: Array<Record<string, unknown>> = [];
      (manager as unknown as { sessions: unknown }).sessions = {
        get: async () => ({ id: 'session-feed-durable', version: 1 }),
        updateWithCurrentVersion: async (_id: string, updates: Record<string, unknown>) => {
          saved.push(updates);
          return { id: 'session-feed-durable', ...updates, version: 2 };
        },
      };

      await internal.manageSessionSkillFeeding('session-feed-durable', {
        action: 'block',
        skills: ['plan-mode'],
      });
      expect(saved.length).toBe(1);
      expect(
        (saved[0].agentOverrides as { blockedSkillFeeds?: string[] }).blockedSkillFeeds,
      ).toEqual(['plan-mode']);

      // Simulate the abandoned-session reaper: the whole runtime is disposed
      // and a fresh one is created on the next touch.
      internal.runtimes.dispose('session-feed-durable');
      const report = await internal.manageSessionSkillFeeding('session-feed-durable', {
        action: 'report',
      });
      expect(report).toContain('Blocked by you: plan-mode');

      // Unblocking persists the removal by dropping the override key.
      const unblocked = await internal.manageSessionSkillFeeding('session-feed-durable', {
        action: 'unblock',
        skills: ['plan-mode'],
      });
      expect(unblocked).toContain('Unblocked: plan-mode');
      expect(
        (saved[saved.length - 1].agentOverrides as Record<string, unknown>).blockedSkillFeeds,
      ).toBeUndefined();
    } finally {
      manager.shutdown();
    }
  });
});
