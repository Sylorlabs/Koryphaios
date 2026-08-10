import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  recoverSessionFileErasures,
  stageSessionFilesForErasure,
} from './session-file-erasure';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-session-files-'));
  roots.push(root);
  for (const namespace of ['sessions', 'snapshots']) {
    for (const sessionId of ['target', 'keep']) {
      const directory = join(root, '.koryphaios', namespace, sessionId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'sentinel.txt'), `${namespace}-${sessionId}`);
    }
  }
  return root;
}

describe('session file erasure staging', () => {
  test('rollback restores exact target directories and leaves other sessions untouched', () => {
    const root = project();
    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target'],
      scope: 'selected',
    });
    expect(existsSync(join(root, '.koryphaios', 'sessions', 'target'))).toBe(false);
    expect(existsSync(join(root, '.koryphaios', 'snapshots', 'target'))).toBe(false);
    expect(readFileSync(join(root, '.koryphaios', 'sessions', 'keep', 'sentinel.txt'), 'utf8')).toBe(
      'sessions-keep',
    );

    lease.rollback();
    expect(readFileSync(join(root, '.koryphaios', 'sessions', 'target', 'sentinel.txt'), 'utf8')).toBe(
      'sessions-target',
    );
    expect(readFileSync(join(root, '.koryphaios', 'snapshots', 'target', 'sentinel.txt'), 'utf8')).toBe(
      'snapshots-target',
    );
    expect(existsSync(lease.recoveryReceiptPath)).toBe(false);
  });

  test('restart recovery finalizes a committed database deletion', async () => {
    const root = project();
    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target'],
      scope: 'selected',
    });
    lease.markDatabaseCommitStarted();

    const recovery = await recoverSessionFileErasures({
      receiptRoot: root,
      sessionExists: () => false,
    });
    expect(recovery).toEqual([{ operationId: lease.operationId, action: 'finalized' }]);
    expect(existsSync(join(root, '.koryphaios', 'sessions', 'target'))).toBe(false);
    expect(existsSync(join(root, '.koryphaios', 'snapshots', 'target'))).toBe(false);
    expect(existsSync(lease.recoveryReceiptPath)).toBe(false);
    expect(readFileSync(join(root, '.koryphaios', 'sessions', 'keep', 'sentinel.txt'), 'utf8')).toBe(
      'sessions-keep',
    );
  });

  test('restart recovery rolls back when the database still owns the session', async () => {
    const root = project();
    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target'],
      scope: 'selected',
    });
    lease.markDatabaseCommitStarted();

    const recovery = await recoverSessionFileErasures({
      receiptRoot: root,
      sessionExists: (sessionId) => sessionId === 'target',
    });
    expect(recovery).toEqual([{ operationId: lease.operationId, action: 'rolled-back' }]);
    expect(readFileSync(join(root, '.koryphaios', 'sessions', 'target', 'sentinel.txt'), 'utf8')).toBe(
      'sessions-target',
    );
    expect(existsSync(lease.recoveryReceiptPath)).toBe(false);
  });

  test('unsafe symlink targets fail before any session path is moved', () => {
    const root = project();
    rmSync(join(root, '.koryphaios', 'sessions', 'target'), { recursive: true });
    Bun.spawnSync([
      'ln',
      '-s',
      join(root, '.koryphaios', 'sessions', 'keep'),
      join(root, '.koryphaios', 'sessions', 'target'),
    ]);

    expect(() =>
      stageSessionFilesForErasure({
        receiptRoot: root,
        projectRoots: [root],
        sessionIds: ['target'],
        scope: 'selected',
      }),
    ).toThrow(/unsafe sessions session directory/);
    expect(existsSync(join(root, '.koryphaios', 'snapshots', 'target'))).toBe(true);
    expect(readFileSync(join(root, '.koryphaios', 'sessions', 'keep', 'sentinel.txt'), 'utf8')).toBe(
      'sessions-keep',
    );
  });

  test('delete-all discovers and removes orphan session directories', () => {
    const root = project();
    const orphan = join(root, '.koryphaios', 'sessions', 'orphan');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'sentinel.txt'), 'orphan-sensitive-state');

    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target', 'keep'],
      scope: 'all',
    });
    lease.markDatabaseCommitted();
    lease.finalize();

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(root, '.koryphaios', 'sessions', 'target'))).toBe(false);
    expect(existsSync(join(root, '.koryphaios', 'sessions', 'keep'))).toBe(false);
  });

  test('restart recovery rejects a tampered receipt path without touching it', async () => {
    const root = project();
    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target'],
      scope: 'selected',
    });
    lease.markDatabaseCommitted();
    const receipt = JSON.parse(readFileSync(lease.recoveryReceiptPath, 'utf8')) as {
      paths: Array<{ staged: string }>;
    };
    receipt.paths[0]!.staged = join(root, 'unrelated');
    writeFileSync(lease.recoveryReceiptPath, JSON.stringify(receipt), { mode: 0o600 });

    const recovery = await recoverSessionFileErasures({
      receiptRoot: root,
      sessionExists: () => false,
    });

    expect(recovery[0]).toMatchObject({ action: 'failed' });
    expect(existsSync(lease.recoveryReceiptPath)).toBe(true);
  });

  test('restart never finalizes a pre-commit rollback failure while the DB owns the session', async () => {
    const root = project();
    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target'],
      scope: 'selected',
    });
    const source = join(root, '.koryphaios', 'sessions', 'target');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'new-owner.txt'), 'must-not-be-overwritten-or-deleted');

    expect(() => lease.rollback()).toThrow(/existing path/);
    const receipt = JSON.parse(readFileSync(lease.recoveryReceiptPath, 'utf8')) as {
      phase: string;
      error: { code: string; message: string };
      paths: Array<{ staged: string }>;
    };
    expect(receipt.phase).toBe('stage-rollback-failed');
    expect(receipt.error.code).toBe('STAGE_ROLLBACK_FAILED');
    const stillStaged = receipt.paths.find((entry) => existsSync(entry.staged));
    expect(stillStaged).toBeDefined();

    const recovery = await recoverSessionFileErasures({
      receiptRoot: root,
      sessionExists: (sessionId) => sessionId === 'target',
    });
    expect(recovery[0]).toMatchObject({ action: 'failed' });
    expect(readFileSync(join(source, 'new-owner.txt'), 'utf8')).toBe(
      'must-not-be-overwritten-or-deleted',
    );
    expect(existsSync(stillStaged!.staged)).toBe(true);
    expect(existsSync(lease.recoveryReceiptPath)).toBe(true);
  });

  test('post-commit recovery retains the receipt until credit cleanup succeeds', async () => {
    const root = project();
    const lease = stageSessionFilesForErasure({
      receiptRoot: root,
      projectRoots: [root],
      sessionIds: ['target'],
      scope: 'selected',
    });
    lease.markDatabaseCommitted();
    let attempts = 0;

    const unavailable = await recoverSessionFileErasures({
      receiptRoot: root,
      sessionExists: () => false,
      eraseCredit: async () => {
        attempts++;
        throw new Error('synthetic credit database unavailable');
      },
    });
    expect(unavailable[0]).toMatchObject({ action: 'failed' });
    expect(existsSync(lease.recoveryReceiptPath)).toBe(true);
    expect(existsSync(join(root, '.koryphaios', 'sessions', 'target'))).toBe(false);

    const recovered = await recoverSessionFileErasures({
      receiptRoot: root,
      sessionExists: () => false,
      eraseCredit: async () => {
        attempts++;
      },
    });
    expect(recovered).toEqual([{ operationId: lease.operationId, action: 'finalized' }]);
    expect(attempts).toBe(2);
    expect(existsSync(lease.recoveryReceiptPath)).toBe(false);
  });
});
