import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const isolatedDirectory = process.env.DATABASE_URL
  ? undefined
  : mkdtempSync(join(tmpdir(), 'kory-notes-link-scope-'));
process.env.DATABASE_URL ??= `sqlite:${join(isolatedDirectory!, 'notes-link-scope.sqlite')}`;

const { getDb, initDb } = await import('../../db');
const { getGraphData, invalidateNotesCache } = await import('../notes-service');

afterAll(() => {
  if (isolatedDirectory) rmSync(isolatedDirectory, { recursive: true, force: true });
});

describe('project-scoped graph link limits', () => {
  test('an unrelated project cannot consume the 50k link envelope', async () => {
    await initDb();
    const raw = getDb();
    const noisyProject = '/test/noisy-project';
    const selectedProject = '/test/selected-project';
    const now = Math.floor(Date.now() / 1000);
    const insertNote = raw.prepare(`
      INSERT INTO notes (
        id, title, content, folder_path, tags, pinned, include_in_context,
        format, project_root, revision, user_id, created_at, updated_at
      ) VALUES (?, ?, '', '/', '[]', 0, 0, 'markdown', ?, 1, NULL, ?, ?)
    `);
    const insertLink = raw.prepare(
      'INSERT INTO note_links (from_note_id, to_note_id) VALUES (?, ?)',
    );

    raw.exec('BEGIN IMMEDIATE');
    try {
      const noisyIds = Array.from({ length: 225 }, (_, index) => `noisy-${index}`);
      for (const [index, id] of noisyIds.entries()) {
        insertNote.run(id, `Noisy ${index}`, noisyProject, now, now);
      }
      // 225 * 224 = 50,400 directed edges, deliberately above the graph cap.
      for (const from of noisyIds) {
        for (const to of noisyIds) {
          if (from !== to) insertLink.run(from, to);
        }
      }
      insertNote.run('selected-from', 'Selected from', selectedProject, now, now);
      insertNote.run('selected-to', 'Selected to', selectedProject, now, now);
      insertLink.run('selected-from', 'selected-to');
      raw.exec('COMMIT');
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }

    invalidateNotesCache();
    const graph = await getGraphData(selectedProject);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['selected-from', 'selected-to']);
    expect(graph.edges).toEqual([{ from: 'selected-from', to: 'selected-to' }]);
    expect(graph.linksTruncated).not.toBe(true);
  });
});
