import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import { SessionStateService } from '../services/SessionStateService';
import { KoryManager } from '../manager';

const testDirectories: string[] = [];

function createManager() {
  const directory = mkdtempSync(join(tmpdir(), 'kory-manager-barrier-'));
  testDirectories.push(directory);
  const resolveProvider = mock(async () => undefined);
  const providers = {
    resolveProvider,
    getAvailable: () => [],
    getStatus: () => [],
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const manager = new KoryManager(providers, {} as ToolRegistry, directory, {} as KoryphaiosConfig);
  return { manager, resolveProvider };
}

function managerState(manager: KoryManager): SessionStateService {
  return (manager as unknown as { state: SessionStateService }).state;
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

describe('KoryManager session mutation barrier', () => {
  test('is exclusive and its release lease is idempotent', () => {
    const { manager } = createManager();
    try {
      const lease = manager.tryAcquireSessionMutationBarrier('session-a');
      expect(lease).not.toBeNull();
      expect(manager.isSessionRunning('session-a')).toBe(true);
      expect(manager.tryAcquireSessionMutationBarrier('session-a')).toBeNull();

      lease!.release();
      lease!.release();
      expect(manager.isSessionRunning('session-a')).toBe(false);

      const reacquired = manager.tryAcquireSessionMutationBarrier('session-a');
      expect(reacquired).not.toBeNull();
      reacquired!.release();
    } finally {
      manager.shutdown();
    }
  });

  test('prevents processTask from entering provider resolution while held', async () => {
    const { manager, resolveProvider } = createManager();
    try {
      const lease = manager.tryAcquireSessionMutationBarrier('session-b');
      expect(lease).not.toBeNull();

      await manager.processTask('session-b', 'must not start during recovery');

      expect(resolveProvider).not.toHaveBeenCalled();
      expect(manager.isSessionRunning('session-b')).toBe(true);
      lease!.release();
      expect(manager.isSessionRunning('session-b')).toBe(false);
    } finally {
      manager.shutdown();
    }
  });

  test('cancellation resolves pending input before any manager controller exists', async () => {
    const { manager } = createManager();
    try {
      const state = managerState(manager);
      const pending = state.requestUserInput('session-c', 0);
      expect(state.hasPendingInput('session-c')).toBe(true);

      await manager.cancelSessionWorkers('session-c');

      await expect(pending).resolves.toBe('__cancelled__');
      expect(state.hasPendingInput('session-c')).toBe(false);
    } finally {
      manager.shutdown();
    }
  });
});
