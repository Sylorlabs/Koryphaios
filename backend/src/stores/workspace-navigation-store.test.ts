import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceNavigationStore } from './workspace-navigation-store';

const roots: string[] = [];

/** Resolve symlinks so comparisons match the canonical paths the store persists
 *  (macOS resolves /var → /private/var via realpathSync inside the store). */
function canonicalRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function createStore(): { database: Database; store: WorkspaceNavigationStore } {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE workspace_navigation (
      id TEXT PRIMARY KEY,
      workspace_root TEXT,
      selected_project TEXT,
      unavailable_workspace TEXT,
      unavailable_project TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  return { database, store: new WorkspaceNavigationStore(database) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceNavigationStore', () => {
  test('rebuilds workspace children from the current filesystem on every snapshot', () => {
    const rawRoot = join(tmpdir(), `kory-workspace-${crypto.randomUUID()}`);
    roots.push(rawRoot);
    mkdirSync(join(rawRoot, 'alpha'), { recursive: true });
    const root = canonicalRoot(rawRoot);
    const { database, store } = createStore();

    expect(store.openWorkspace(root).projects.map((project) => project.name)).toEqual(['alpha']);

    renameSync(join(root, 'alpha'), join(root, 'beta'));
    const refreshed = store.snapshot();
    expect(refreshed.projects.map((project) => project.name)).toEqual(['beta']);
    expect(refreshed.workspaceRoot).toBe(root);
    database.close();
  });

  test('clears a workspace that disappears between application refreshes', () => {
    const rawRoot = join(tmpdir(), `kory-workspace-${crypto.randomUUID()}`);
    roots.push(rawRoot);
    mkdirSync(join(rawRoot, 'project'), { recursive: true });
    const root = canonicalRoot(rawRoot);
    const { database, store } = createStore();
    store.openWorkspace(root);

    rmSync(root, { recursive: true });
    const refreshed = store.snapshot();
    expect(refreshed.workspaceRoot).toBeNull();
    expect(refreshed.unavailableWorkspace).toBe(root);
    expect(refreshed.projects).toEqual([]);
    database.close();
  });

  test('clears a deleted selection without redirecting it to another project', () => {
    const rawRoot = join(tmpdir(), `kory-workspace-${crypto.randomUUID()}`);
    roots.push(rawRoot);
    mkdirSync(join(rawRoot, 'selected'), { recursive: true });
    mkdirSync(join(rawRoot, '.koryphaios'), { recursive: true });
    writeFileSync(join(rawRoot, '.koryphaios', 'workspace.json'), '{}');
    const root = canonicalRoot(rawRoot);
    const selected = join(root, 'selected');
    const { database, store } = createStore();

    store.openWorkspace(root);
    expect(store.selectProject(selected).selectedProject).toBe(selected);
    rmSync(selected, { recursive: true });

    const refreshed = store.snapshot();
    expect(refreshed.selectedProject).toBeNull();
    expect(refreshed.unavailableProject).toBe(selected);
    expect(refreshed.projects).toEqual([]);
    expect(new WorkspaceNavigationStore(database).snapshot().unavailableProject).toBe(selected);
    expect(store.acknowledgeUnavailable().unavailableProject).toBeNull();
    database.close();
  });

  test('persists only root and selection while a new store sees fresh children', () => {
    const rawRoot = join(tmpdir(), `kory-workspace-${crypto.randomUUID()}`);
    roots.push(rawRoot);
    mkdirSync(join(rawRoot, 'project'), { recursive: true });
    const root = canonicalRoot(rawRoot);
    const project = join(root, 'project');
    const { database, store } = createStore();
    store.openWorkspace(root);
    store.selectProject(project);

    mkdirSync(join(root, 'new-folder'));
    const restarted = new WorkspaceNavigationStore(database).snapshot();
    expect(restarted.selectedProject).toBe(project);
    expect(restarted.projects.map((entry) => entry.name)).toEqual(['new-folder', 'project']);
    database.close();
  });
});
