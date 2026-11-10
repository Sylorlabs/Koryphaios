/**
 * Platform-correct chord labels for Playwright assertions.
 *
 * The shortcuts UI renders each key through `formatKey()`, so a literally-bound
 * Ctrl reads `⌃` on macOS and `Ctrl` on Windows/Linux. Hard-coding either
 * spelling in an assertion makes the suite pass on one runner and fail on the
 * other, so every chord label has to be composed here instead.
 */
const MAC = process.platform === 'darwin';

const KEYS: Record<string, string> = {
  Mod: MAC ? '⌘' : 'Ctrl',
  Ctrl: MAC ? '⌃' : 'Ctrl',
  Meta: MAC ? '⌘' : 'Win',
  Alt: MAC ? '⌥' : 'Alt',
  Shift: MAC ? '⇧' : 'Shift',
  Enter: MAC ? '↵' : 'Enter',
  Esc: MAC ? 'esc' : 'Esc',
  ' ': MAC ? '␣' : 'Space',
  fn: 'fn',
};

/** Mirrors `formatChord` in `frontend/src/lib/utils/platform.ts`. */
export function chordLabel(...keys: string[]): string {
  return keys.map((key) => KEYS[key] ?? key).join(' + ');
}
