import { chatMediaKind, chatMediaMimeType, MAX_CHAT_MEDIA_BYTES } from '@koryphaios/shared';
import type { Provider, ProviderContentBlock, ProviderMessage } from './types';

export function attachmentInputBlocks(
  attachments: readonly { type: string; data: string; name: string; mimeType?: string }[] = [],
): ProviderContentBlock[] {
  return attachments.flatMap((attachment): ProviderContentBlock[] => {
    const mime = chatMediaMimeType(attachment.name, attachment.mimeType);
    const kind = attachment.type === 'image' ? 'image' : chatMediaKind(mime);
    if (kind === 'image') {
      return [{ type: 'image', imageData: attachment.data, imageMimeType: mime ?? 'image/png' }];
    }
    if (kind === 'audio' || kind === 'video') {
      return [{ type: kind, mediaData: attachment.data, mediaMimeType: mime }];
    }
    return [];
  });
}

/** Run before dispatch: an adapter must never silently flatten binary media. */
export function mediaInputAdmissionError(
  provider: Pick<Provider, 'name' | 'mediaInputKinds'>,
  messages: ReadonlyArray<Pick<ProviderMessage, 'content'>>,
): string | null {
  let totalBytes = 0;
  let hasMedia = false;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image') {
        totalBytes += Math.ceil(((block.imageData?.length ?? 0) * 3) / 4);
        continue;
      }
      if (block.type !== 'audio' && block.type !== 'video') continue;
      hasMedia = true;
      if (!provider.mediaInputKinds?.includes(block.type)) {
        return `${provider.name}'s current integration cannot deliver ${block.type} input. Choose Google / AI Studio / Vertex AI with a Gemini model for audio or video analysis, or transcribe audio with Settings → Voice. The media was not sent.`;
      }
      if (!block.mediaData?.trim() || chatMediaKind(block.mediaMimeType) !== block.type) {
        return `The ${block.type} attachment is empty or has an invalid media type.`;
      }
      totalBytes += Math.ceil((block.mediaData.length * 3) / 4);
    }
  }
  return hasMedia && totalBytes > MAX_CHAT_MEDIA_BYTES
    ? 'Inline chat media exceeds 15 MB across this conversation. Use smaller clips or start a new chat.'
    : null;
}
