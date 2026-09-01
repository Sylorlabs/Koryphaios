import { describe, expect, test } from 'bun:test';
import type { ModelDef } from '@koryphaios/shared';
import {
  imageAttachmentAdmissionError,
  omitImageInputs,
} from '../../providers/attachment-admission';

function providerWith(model: Partial<ModelDef>) {
  return {
    name: 'codex' as const,
    listModels: () =>
      [
        {
          id: 'model-id',
          name: 'Model',
          provider: 'codex',
          contextWindow: 0,
          maxOutputTokens: 0,
          costPerMInputTokens: 0,
          costPerMOutputTokens: 0,
          canReason: false,
          supportsStreaming: true,
          supportsAttachments: false,
          ...model,
        },
      ] as ModelDef[],
  };
}

describe('provider image attachment admission', () => {
  const screenshot = [
    {
      content: [
        { type: 'text' as const, text: 'Inspect this.' },
        { type: 'image' as const, imageData: 'ZmFrZQ==', imageMimeType: 'image/png' },
      ],
    },
  ];

  test('allows a provider only when its selected model reports native image support', () => {
    expect(
      imageAttachmentAdmissionError(
        providerWith({ supportsAttachments: true }),
        'model-id',
        screenshot,
      ),
    ).toBeNull();
  });

  test('fails closed instead of silently flattening a screenshot for an unsupported model', () => {
    expect(
      imageAttachmentAdmissionError(
        providerWith({ supportsAttachments: false, apiModelId: 'actual-model' }),
        'model-id',
        screenshot,
      ),
    ).toContain('did not send the screenshot rather than silently dropping it');
  });

  test('does not reject ordinary text turns when model capability is unknown', () => {
    expect(
      imageAttachmentAdmissionError(providerWith({}), 'model-id', [
        { content: [{ type: 'text', text: 'ordinary text' }] },
      ]),
    ).toBeNull();
  });

  test('explicit omission strips historical image blocks but preserves transcript text', () => {
    const omitted = omitImageInputs([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Earlier screenshot' },
          { type: 'image', imageData: 'ZmFrZQ==', imageMimeType: 'image/png' },
        ],
      },
      { role: 'user', content: 'Current text-only turn' },
    ]);
    expect(omitted[0]?.content).toEqual([
      { type: 'text', text: 'Earlier screenshot' },
      { type: 'text', text: '[Image input omitted by user choice.]' },
    ]);
    expect(omitted[1]?.content).toBe('Current text-only turn');
    expect(imageAttachmentAdmissionError(providerWith({}), 'model-id', omitted)).toBeNull();
  });
});
