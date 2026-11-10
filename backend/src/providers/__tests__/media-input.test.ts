import { describe, expect, test } from 'bun:test';
import { attachmentInputBlocks, mediaInputAdmissionError } from '../media-input';
import { ProviderRegistry } from '../registry';
import type { Provider, ProviderEvent, ProviderMessage } from '../types';

const attachments = [
  { type: 'image', name: 'photo.jpg', data: 'cGhvdG8=' },
  { type: 'file', name: 'clip.mp4', data: 'Y2xpcA==' },
  { type: 'file', name: 'speech.mp3', data: 'c3BlZWNo' },
];
const messages: ProviderMessage[] = [{ role: 'user', content: attachmentInputBlocks(attachments) }];

describe('native chat media admission', () => {
  test('reconstructs native media blocks from durable file attachments', () => {
    expect(messages[0]?.content).toEqual([
      { type: 'image', imageData: 'cGhvdG8=', imageMimeType: 'image/jpeg' },
      { type: 'video', mediaData: 'Y2xpcA==', mediaMimeType: 'video/mp4' },
      { type: 'audio', mediaData: 'c3BlZWNo', mediaMimeType: 'audio/mpeg' },
    ]);
    expect(
      mediaInputAdmissionError({ name: 'google', mediaInputKinds: ['audio', 'video'] }, messages),
    ).toBeNull();
    expect(mediaInputAdmissionError({ name: 'openai' }, messages)).toContain(
      'cannot deliver video input',
    );
  });

  test('rejects empty, mismatched, and oversized inline media', () => {
    const provider = { name: 'google', mediaInputKinds: ['audio', 'video'] as const };
    expect(
      mediaInputAdmissionError(provider, [
        { content: [{ type: 'audio', mediaData: '', mediaMimeType: 'audio/wav' }] },
      ]),
    ).toContain('empty');
    expect(
      mediaInputAdmissionError(provider, [
        { content: [{ type: 'video', mediaData: 'cGl4ZWxz', mediaMimeType: 'audio/wav' }] },
      ]),
    ).toContain('invalid media type');
    expect(
      mediaInputAdmissionError(provider, [
        {
          content: [
            { type: 'video', mediaData: 'A'.repeat(21 * 1024 * 1024), mediaMimeType: 'video/mp4' },
          ],
        },
      ]),
    ).toContain('exceeds 15 MB');
  });

  test('the registry blocks text-only integrations before invoking their stream', async () => {
    const registry = new ProviderRegistry({});
    let dispatched = false;
    const provider: Provider = {
      name: 'remote-media-fixture',
      config: { name: 'remote-media-fixture', apiKey: 'fixture', disabled: false },
      isAvailable: () => true,
      listModels: () => [
        {
          id: 'media-model',
          name: 'Media fixture',
          provider: 'remote-media-fixture',
          vision: true,
          supportsAttachments: true,
          contextWindow: 100000,
          maxOutputTokens: 1000,
        },
      ],
      async *streamResponse() {
        dispatched = true;
        yield { type: 'complete' };
      },
    };
    registry.registerRemoteProvider(provider);
    const events: ProviderEvent[] = [];
    for await (const event of registry.executeWithRetry(
      { model: 'media-model', systemPrompt: '', messages },
      provider.name,
    ))
      events.push(event);
    expect(dispatched).toBe(false);
    expect(events).toEqual([
      {
        type: 'error',
        error: expect.stringContaining('cannot deliver video input'),
        errorTransient: false,
      },
    ]);
  });
});
