import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
  type ComposerDraftAttachment,
} from './composer-drafts';

describe('composer draft recovery', () => {
  beforeEach(() => localStorage.clear());

  test('recovers text and bounded attachments per session', () => {
    const attachments: ComposerDraftAttachment[] = [
      { type: 'file', name: 'brief.txt', mimeType: 'text/plain', data: 'aGVsbG8=' },
    ];
    expect(saveComposerDraft('session-a', 'Keep this', attachments).persisted).toBe(true);

    expect(loadComposerDraft('session-a')).toEqual({
      text: 'Keep this',
      attachments,
      omittedAttachmentNames: [],
    });
    expect(loadComposerDraft('session-b').text).toBe('');
  });

  test('does not silently claim that oversized attachments are recoverable', () => {
    const result = saveComposerDraft('session-a', 'Keep the prompt', [
      { type: 'file', name: 'large.log', data: 'x'.repeat(160_001) },
    ]);
    expect(result.omittedAttachmentNames).toEqual(['large.log']);
    expect(loadComposerDraft('session-a')).toEqual({
      text: 'Keep the prompt',
      attachments: [],
      omittedAttachmentNames: ['large.log'],
    });
  });

  test('removes a sent or discarded draft', () => {
    saveComposerDraft('session-a', 'Send me', []);
    clearComposerDraft('session-a');
    expect(loadComposerDraft('session-a')).toEqual({
      text: '',
      attachments: [],
      omittedAttachmentNames: [],
    });
  });
});
