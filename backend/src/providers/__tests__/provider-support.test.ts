import { describe, expect, it } from 'bun:test';
import { isProviderCertified, isProviderRunnableByTier, providerSupport } from '@koryphaios/shared';
import { PROVIDER_CONFIGS } from '../provider-configs';
import { UNSUPPORTED_CHAT_PROVIDER_NAMES } from '../registry';

const EXPLICITLY_BLOCKED = new Set([
  ...UNSUPPORTED_CHAT_PROVIDER_NAMES,
  'gitlab',
  'freebuff',
  'jules',
]);

describe('provider release support truth', () => {
  it('never silently labels an adapter Certified', () => {
    expect(PROVIDER_CONFIGS.filter((entry) => isProviderCertified(entry.name))).toEqual([]);
  });

  it('marks every deliberately blocked chat path unavailable', () => {
    for (const provider of EXPLICITLY_BLOCKED) {
      expect(providerSupport(provider).tier, provider).toBe('unavailable');
      expect(isProviderRunnableByTier(provider), provider).toBe(false);
    }
  });

  it('keeps moving CLI harnesses Preview until a live release matrix exists', () => {
    for (const provider of [
      'claude',
      'codex',
      'codex-auth',
      'cline',
      'cursor',
      'devin',
      'grok',
      'antigravity',
    ]) {
      expect(providerSupport(provider)).toMatchObject({
        tier: 'preview',
        evidence: 'cli-contract',
      });
    }
  });

  it('defaults an unclassified future provider to Preview, never Compatible', () => {
    expect(providerSupport('future-provider-with-no-release-record')).toMatchObject({
      tier: 'preview',
      evidence: 'openai-compatible-contract',
    });
  });

  it('gives every configured provider a conservative support record', () => {
    for (const definition of PROVIDER_CONFIGS) {
      const support = providerSupport(definition.name);
      expect(['certified', 'compatible', 'preview', 'unavailable']).toContain(support.tier);
      expect(support.capabilities.length).toBeGreaterThan(0);
      expect(support.note.trim().length).toBeGreaterThan(20);
    }
  });
});
