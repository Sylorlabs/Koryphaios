import { describe, expect, it } from 'vitest';
import { mergeTranscript, sliceAudioChunks, transcriptWords } from './voice-transcript';

describe('transcriptWords', () => {
  it('drops surrounding and repeated whitespace', () => {
    expect(transcriptWords('  one   two\nthree ')).toEqual(['one', 'two', 'three']);
  });

  it('returns nothing for an empty transcript', () => {
    expect(transcriptWords('   ')).toEqual([]);
  });
});

describe('mergeTranscript', () => {
  it('returns the first piece unchanged', () => {
    expect(mergeTranscript('', ' hello  world ')).toBe('hello world');
  });

  it('counts words repeated by an overlapping window once', () => {
    expect(mergeTranscript('let us build the widget', 'the widget so it ships')).toBe(
      'let us build the widget so it ships',
    );
  });

  it('matches a seam that differs only in case and punctuation', () => {
    expect(mergeTranscript('Koryphaios is fast,', 'Fast. It streams')).toBe(
      'Koryphaios is fast, It streams',
    );
  });

  it('joins pieces that share no words', () => {
    expect(mergeTranscript('spoken first', 'and then second')).toBe(
      'spoken first and then second',
    );
  });

  it('keeps a repeated single word only once', () => {
    expect(mergeTranscript('really really', 'really good')).toBe('really really good');
  });

  it('ignores an empty piece', () => {
    expect(mergeTranscript('already here', '  ')).toBe('already here');
  });
});

describe('sliceAudioChunks', () => {
  it('returns everything when the window starts at zero', () => {
    const chunks = [new Float32Array([1, 2]), new Float32Array([3])];
    expect(Array.from(sliceAudioChunks(chunks, 0))).toEqual([1, 2, 3]);
  });

  it('starts inside a block', () => {
    const chunks = [new Float32Array([1, 2, 3]), new Float32Array([4, 5])];
    expect(Array.from(sliceAudioChunks(chunks, 4))).toEqual([5]);
  });

  it('clamps a window past the end to an empty buffer', () => {
    expect(sliceAudioChunks([new Float32Array([1, 2])], 9)).toHaveLength(0);
  });
});
