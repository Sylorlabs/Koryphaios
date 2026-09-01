import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createWorkspaceController } from './workspace-controller.svelte';
import { projectStore } from '$lib/stores/project.svelte';

function snapshotResponse(snapshot: Record<string, unknown> | null, ok = true): Response {
  return new Response(
    JSON.stringify(snapshot ? { ok, data: snapshot } : { ok: false, error: 'nope' }),
    {
      status: ok ? 200 : 400,
    },
  );
}

function makeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceRoot: '/workspace',
    selectedProject: '/workspace/alpha',
    projects: [{ path: '/workspace/alpha', name: 'alpha', modifiedAt: 1 }],
    revision: 'rev-1',
    unavailableWorkspace: null,
    unavailableProject: null,
    seq: 1,
    ...overrides,
  };
}

describe('workspace controller (characterization)', () => {
  beforeEach(() => {
    projectStore.clearWorkspace();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('selectAuthoritativeProject reconciles the snapshot and reports success', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const controller = createWorkspaceController({
      requestSnapshot: async (path, init) => {
        requests.push({ path, init });
        return snapshotResponse(makeSnapshot());
      },
    });

    const selected = await controller.selectAuthoritativeProject('/workspace/alpha');

    expect(selected).toBe(true);
    expect(requests[0]?.path).toBe('/api/workspace/select');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ path: '/workspace/alpha' });
    expect(projectStore.currentPath).toBe('/workspace/alpha');
    expect(projectStore.workspaceRoot).toBe('/workspace');
  });

  test('selectAuthoritativeProject toasts and fails closed on API errors', async () => {
    const controller = createWorkspaceController({
      requestSnapshot: async () => snapshotResponse(null, false),
    });
    const selected = await controller.selectAuthoritativeProject('/gone');
    expect(selected).toBe(false);
    expect(projectStore.currentPath).toBeNull();
  });

  test('reconcile marks unavailable projects, resets the fence, and clears the active session', async () => {
    projectStore.reconcile(makeSnapshot() as never);
    const clearActiveSession = vi.fn();
    const controller = createWorkspaceController({
      requestSnapshot: async () =>
        snapshotResponse(
          makeSnapshot({
            selectedProject: null,
            unavailableProject: '/workspace/alpha',
            seq: 2,
          }),
        ),
      clearActiveSession,
    });

    await controller.refreshWorkspaceNavigation();

    expect(projectStore.currentPath).toBeNull();
    expect(projectStore.unavailablePath).toBe('/workspace/alpha');
    expect(clearActiveSession).toHaveBeenCalled();
    expect(controller.lastReconciledSessionId).toBe('');
  });

  test('refreshWorkspaceNavigation collapses concurrent refreshes into one request', async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    let calls = 0;
    const controller = createWorkspaceController({
      requestSnapshot: async (path) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return snapshotResponse(makeSnapshot());
      },
    });

    const first = controller.refreshWorkspaceNavigation();
    const second = controller.refreshWorkspaceNavigation();
    resolveFirst!(snapshotResponse(makeSnapshot()));
    await Promise.all([first, second]);
    // The in-flight refresh is shared — one snapshot request, both awaiters.
    expect(calls).toBe(1);
  });

  test('restoreFromActiveSession reselects the active session project when the snapshot is empty', async () => {
    const requests: Array<string> = [];
    const controller = createWorkspaceController({
      getActiveSessionWorkingDirectory: () => '/standalone/project',
      requestSnapshot: async (path, init) => {
        requests.push(path);
        if (path === '/api/workspace/select') {
          return snapshotResponse(
            makeSnapshot({
              workspaceRoot: null,
              selectedProject: '/standalone/project',
              projects: [{ path: '/standalone/project', name: 'project', modifiedAt: 1 }],
              seq: 5,
            }),
          );
        }
        return snapshotResponse(
          makeSnapshot({ workspaceRoot: null, selectedProject: null, seq: 4 }),
        );
      },
    });
    await controller.refreshWorkspaceNavigation({ restoreFromActiveSession: true });

    expect(requests).toContain('/api/workspace/select');
    expect(projectStore.currentPath).toBe('/standalone/project');
  });

  test('auto-acknowledges an unavailable project so the broken path does not persist', async () => {
    const requests: Array<string> = [];
    const controller = createWorkspaceController({
      requestSnapshot: async (path, init) => {
        requests.push(path);
        if (path === '/api/workspace/acknowledge-unavailable') {
          return snapshotResponse(
            makeSnapshot({ selectedProject: null, unavailableProject: null, seq: 6 }),
          );
        }
        // First state-of-the-world: the previously selected project is gone.
        return snapshotResponse(
          makeSnapshot({
            selectedProject: null,
            unavailableProject: '/workspace/alpha',
            seq: 5,
          }),
        );
      },
    });

    await controller.refreshWorkspaceNavigation();

    // The broken path is cleared from persistence (relaunch won't re-show it).
    expect(requests).toContain('/api/workspace/acknowledge-unavailable');
    expect(projectStore.unavailablePath).toBeNull();
  });

  test('does not restore a session whose working directory the snapshot flagged as unavailable', async () => {
    const requests: Array<string> = [];
    const controller = createWorkspaceController({
      getActiveSessionWorkingDirectory: () => '/workspace/alpha',
      requestSnapshot: async (path, init) => {
        requests.push(path);
        // The session's working directory is exactly the unavailable path.
        return snapshotResponse(
          makeSnapshot({
            selectedProject: null,
            unavailableProject: '/workspace/alpha',
            seq: 5,
          }),
        );
      },
    });

    await controller.refreshWorkspaceNavigation({ restoreFromActiveSession: true });

    // No select attempt — restoring the broken path would re-trigger the toast.
    expect(requests).not.toContain('/api/workspace/select');
  });
});
