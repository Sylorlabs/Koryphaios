import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEMORY_SETTINGS, loadMemorySettings } from './unified-memory';

describe('memory-settings budget migration', () => {
  it('defaults to the loosened 8000-token budget', () => {
    expect(DEFAULT_MEMORY_SETTINGS.maxContextTokens).toBe(8000);
  });

  it('bumps a persisted stale 2000-token budget without touching customized values', () => {
    const root = join(tmpdir(), `kory-memory-migration-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, '.koryphaios'), { recursive: true });
    const settingsPath = join(root, '.koryphaios', 'memory-settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({ maxContextTokens: 2000 }));
      expect(loadMemorySettings(root).maxContextTokens).toBe(8000);
      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        maxContextTokens: number;
      };
      expect(persisted.maxContextTokens).toBe(8000);

      writeFileSync(settingsPath, JSON.stringify({ maxContextTokens: 4000 }));
      expect(loadMemorySettings(root).maxContextTokens).toBe(4000);
      const kept = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        maxContextTokens: number;
      };
      expect(kept.maxContextTokens).toBe(4000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
