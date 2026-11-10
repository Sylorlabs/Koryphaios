import { describe, expect, test } from 'bun:test';
import { nonGitAdapter } from './source-control-adapters';
import { isMutableRoot } from '@koryphaios/shared';

describe('source-control adapter contracts', () => {
  test('non-Git roots report explicit unavailable state instead of pretending to be Git', async () => {
    const adapter = nonGitAdapter('mercurial');
    const root = {
      id: 'root-1',
      projectId: 'project-1',
      path: '/tmp/project',
      label: 'Project',
      access: 'read-write' as const,
      sourceControl: 'mercurial' as const,
    };
    expect(await adapter.detect(root)).toBe(false);
    await expect(adapter.inspect(root)).resolves.toMatchObject({
      kind: 'mercurial',
      available: false,
      dirty: false,
    });
    await expect(adapter.status(root)).rejects.toThrow('not configured');
  });

  test('read-only and excluded root allocations are not mutable', () => {
    const root = {
      id: 'root-1',
      projectId: 'project-1',
      path: '/tmp/project',
      label: 'Project',
      sourceControl: 'git' as const,
    };
    expect(isMutableRoot({ ...root, access: 'read-only' })).toBe(false);
    expect(isMutableRoot({ ...root, access: 'excluded' })).toBe(false);
    expect(isMutableRoot({ ...root, access: 'publishable' })).toBe(true);
  });
});
