import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextArchiveService } from './context-archive';

describe('ContextArchiveService usage provenance', () => {
  test('persists the exact provider and model that reported usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-context-usage-'));
    try {
      const first = new ContextArchiveService(root);
      await first.recordUsage('session', {
        used: 91_337,
        max: 200_000,
        contextKnown: true,
        model: 'grok-composer-2.5-fast',
        provider: 'grok',
        activeMessageId: 'assistant-final',
        contextRevision: 3,
        breakdown: { system: 3_000, memory: 4_000, tools: 0, chat: 7_000 },
        ts: 123,
      });

      const reloaded = await new ContextArchiveService(root).getLastUsage('session');

      expect(reloaded).toEqual({
        used: 91_337,
        max: 200_000,
        contextKnown: true,
        model: 'grok-composer-2.5-fast',
        provider: 'grok',
        activeMessageId: 'assistant-final',
        contextRevision: 3,
        breakdown: { system: 3_000, memory: 4_000, tools: 0, chat: 7_000 },
        ts: 123,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
