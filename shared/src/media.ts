/** Chat media stays in the existing file attachment envelope for durable drafts/history. */
export const MAX_CHAT_MEDIA_BYTES = 15 * 1024 * 1024;

const MEDIA_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
};

export function chatMediaMimeType(name: string, mimeType?: string): string | undefined {
  const mime = mimeType?.split(';')[0].trim().toLowerCase();
  if (mime && /^(image|audio|video)\/[a-z0-9.+-]+$/.test(mime)) return mime;
  return MEDIA_MIME_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
}

export function chatMediaKind(mimeType?: string): 'image' | 'audio' | 'video' | undefined {
  const kind = mimeType?.split('/')[0];
  return kind === 'image' || kind === 'audio' || kind === 'video' ? kind : undefined;
}
