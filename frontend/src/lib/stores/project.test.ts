import { beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectStore, type WorkspaceNavigationSnapshot } from './project.svelte';

function snapshot(
  projects: string[],
  selectedProject: string | null = null,
  unavailable: { workspace?: string | null; project?: string | null } = {},
): WorkspaceNavigationSnapshot {
  return {
    workspaceRoot: '/workspace',
    selectedProject,
    projects: projects.map((path, index) => ({
      path,
      name: path.split('/').at(-1) ?? path,
      modifiedAt: index,
    })),
    revision: projects.join('|'),
    unavailableWorkspace: unavailable.workspace ?? null,
    unavailableProject: unavailable.project ?? null,
  };
}

beforeEach(() => projectStore.clearWorkspace());

describe('projectStore filesystem reconciliation', () => {
  test('replaces folder snapshots instead of accumulating stale entries', () => {
    projectStore.reconcile(snapshot(['/workspace/alpha', '/workspace/beta'], '/workspace/alpha'));
    const result = projectStore.reconcile(
      snapshot(['/workspace/beta', '/workspace/gamma'], null, {
        project: '/workspace/alpha',
      }),
    );

    expect(projectStore.openProjects).toEqual(['/workspace/beta', '/workspace/gamma']);
    expect(projectStore.currentPath).toBeNull();
    expect(result.projectBecameUnavailable).toBe('/workspace/alpha');
  });

  test('keeps unavailable project requests fail-closed until a current folder is selected', () => {
    projectStore.reconcile(snapshot(['/workspace/alpha'], '/workspace/alpha'));
    expect(projectStore.markUnavailable('/workspace/alpha')).toBe(true);
    expect(projectStore.currentPath).toBeNull();
    expect(projectStore.requestPath).toBe('/workspace/alpha');

    projectStore.reconcile(snapshot(['/workspace/beta'], '/workspace/beta'));
    expect(projectStore.requestPath).toBe('/workspace/beta');
    expect(projectStore.unavailablePath).toBeNull();
  });

  test('reports a missing folder once and clears it when the backend acknowledges it', () => {
    projectStore.reconcile(snapshot(['/workspace/alpha'], '/workspace/alpha'));
    const unavailable = snapshot(['/workspace/beta'], null, {
      project: '/workspace/alpha',
    });

    expect(projectStore.reconcile(unavailable).projectBecameUnavailable).toBe('/workspace/alpha');
    expect(projectStore.reconcile(unavailable).projectBecameUnavailable).toBeNull();
    expect(projectStore.unavailablePath).toBe('/workspace/alpha');

    projectStore.reconcile(snapshot(['/workspace/beta']));
    expect(projectStore.unavailablePath).toBeNull();
    expect(projectStore.requestPath).toBeNull();
  });

  test('does not persist project, workspace, or active-session navigation in localStorage', () => {
    const frontendRoot = resolve(import.meta.dirname, '../../..');
    const projectSource = readFileSync(
      resolve(frontendRoot, 'src/lib/stores/project.svelte.ts'),
      'utf8',
    );
    const apiSource = readFileSync(resolve(frontendRoot, 'src/lib/api.svelte.ts'), 'utf8');
    const sessionsSource = readFileSync(
      resolve(frontendRoot, 'src/lib/stores/sessions.svelte.ts'),
      'utf8',
    );
    const projectManagerSource = readFileSync(
      resolve(frontendRoot, 'src/lib/utils/projectManager.ts'),
      'utf8',
    );

    expect(projectSource).not.toContain('localStorage');
    expect(apiSource).not.toContain('koryphaios-current-project');
    expect(sessionsSource).not.toContain('koryphaios-last-session');
    expect(projectManagerSource).not.toContain('localStorage');
    expect(projectManagerSource).not.toContain('koryphaios-recent-projects');
  });
});
