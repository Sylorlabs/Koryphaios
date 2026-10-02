import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_PROVIDERS, PROVIDER_AUTH_MODES } from '@koryphaios/shared';

describe('provider settings state semantics', () => {
  it('keeps CLI providers in the shared catalog with CLI-owned authentication', () => {
    for (const provider of ['cursor', 'devin']) {
      expect(IMPLEMENTED_PROVIDERS).toContain(provider);
      expect(PROVIDER_AUTH_MODES[provider]).toBe('auth_only');
    }
  });

  it('treats Cline as an API-key provider, not a local CLI connect', () => {
    expect(IMPLEMENTED_PROVIDERS).toContain('cline');
    expect(PROVIDER_AUTH_MODES.cline).toBe('api_key');
  });

  it('never renders a Cline CLI sign-in path', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/SettingsDrawer.svelte'),
      'utf8',
    );

    expect(source).not.toContain('clineSignInCommand');
    expect(source).not.toContain('cline auth --provider cline');
    expect(source).not.toContain("prov.key === 'cline'");
    expect(source).toMatch(
      /function showTokenInput[\s\S]*?usesLocalCliConnection\(name\)[\s\S]*?usesBrowserAuth\(name\)[\s\S]*?return false/,
    );
  });

  it('does not gate Cline behind the local-CLI connect flow', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/stores/providers.svelte.ts'), 'utf8');

    const start = source.indexOf('export const localCliConnectProviders');
    const localCliConnect = source.slice(start, source.indexOf(']);', start));
    expect(localCliConnect).not.toContain("'cline'");
    expect(source).not.toContain("cline: 'Cline'");
  });
});
