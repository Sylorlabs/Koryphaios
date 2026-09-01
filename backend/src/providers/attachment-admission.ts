import type { ModelDef } from '@koryphaios/shared';
import type { Provider, ProviderMessage } from './types';
import { getProviderDisplay } from './provider-display';
import { koryLog } from '../logger';

export type ImageInputMode = 'reject' | 'omit';

/**
 * Apply only after an explicit user choice. Stored transcript attachments stay
 * untouched; this transforms the one provider request and leaves a truthful
 * marker anywhere pixels were intentionally withheld.
 */
export function omitImageInputs(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const omitted = message.content.some((block) => block.type === 'image');
    if (!omitted) return message;
    const content = message.content.filter((block) => block.type !== 'image');
    return {
      ...message,
      content: [
        ...content,
        { type: 'text' as const, text: '[Image input omitted by user choice.]' },
      ],
    };
  });
}

/**
 * A screenshot is user input, not decorative UI state. A provider must prove
 * that Koryphaios can pass it as an image before we dispatch the turn; a
 * textual placeholder is not an image transport.
 */
export function imageAttachmentAdmissionError(
  provider: Pick<Provider, 'name' | 'listModels'>,
  modelId: string,
  messages: ReadonlyArray<Pick<ProviderMessage, 'content'>>,
): string | null {
  const hasImage = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
  );
  if (!hasImage) return null;

  let model: ModelDef | undefined;
  try {
    model = provider
      .listModels()
      .find(
        (candidate) =>
          candidate.id === modelId ||
          candidate.apiModelId === modelId ||
          candidate.realModelId === modelId,
      );
  } catch (error: unknown) {
    koryLog.debug(
      { provider: provider.name, error: error instanceof Error ? error.message : String(error) },
      'Could not read image-input capability before provider dispatch',
    );
  }

  if (model?.supportsAttachments === true) return null;
  const providerLabel = getProviderDisplay(provider.name)?.label ?? provider.name;
  const modelLabel = model?.apiModelId ?? modelId;
  return `${providerLabel} model “${modelLabel}” has not reported image-input support. Koryphaios did not send the screenshot rather than silently dropping it; choose a model that reports image support.`;
}
