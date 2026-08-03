import { describe, expect, it } from 'bun:test';
import { chunkSpeech, markdownToSpeech } from './speech-text';
describe('speech-safe text', () => {
  it('removes code and URLs while preserving readable structure', () =>
    expect(markdownToSpeech('# Result\n- Works\n```ts\nsecret()\n```\nhttps://example.com')).toBe(
      'Result. Works',
    ));
  it('chunks at sentences', () =>
    expect(chunkSpeech('One. Two. Three.', 10)).toEqual(['One. Two.', 'Three.']));
});
