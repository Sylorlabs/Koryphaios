import { describe, expect, it } from 'bun:test';
import { PROVIDER_CONFIGS, PROVIDER_CONFIG_MAP } from '../provider-configs';

describe('built-in provider catalog truth', () => {
  it('every provider config has a name, baseUrl, and authMode', () => {
    for (const cfg of PROVIDER_CONFIGS) {
      expect(typeof cfg.name).toBe('string');
      expect(typeof cfg.baseUrl).toBe('string');
      expect(cfg.authMode).toBeDefined();
    }
  });

  it('uses the official Poe gateway contract', () => {
    expect(PROVIDER_CONFIG_MAP.get('poe')).toMatchObject({
      baseUrl: 'https://api.poe.com/v1',
      envKeys: ['POE_API_KEY'],
    });
  });

  it('provider names are unique', () => {
    const names = PROVIDER_CONFIGS.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
