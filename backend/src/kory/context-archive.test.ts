import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextArchiveService } from './context-archive';

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
});
