import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_PROVIDERS, PROVIDER_AUTH_MODES } from '@koryphaios/shared';

describe('provider settings state semantics', () => {
  it('keeps CLI providers in the shared catalog with CLI-owned authentication', () => {
    for (const provider of ['cline', 'cursor', 'devin']) {
      expect(IMPLEMENTED_PROVIDERS).toContain(provider);
      expect(PROVIDER_AUTH_MODES[provider]).toBe('auth_only');
    }
  });

  it('does not render token collection or a fake provider command for Cline', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/SettingsDrawer.svelte'),
      'utf8',
    );

    expect(source).not.toContain('clineSignInCommand');
    expect(source).not.toContain('cline auth --provider cline');
    expect(source).toMatch(
      /function showTokenInput[\s\S]*?usesLocalCliConnection\(name\)[\s\S]*?usesBrowserAuth\(name\)[\s\S]*?return false/,
    );
  });
});
