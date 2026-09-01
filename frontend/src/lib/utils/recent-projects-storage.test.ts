import { beforeEach, describe, expect, test } from 'vitest';
import { loadRecentProjectBriefs, saveRecentProjectBriefs } from './recent-projects-storage';

describe('recent project brief storage', () => {
  beforeEach(() => localStorage.clear());

  test('restores a text brief without trusting a stored filesystem path', () => {
    saveRecentProjectBriefs([
      {
        id: 'brief-1',
        title: 'Imported brief',
        content: 'Ship a local-first release.',
        source: 'file',
        fileName: 'brief.md',
        path: '/private/project',
        updatedAt: 42,
      },
    ]);

    expect(loadRecentProjectBriefs()).toEqual([
      {
        id: 'brief-1',
        title: 'Imported brief',
        content: 'Ship a local-first release.',
        source: 'file',
        fileName: 'brief.md',
        updatedAt: 42,
      },
    ]);
    expect(localStorage.getItem('koryphaios-recent-project-briefs-v1')).not.toContain(
      '/private/project',
    );
  });
});
