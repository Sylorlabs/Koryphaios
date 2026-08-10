import type { NoteAttachment } from '@koryphaios/shared';

/** DOMPurify's normal safe URI set plus object URLs created by the attachment
 * registry. Other executable or unknown schemes remain rejected. */
export const NOTE_PREVIEW_URI_PATTERN =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

export interface NoteAttachmentReference {
  raw: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  embedded: boolean;
}

export function noteAttachmentReferenceStart(source: string): number {
  const embedded = source.indexOf('![[');
  const linked = source.indexOf('[[');
  if (embedded < 0) return linked;
  if (linked < 0) return embedded;
  return Math.min(embedded, linked);
}

/** Exact attachment filenames take precedence over same-titled note
 * transclusions. References that do not match an attachment are deliberately
 * left for the wikilink parser. */
export function tokenizeNoteAttachmentReference(
  source: string,
  attachments: NoteAttachment[],
): NoteAttachmentReference | null {
  const match = /^(!?)\[\[([^\]|#]+?)\]\]/.exec(source);
  if (!match) return null;
  const filename = match[2].trim();
  const attachment = attachments.find((candidate) => candidate.filename === filename);
  if (!attachment) return null;
  return {
    raw: match[0],
    attachmentId: attachment.id,
    filename,
    mimeType: attachment.mimeType,
    embedded: match[1] === '!',
  };
}

export function isExactAttachmentFilename(
  reference: string,
  attachments: NoteAttachment[],
): boolean {
  return attachments.some((attachment) => attachment.filename === reference.trim());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderNoteAttachmentReference(
  token: NoteAttachmentReference,
  objectUrl?: string,
): string {
  const safeName = escapeHtml(token.filename);
  if (!objectUrl) {
    return `<span class="attachment-unavailable">${safeName} (unavailable)</span>`;
  }
  const safeUrl = escapeHtml(objectUrl);
  if (token.embedded && token.mimeType.startsWith('image/')) {
    return `<img class="note-attachment-embed" src="${safeUrl}" alt="${safeName}">`;
  }
  return `<a class="note-attachment-download" href="${safeUrl}" download="${safeName}">${safeName}</a>`;
}
