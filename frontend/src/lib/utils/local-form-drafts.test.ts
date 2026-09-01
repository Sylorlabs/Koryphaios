import { beforeEach, describe, expect, test } from 'vitest';
import { loadLocalFormDraft, saveLocalFormDraft } from './local-form-drafts';

describe('local form drafts', () => {
  beforeEach(() => localStorage.clear());

  test('keeps workflow and goal form drafts isolated by scope', () => {
    saveLocalFormDraft('workflow', 'session-a', { task: 'Inspect persistence' });
    saveLocalFormDraft('goal-composer', 'session-a', { objective: 'Finish the audit' });

    expect(loadLocalFormDraft('workflow', 'session-a')).toEqual({ task: 'Inspect persistence' });
    expect(loadLocalFormDraft('workflow', 'session-b')).toEqual({});
    expect(loadLocalFormDraft('goal-composer', 'session-a')).toEqual({
      objective: 'Finish the audit',
    });
  });
});
