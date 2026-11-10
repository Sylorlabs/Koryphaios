import { expect, test } from 'bun:test';
import { parseDevicePrompt } from './prompt';

test('linked turns preserve attachments and explicit plan/image/context controls', () => {
  const prompt: ReturnType<typeof parseDevicePrompt> = { content: '', model: 'custom:portable:model', interactionMode: 'plan',
    imageInputMode: 'omit', contextWindow: 8192, fastMode: true,
    attachments: [{ type: 'image', data: 'synthetic-base64', name: 'diagram.png', mimeType: 'image/png' }] };
  expect(parseDevicePrompt(prompt)).toEqual(prompt);
});

test('oversized aggregate attachments and invalid controls fail before admission', () => {
  expect(() => parseDevicePrompt({ content: ' ', attachments: [] })).toThrow('Enter a prompt');
  expect(() => parseDevicePrompt({ content: 'Read', interactionMode: 'unsafe' })).toThrow('Invalid');
  expect(() => parseDevicePrompt({ content: 'Read', attachments: [
    { type: 'file', data: 'a'.repeat(400_000), name: 'first' },
    { type: 'file', data: 'b'.repeat(400_000), name: 'second' },
  ] })).toThrow('600 KB');
});
