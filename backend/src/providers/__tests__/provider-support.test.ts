import { describe, expect, it } from 'bun:test';
import {
  isProviderCertified,
  isProviderCapabilityOnly,
  isProviderRunnableByTier,
  providerCapabilityKinds,
  providerSupport,
} from '@koryphaios/shared';
import { PROVIDER_CONFIGS } from '../provider-configs';
import { DEDICATED_CAPABILITY_PROVIDER_NAMES, UNSUPPORTED_CHAT_PROVIDER_NAMES } from '../registry';

const EXPLICITLY_BLOCKED = new Set<string>([
  ...[...UNSUPPORTED_CHAT_PROVIDER_NAMES].filter(
    (name) => !DEDICATED_CAPABILITY_PROVIDER_NAMES.has(name as never),
  ),
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
      'cursor',
      'devin',
      'grok',
      'antigravity',
      'freebuff',
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

  it('routes every capability adapter to the surface that serves it', () => {
    // These providers have no chat-completions contract. Each is reached through
    // a dedicated adapter and must be Preview with adapter evidence, never
    // Certified, and must never advertise chat.
    const expected: Record<string, string[]> = {
      replicate: ['image', 'video', 'audio', 'embedding'],
      luma: ['video', 'image'],
      klingai: ['video', 'image'],
      prodia: ['image', 'video'],
      lmnt: ['audio'],
      voyageai: ['embedding', 'rerank'],
      mem0: ['memory'],
      letta: ['memory'],
    };
    for (const [provider, capabilities] of Object.entries(expected)) {
      const support = providerSupport(provider);
      expect(support.evidence, provider).toBe('capability-adapter-contract');
      expect(support.tier, provider).toBe('preview');
      expect(support.capabilities.sort(), provider).toEqual(capabilities.slice().sort());
      expect(support.capabilities, provider).not.toContain('chat');
      expect(isProviderRunnableByTier(provider), provider).toBe(true);
      expect(isProviderCapabilityOnly(provider), provider).toBe(true);
      expect(isProviderCertified(provider), provider).toBe(false);
      // Each one is registered with the registry as a capability provider, so a
      // verified credential is not reported as a blocked configuration.
      expect(DEDICATED_CAPABILITY_PROVIDER_NAMES.has(provider as never), provider).toBe(true);
      // Still absent from the chat surface, and that must never regress.
      expect(UNSUPPORTED_CHAT_PROVIDER_NAMES.has(provider as never), provider).toBe(true);
      expect(providerCapabilityKinds(provider).sort(), provider).toEqual(
        capabilities.slice().sort(),
      );
    }
  });

  it('keeps chat providers out of the capability-adapter set', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      expect(isProviderCapabilityOnly(provider), provider).toBe(false);
      expect(providerCapabilityKinds(provider), provider).toEqual([]);
    }
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
