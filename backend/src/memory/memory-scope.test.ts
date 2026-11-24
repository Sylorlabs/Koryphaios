import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getMemoryScope, registerWorkspaceRoot } from './unified-memory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('reports inherited workspace memory and preserves an existing project-owned memory root', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'knowledge-scope-'));
  roots.push(workspace);
  const project = join(workspace, 'projects', 'example');
  mkdirSync(project, { recursive: true });
  registerWorkspaceRoot(workspace);
  const inherited = getMemoryScope(project);
  expect(inherited).toEqual({ kind: 'workspace', name: basename(workspace) });
  expect(inherited).not.toHaveProperty('path');

  mkdirSync(join(project, '.koryphaios'));
  registerWorkspaceRoot(workspace); // Invalidate the resolver cache after the fixture changes.
  expect(getMemoryScope(project)).toEqual({ kind: 'project', name: 'example' });
});
