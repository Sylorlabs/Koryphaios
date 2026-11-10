import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SmartContextDetector } from './smart-context';

describe('SmartContextDetector file freshness', () => {
  let root: string;
  let detector: SmartContextDetector;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-smart-context-'));
    detector = new SmartContextDetector();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('removes deleted cached paths while preserving valid files', async () => {
    writeFileSync(join(root, 'deleted.ts'), 'const deleted = true;');
    writeFileSync(join(root, 'valid.ts'), 'const valid = true;');
    const hints = { openFiles: ['deleted.ts', 'valid.ts'] };

    const initial = await detector.getRelevantContext('inspect files', root, hints);
    expect(initial.map((file) => file.path)).toEqual([
      join(root, 'deleted.ts'),
      join(root, 'valid.ts'),
    ]);

    unlinkSync(join(root, 'deleted.ts'));

    const refreshed = await detector.getRelevantContext('inspect files', root, hints);
    expect(refreshed.map((file) => file.path)).toEqual([join(root, 'valid.ts')]);
    expect(refreshed[0]?.content).toContain('const valid = true;');
  });

  test('does not retain a renamed path and accepts the new path', async () => {
    writeFileSync(join(root, 'before.ts'), 'const before = true;');

    const initial = await detector.getRelevantContext('inspect files', root, {
      openFiles: ['before.ts'],
    });
    expect(initial.map((file) => file.path)).toEqual([join(root, 'before.ts')]);

    renameSync(join(root, 'before.ts'), join(root, 'after.ts'));

    const oldHints = await detector.getRelevantContext('inspect files', root, {
      openFiles: ['before.ts'],
    });
    expect(oldHints).toEqual([]);

    const newHints = await detector.getRelevantContext('inspect files', root, {
      openFiles: ['after.ts'],
    });
    expect(newHints.map((file) => file.path)).toEqual([join(root, 'after.ts')]);
    expect(newHints[0]?.content).toContain('const before = true;');
  });

  test('never exposes a path that did not exist during collection', async () => {
    const result = await detector.getRelevantContext('inspect files', root, {
      openFiles: ['missing.ts'],
      changedFiles: ['also-missing.ts'],
    });

    expect(result).toEqual([]);
  });
});
