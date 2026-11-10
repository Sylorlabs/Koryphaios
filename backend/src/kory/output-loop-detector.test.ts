import { describe, expect, test } from 'bun:test';
import { detectOutputLoop } from './output-loop-detector';

describe('output loop detector', () => {
  test('detects one token repeated ten times', () => {
    expect(detectOutputLoop('the '.repeat(10))).toEqual({
      unitLength: 4,
      repetitions: 10,
    });
  });

  test('detects an exact phrase repeated ten times', () => {
    const phrase = 'the beer was cold';
    expect(detectOutputLoop(Array.from({ length: 10 }, () => phrase).join(' '))).toEqual({
      unitLength: phrase.length + 1,
      repetitions: 10,
    });
  });

  test('detects a loop after unrelated leading output', () => {
    expect(detectOutputLoop(`Here is the answer:\n${'same '.repeat(10)}`)).toMatchObject({
      unitLength: 5,
      repetitions: 10,
    });
  });

  test('does not stop ordinary prose with fewer than ten repeats', () => {
    expect(detectOutputLoop('the '.repeat(9))).toBeNull();
    expect(detectOutputLoop('the beer was cold and the beer was cold')).toBeNull();
    expect(detectOutputLoop('aaaaaaaaaa')).toBeNull();
  });

  test('requires the repeated phrase to reach the end of the stream', () => {
    expect(detectOutputLoop(`${'the '.repeat(10)}finished`)).toEqual({
      unitLength: 4,
      repetitions: 10,
    });
  });
});
