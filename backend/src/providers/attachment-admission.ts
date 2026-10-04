import type { ModelDef } from '@koryphaios/shared';
import type { Provider, ProviderMessage, StreamRequest } from './types';
import { getProviderDisplay } from './provider-display';
import { koryLog } from '../logger';

export type ImageInputMode = 'reject' | 'omit' | 'allow';

export function userConfirmedImageInput(
  provider: Pick<Provider, 'name'>,
  request: Pick<StreamRequest, 'model' | 'imageInputOverride'>,
): boolean {
  return (
    request.imageInputOverride?.provider === provider.name &&
    request.imageInputOverride.model === request.model
  );
}

export function imageAttachmentTransportError(
  provider: Pick<Provider, 'name' | 'imageInputTransport'>,
  messages: ReadonlyArray<Pick<ProviderMessage, 'content'>>,
): string | null {
  if (
    provider.imageInputTransport !== 'none' ||
    !messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
    )
  )
    return null;
  const label = getProviderDisplay(provider.name)?.label ?? provider.name;
  return `${label}'s current integration cannot deliver image input, even if the model supports vision. Choose another provider or continue without images.`;
}

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
  provider: Pick<Provider, 'name' | 'listModels' | 'imageInputTransport'>,
  modelId: string,
  messages: ReadonlyArray<Pick<ProviderMessage, 'content'>>,
  imageInputMode: ImageInputMode = 'reject',
): string | null {
  const hasImage = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === 'image'),
  );
  if (!hasImage) return null;
  const transportError = imageAttachmentTransportError(provider, messages);
  if (transportError) return transportError;
  // This is an explicit user correction to capability metadata. Keep the image
  // blocks intact and let the selected provider handle them; never reinterpret
  // an unknown capability or an omission preference as permission to send.
  if (imageInputMode === 'allow') return null;

  let model: ModelDef | undefined;
  try {
    model = provider
      .listModels()
      .find(
        (candidate) =>
          candidate.id === modelId ||
          candidate.apiModelId === modelId ||
          candidate.realModelId === modelId ||
          candidate.aliases?.includes(modelId) ||
          Object.values(candidate.reasoningVariants ?? {}).includes(modelId),
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
