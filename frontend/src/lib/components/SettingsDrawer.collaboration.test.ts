import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'SettingsDrawer.svelte'), 'utf8');

describe('collaboration settings safety copy', () => {
  test('does not advertise a local fallback join code when relay hosting is unavailable', () => {
    expect(source).not.toContain('Join Code (local network only)');
    expect(source).not.toContain("activeCollab.joinCode || '••••••'");
    expect(source).toContain('Sharing is not configured');
    expect(source).toContain('use Linked Devices');
  });
});
