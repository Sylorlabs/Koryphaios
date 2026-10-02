import { describe, expect, it } from 'bun:test';
import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { getProviderDisplay } from '../provider-display';
import { CapabilityRegistry } from '../CapabilityRegistry';
import type { ProviderRegistry } from '../registry';
import type { Provider } from '../types';

describe('provider website key links', () => {
  it('points each website-auth provider at its official key page', () => {
    expect(getProviderDisplay('qwen')?.credentialUrl).toBe('https://bailian.console.aliyun.com/');
    expect(getProviderDisplay('zai')?.credentialUrl).toBe('https://z.ai/manage-apikey/apikey-list');
    expect(getProviderDisplay('google')?.credentialUrl).toBe('https://aistudio.google.com/apikey');
    expect(getProviderDisplay('aistudio')?.credentialUrl).toBe(
      'https://aistudio.google.com/apikey',
    );
    expect(getProviderDisplay('perplexity')?.credentialUrl).toBe('https://www.perplexity.ai/api');
    expect(getProviderDisplay('stepfun')?.credentialUrl).toBe('https://platform.stepfun.com/');
    expect(getProviderDisplay('claude')?.credentialUrl).toBe('https://claude.ai/');
    expect(getProviderDisplay('codex')?.credentialUrl).toBe('https://chatgpt.com/');
    expect(getProviderDisplay('codex-auth')?.credentialUrl).toBe('https://chatgpt.com/');
  });
});

function model(
  id: string,
  provider: string,
  tier: ModelDef['tier'],
  contextWindow: number,
): ModelDef {
  return {
    id,
    name: id,
    provider: provider as ProviderName,
    contextWindow,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    tier,
  };
}

function stubProvider(name: string, models: ModelDef[]): Provider {
  return { name: name as ProviderName, listModels: () => models } as unknown as Provider;
}

function stubRegistry(
  providers: Provider[],
  trusted: (name: ProviderName) => boolean,
): ProviderRegistry {
  return {
    getAvailable: () => providers,
    isTrustedForRouting: (name: ProviderName) => trusted(name),
  } as unknown as ProviderRegistry;
}

describe('auto-detection as routing fallback', () => {
  it('prefers a verified provider over higher-scoring detected-only material', () => {
    const detected = stubProvider('detected-p', [
      model('flashy', 'detected-p', 'flagship', 1_000_000),
    ]);
    const verified = stubProvider('verified-p', [model('steady', 'verified-p', 'fast', 128_000)]);
    const registry = new CapabilityRegistry(
      stubRegistry([detected, verified], (name) => name === 'verified-p'),
    );
    // Without the trust band the flagship 1M-context model would win on score.
    expect(registry.findBestModel()).toEqual({ model: 'steady', provider: 'verified-p' });
  });

  it('still picks by score when trust is equal', () => {
    const a = stubProvider('a', [model('big', 'a', 'flagship', 1_000_000)]);
    const b = stubProvider('b', [model('small', 'b', 'fast', 128_000)]);
    const bothTrusted = new CapabilityRegistry(stubRegistry([a, b], () => true));
    expect(bothTrusted.findBestModel()).toEqual({ model: 'big', provider: 'a' });
    const noneTrusted = new CapabilityRegistry(stubRegistry([a, b], () => false));
    expect(noneTrusted.findBestModel()).toEqual({ model: 'big', provider: 'a' });
  });
});
