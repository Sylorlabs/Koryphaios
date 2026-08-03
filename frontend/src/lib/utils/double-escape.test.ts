import { describe, expect, test } from 'bun:test';
import { registerEligibleEscape } from './double-escape';

describe('double Escape Time Travel gesture', () => {
  test('opens on the second eligible Escape inside the window', () => {
    const first = registerEligibleEscape(0, 1_000);
    expect(first).toEqual({ open: false, nextAt: 1_000 });
    expect(registerEligibleEscape(first.nextAt, 1_420)).toEqual({ open: true, nextAt: 0 });
  });

  test('starts over after the gesture window expires', () => {
    expect(registerEligibleEscape(1_000, 1_501)).toEqual({ open: false, nextAt: 1_501 });
  });

  test('does not treat a clock rollback as a second Escape', () => {
    expect(registerEligibleEscape(1_000, 900)).toEqual({ open: false, nextAt: 900 });
  });
});
