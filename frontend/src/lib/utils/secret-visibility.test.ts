import { describe, expect, it } from 'vitest';
import { shouldRemaskSecrets } from './secret-visibility';

describe('Settings secret visibility boundaries', () => {
  it('re-masks on both close and reopen without resetting during an open drawer', () => {
    expect(shouldRemaskSecrets(false, true)).toBe(true);
    expect(shouldRemaskSecrets(true, false)).toBe(true);
    expect(shouldRemaskSecrets(true, true)).toBe(false);
    expect(shouldRemaskSecrets(false, false)).toBe(false);
  });
});
