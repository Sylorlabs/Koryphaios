import { describe, expect, it } from 'vitest';
import type { NoteAttachment } from '@koryphaios/shared';
import {
  isExactAttachmentFilename,
  NOTE_PREVIEW_URI_PATTERN,
  noteAttachmentReferenceStart,
  renderNoteAttachmentReference,
  tokenizeNoteAttachmentReference,
} from './note-attachment-references';

const image: NoteAttachment = {
  id: 'attachment-image',
  noteId: 'note-one',
  filename: 'budget-cuts.png',
  mimeType: 'image/png',
  size: 12,
  createdAt: new Date(0),
};

describe('note attachment references', () => {
  it('recognizes the leading bang and gives an exact attachment precedence', () => {
    expect(noteAttachmentReferenceStart('![[budget-cuts.png]]')).toBe(0);
    expect(tokenizeNoteAttachmentReference('![[budget-cuts.png]]', [image])).toMatchObject({
      embedded: true,
      attachmentId: image.id,
      filename: image.filename,
    });
    expect(isExactAttachmentFilename('budget-cuts.png', [image])).toBe(true);
  });

  it('leaves unmatched references for the normal note wikilink parser', () => {
    expect(tokenizeNoteAttachmentReference('![[Budget Cuts]]', [image])).toBeNull();
  });

  it('renders controlled object URLs as embeds or downloads and escapes filenames', () => {
    const token = tokenizeNoteAttachmentReference('![[budget-cuts.png]]', [image])!;
    expect(renderNoteAttachmentReference(token, 'blob:kory/image')).toContain(
      'class="note-attachment-embed"',
    );
    expect(NOTE_PREVIEW_URI_PATTERN.test('blob:kory/image')).toBe(true);
    expect(NOTE_PREVIEW_URI_PATTERN.test('javascript:alert(1)')).toBe(false);
    expect(
      renderNoteAttachmentReference({ ...token, embedded: false }, 'blob:kory/image'),
    ).toContain('download="budget-cuts.png"');
    expect(renderNoteAttachmentReference({ ...token, filename: '<unsafe>.png' })).toContain(
      '&lt;unsafe&gt;.png',
    );
  });
});
