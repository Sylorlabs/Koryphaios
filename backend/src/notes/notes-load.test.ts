// Load test: the memory graph and folder tree must stay responsive on
// pathological note tables (the notes table previously held 134K seed rows
// and the graph op stalled the event loop). Seeds 50k notes and asserts the
// safety caps, truncation reporting, and a wall-clock budget.

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedRoot = mkdtempSync(join(tmpdir(), 'kory-notes-load-'));
process.env.KORYPHAIOS_DATA_DIR = isolatedRoot;
process.env.DATABASE_URL = `sqlite:${join(isolatedRoot, 'notes-load.sqlite')}`;

const { initDb, db } = await import('../db');
const { expect, beforeAll, afterAll, describe, test } = await import('bun:test');
const { notes } = await import('../db/schema');
const { getGraphData, getFolderTree } = await import('./notes-service');

beforeAll(async () => {
  await initDb();
});

// NOTE: no rmSync cleanup — the shared DB singleton holds this directory open
// (WAL files), and Bun runs all test files in one process. OS tmp cleans up.

describe('notes graph load safety', () => {
  test(
    'caps the graph at 5000 nodes with truncation metadata on a 50k-note table',
    async () => {
      const TOTAL = 50_000;
      const rows = Array.from({ length: TOTAL }, (_, index) => ({
        id: `load-note-${index}`,
        title: `Load note ${index}`,
        content: index % 10 === 0 ? `Links to [[load note ${index + 1}]]` : 'Body without links.',
        folderPath: `/load/folder-${index % 50}`,
        tags: '[]',
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await db.insert(notes).values(rows.slice(i, i + 500));
      }

      const startedAt = Date.now();
      const graph = await getGraphData();
      const elapsed = Date.now() - startedAt;

      // The graph is capped and reports the truncation honestly.
      expect(graph.nodes.length).toBeLessThanOrEqual(5000);
      expect(graph.truncated).toBe(true);
      expect(graph.total).toBe(TOTAL);
      // Budget: the whole op must stay far under the request timeouts.
      expect(elapsed).toBeLessThan(5_000);

      const tree = await getFolderTree();
      expect(tree.length).toBeGreaterThan(0);
      const loadFolder = tree.find((node) => node.name === 'load');
      expect(loadFolder?.children.length).toBe(50);
      for (const child of loadFolder?.children ?? []) {
        expect(child.noteCount).toBe(1000);
      }
    },
    { timeout: 120_000 },
  );

  test(
    'keeps event-loop lag bounded while building the graph',
    async () => {
      let maxLagMs = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const start = Date.now();
          await new Promise((resolve) => setImmediate(resolve));
          maxLagMs = Math.max(maxLagMs, Date.now() - start);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();

      const graph = await getGraphData();
      sampling = false;
      await sampler;

      expect(graph.truncated).toBe(true);
      // A single synchronous op must not stall the loop for seconds.
      expect(maxLagMs).toBeLessThan(2_000);
    },
    { timeout: 120_000 },
  );
});
