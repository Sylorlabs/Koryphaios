/**
 * Regression guard for the expanded provider card in SettingsDrawer.
 *
 * The card's connected/detected branch used to interleave the grey model text
 * with the controls: the model-availability line ("1 enabled of 1 listed" /
 * "Model availability unverified") and the verification note rendered above
 * "Run safe check", "Rotate key" and "Disconnect" because they shared one
 * wrapping flex row. In the narrow grid columns the grey text therefore took
 * the first line and pushed the buttons under it.
 *
 * The controls lead the block now. This guard reads the real component source
 * and asserts the markup order, so a future refactor that folds the buttons
 * back into the text row fails here instead of silently regressing the UI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const drawerSource = readFileSync(
  join(process.cwd(), 'src/lib/components/SettingsDrawer.svelte'),
  'utf8',
);

/** Drop HTML and block comments so a doc comment mentioning a marker cannot match. */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Slice the connected/detected branch of the provider card: it opens on the
 * credential-detected condition and closes at the next `{:else if}` branch.
 */
function credentialDetectedBranch(source: string): string {
  const clean = stripComments(source);
  const start = clean.indexOf('{#if status?.credentialDetected ?? status?.authenticated}');
  expect(start, 'the connected provider branch must still exist').toBeGreaterThan(-1);
  const end = clean.indexOf('{:else if configurationBlocked}', start);
  expect(end, 'the connected provider branch must still be terminated').toBeGreaterThan(start);
  return clean.slice(start, end);
}

describe('provider card control order', () => {
  it('renders the action buttons above the grey model text', () => {
    const branch = credentialDetectedBranch(drawerSource);

    // Presence first: a vacuous pass is worse than a noisy failure.
    for (const marker of [
      'Run safe check',
      'Rotate key',
      'Disconnect',
      'enabled of',
      'Manage Models',
      'The provider catalog accepted this process',
    ]) {
      expect(branch, `the connected branch should still render "${marker}"`).toContain(marker);
    }

    const modelTextIndex = branch.indexOf('enabled of');
    const verificationNoteIndex = branch.indexOf('The provider catalog accepted this process');

    for (const control of ['Run safe check', 'Rotate key', 'Disconnect', 'Manage Models']) {
      const controlIndex = branch.indexOf(control);
      expect(
        controlIndex,
        `"${control}" must be declared before the model-availability text, otherwise the ` +
          'grey model text wraps onto the line above the controls in the narrow provider grid',
      ).toBeLessThan(modelTextIndex);
    }

    // "Run safe check" and "Manage Models" share the action row: nothing closes
    // that container between them, so they render side by side horizontally.
    const betweenControls = branch.slice(
      branch.indexOf('Run safe check'),
      branch.indexOf('Manage Models'),
    );
    expect(
      betweenControls,
      '"Run safe check" and "Manage Models" must sit in the same row, with no closing tag ' +
        'between them, so they render side by side',
    ).not.toContain('</div>');

    expect(
      branch.indexOf('Run safe check'),
      'the "Run safe check" control must be declared before the verification note it explains',
    ).toBeLessThan(verificationNoteIndex);
  });
});
