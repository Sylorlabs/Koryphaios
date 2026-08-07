import { describe, expect, it } from 'bun:test';
import { mergeVerifiedContextWindow } from './context-window';

describe('mergeVerifiedContextWindow', () => {
  it('does not let incomplete usage telemetry erase a verified model limit', () => {
    expect(
      mergeVerifiedContextWindow(
        { max: 262_144, known: true },
        { max: 0, known: false },
      ),
    ).toEqual({ max: 262_144, known: true });
  });

  it('accepts a newer verified limit after a model switch', () => {
    expect(
      mergeVerifiedContextWindow(
        { max: 262_144, known: true },
        { max: 1_000_000, known: true },
      ),
    ).toEqual({ max: 1_000_000, known: true });
  });
});
