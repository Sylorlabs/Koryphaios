import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));

import { memoryStore, DEFAULT_SETTINGS } from './memory.svelte';
import { projectStore } from './project.svelte';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function memoryFile(content: string) {
  return {
    path: 'memory/project.md',
    content,
    exists: true,
    lastModified: 1,
    size: content.length,
    revision: `revision:${content}`,
  };
}

beforeEach(() => {
  projectStore.setProject('/test-memory-project');
  memoryStore.beginProjectTransition();
  mocks.apiFetch.mockReset();
});

afterEach(() => {
  projectStore.setProject(null);
  memoryStore.beginProjectTransition();
});

describe('Memory source loading', () => {
  it('loads only the visible project source, settings, and document index initially', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path.endsWith('/api/memory/project')) {
        return jsonResponse({ ok: true, data: memoryFile('project') });
      }
      if (path.endsWith('/api/memory/settings')) {
        return jsonResponse({ ok: true, data: DEFAULT_SETTINGS });
      }
      if (path.endsWith('/api/memory/documents')) {
        return jsonResponse({ ok: true, data: [] });
      }
      throw new Error(`Unexpected eager request: ${path}`);
    });

    await memoryStore.loadAllMemory('session-that-must-remain-lazy');

    const paths = mocks.apiFetch.mock.calls.map(
      ([url]) => new URL(String(url), window.location.origin).pathname,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/memory/project',
        '/api/memory/settings',
        '/api/memory/documents',
      ]),
    );
    expect(paths).toHaveLength(3);
    expect(paths).not.toContain('/api/memory/universal');
    expect(paths).not.toContain('/api/memory/rules');
    expect(paths).not.toContain('/api/memory/sessions/session-that-must-remain-lazy');
  });

  it('keeps failures independent for each Memory source', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      return jsonResponse(
        { ok: false, error: path.endsWith('/rules') ? 'Rules unavailable' : 'Project unavailable' },
        503,
      );
    });

    await Promise.all([memoryStore.loadProjectMemory(), memoryStore.loadRules()]);

    expect(memoryStore.errorFor('project')).toBe('Project unavailable');
    expect(memoryStore.errorFor('rules')).toBe('Rules unavailable');
  });

  it('ignores a stale response after a newer request for the same source wins', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    mocks.apiFetch
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: memoryFile('newest') }));

    const oldLoad = memoryStore.loadProjectMemory();
    const newLoad = memoryStore.loadProjectMemory();
    await newLoad;
    resolveOld(jsonResponse({ ok: true, data: memoryFile('stale') }));
    await oldLoad;

    expect(memoryStore.project?.content).toBe('newest');
  });

  it('does not reuse a request identity for a global source after a project transition', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    mocks.apiFetch
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: memoryFile('new universal') }));

    const oldLoad = memoryStore.loadUniversalMemory();
    projectStore.setProject('/test-memory-project-b');
    memoryStore.beginProjectTransition();
    await memoryStore.loadUniversalMemory();
    resolveOld(jsonResponse({ ok: true, data: memoryFile('stale universal') }));
    await oldLoad;

    expect(memoryStore.universal?.content).toBe('new universal');
  });
});
