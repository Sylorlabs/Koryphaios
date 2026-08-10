import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_ARCHIVE_LIMITS, ContextArchiveService } from './context-archive';

describe('ContextArchiveService history pruning', () => {
  it('removes tool context after the edited conversation pivot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-edit-'));
    try {
      const archive = new ContextArchiveService(root);
      const sessionId = 'session';
      const keptId = await archive.record(sessionId, 'tool_result', 'before', 'kept');
      const pivot = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      await archive.record(sessionId, 'tool_result', 'after', 'removed');

      expect(await archive.truncateAfter(sessionId, pivot)).toBe(1);
      expect((await archive.listRecent(sessionId, 10)).map((entry) => entry.id)).toEqual([keptId]);
      const persisted = await readFile(
        join(root, '.koryphaios', 'sessions', sessionId, 'context-archive.jsonl'),
        'utf8',
      );
      expect(persisted).toContain('kept');
      expect(persisted).not.toContain('removed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists only a bounded redacted preview with truthful metadata across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-large-'));
    try {
      const secret = `sk-proj-${'A'.repeat(32)}`;
      const tailSentinel = 'RAW-SIX-MEGABYTE-TAIL-MUST-NEVER-PERSIST';
      const content = `authorization=Bearer ${secret}\n${'x'.repeat(6 * 1024 * 1024)}${tailSentinel}`;
      const id = await new ContextArchiveService(root).record(
        'session',
        'tool_result',
        'large build output',
        content,
      );
      const file = join(root, '.koryphaios', 'sessions', 'session', 'context-archive.jsonl');
      const persisted = await readFile(file, 'utf8');
      const reloaded = await new ContextArchiveService(root).get('session', id);
      expect(Buffer.byteLength(persisted)).toBeLessThan(10_000);
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain(tailSentinel);
      expect(reloaded?.content).toContain('[REDACTED]');
      expect(reloaded?.content).not.toContain(secret);
      expect(Buffer.byteLength(reloaded?.content ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);
      expect(reloaded?.originalByteCount).toBe(Buffer.byteLength(content, 'utf8'));
      expect(reloaded?.contentSha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect(reloaded?.truncated).toBe(true);
      expect(reloaded?.redacted).toBe(true);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, '.koryphaios'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, '.koryphaios', 'sessions'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, '.koryphaios', 'sessions', 'session'))).mode & 0o777).toBe(
        0o700,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('heals legacy directory and file modes without rewriting existing content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-mode-'));
    try {
      const sessionDirectory = join(root, '.koryphaios', 'sessions', 'session');
      const file = join(sessionDirectory, 'context-archive.jsonl');
      await mkdir(sessionDirectory, { recursive: true, mode: 0o775 });
      const original = `${JSON.stringify({
        id: 'cx_0',
        sessionId: 'session',
        ts: 1,
        kind: 'tool_result',
        label: 'legacy',
        content: 'existing content remains byte-for-byte intact',
        originalByteCount: 45,
        contentSha256: createHash('sha256')
          .update('existing content remains byte-for-byte intact')
          .digest('hex'),
        truncated: false,
        redacted: false,
      })}\n`;
      await writeFile(file, original, { mode: 0o664 });
      await chmod(join(root, '.koryphaios'), 0o775);
      await chmod(join(root, '.koryphaios', 'sessions'), 0o775);
      await chmod(sessionDirectory, 0o775);
      await chmod(file, 0o664);

      const entry = await new ContextArchiveService(root).get('session', 'cx_0');

      expect(entry?.content).toBe('existing content remains byte-for-byte intact');
      expect(await readFile(file, 'utf8')).toBe(original);
      expect((await stat(join(root, '.koryphaios'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, '.koryphaios', 'sessions'))).mode & 0o777).toBe(0o700);
      expect((await stat(sessionDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks late writes during and after deletion, but permits rollback before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-erasure-'));
    try {
      const archive = new ContextArchiveService(root);
      archive.beginSessionErasure('session');
      await expect(archive.record('session', 'tool_result', 'late', 'sensitive')).rejects.toThrow(
        /being deleted/,
      );
      archive.cancelSessionErasure('session');
      const id = await archive.record('session', 'tool_result', 'safe', 'stored preview');
      expect((await archive.get('session', id))?.content).toBe('stored preview');
      archive.beginSessionErasure('session');
      archive.completeSessionErasure('session');
      await expect(archive.listRecent('session')).rejects.toThrow(/being deleted/);
      await expect(archive.recordUsage('session', {
        used: 1,
        max: 2,
        contextKnown: true,
        ts: Date.now(),
      })).rejects.toThrow(/being deleted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically migrates legacy 6MiB raw output to a bounded redacted preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-legacy-'));
    try {
      const directory = join(root, '.koryphaios', 'sessions', 'session');
      const file = join(directory, 'context-archive.jsonl');
      await mkdir(directory, { recursive: true });
      const secret = `sk-proj-${'B'.repeat(40)}`;
      const tail = 'LEGACY-RAW-TAIL-MUST-BE-REMOVED';
      const rawContent = `token=${secret}\n${'z'.repeat(6 * 1024 * 1024)}${tail}`;
      await writeFile(
        file,
        `${JSON.stringify({
          id: 'cx_0',
          sessionId: 'session',
          ts: 1,
          kind: 'terminal',
          label: 'legacy terminal',
          content: rawContent,
        })}\n`,
      );

      const archive = new ContextArchiveService(root);
      const migrated = await archive.get('session', 'cx_0');
      const persisted = await readFile(file, 'utf8');

      expect(migrated?.originalByteCount).toBe(Buffer.byteLength(rawContent));
      expect(migrated?.contentSha256).toBe(createHash('sha256').update(rawContent).digest('hex'));
      expect(migrated?.truncated).toBe(true);
      expect(migrated?.redacted).toBe(true);
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain(tail);
      expect(Buffer.byteLength(persisted)).toBeLessThan(10_000);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compacts oversized JSONL deterministically and persists retention metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-retention-'));
    try {
      const directory = join(root, '.koryphaios', 'sessions', 'session');
      const file = join(directory, 'context-archive.jsonl');
      await mkdir(directory, { recursive: true });
      const content = 'r'.repeat(CONTEXT_ARCHIVE_LIMITS.previewBytes - 64);
      const digest = createHash('sha256').update(content).digest('hex');
      const rows = Array.from({ length: 600 }, (_, index) =>
        JSON.stringify({
          id: `cx_${index}`,
          sessionId: 'session',
          ts: index,
          kind: 'tool_result',
          label: `entry ${index}`,
          content,
          originalByteCount: Buffer.byteLength(content),
          contentSha256: digest,
          truncated: false,
          redacted: false,
        }),
      );
      await writeFile(file, `${rows.join('\n')}\n`);

      const archive = new ContextArchiveService(root);
      const recent = await archive.listRecent('session', 1_000);
      const retention = await archive.getRetention('session');
      const after = await readFile(file, 'utf8');
      const restarted = new ContextArchiveService(root);

      expect(Buffer.byteLength(after)).toBeLessThanOrEqual(CONTEXT_ARCHIVE_LIMITS.durableBytes);
      expect(recent.length).toBeLessThan(600);
      expect(recent.at(-1)?.id).toBe('cx_599');
      expect(retention).toMatchObject({
        droppedEntries: 600 - recent.length,
        retainedEntries: recent.length,
        maxEntries: CONTEXT_ARCHIVE_LIMITS.durableEntries,
        maxBytes: CONTEXT_ARCHIVE_LIMITS.durableBytes,
      });
      expect(after.split('\n')[0]).toContain('"type":"retention"');
      expect((await restarted.listRecent('session', 1_000)).map((entry) => entry.id)).toEqual(
        recent.map((entry) => entry.id),
      );
      expect(await restarted.getRetention('session')).toEqual(retention);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
