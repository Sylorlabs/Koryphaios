import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { Provider } from '../types';
import { ProviderRegistry } from '../registry';
import { PROVIDER_AUTH_MODE } from '../constants';
import { catalogRefreshTier } from '../catalog-refresh';

/**
 * Coverage guard for the adaptive catalog scheduler.
 *
 * The scheduler must reach every provider rather than a hand-maintained list, so
 * a newly added adapter gets refreshed on its own. This file constructs the whole
 * built-in registry and asserts that every adapter with a discovery hook gets a
 * tier, and that the excluded set is exactly the adapters that publish no
 * catalog to discover.
 *
 * It lives in its own file because constructing every adapter fires real
 * background discovery from each constructor, which would race the
 * single-flight shared-registry assertions in `catalog-refresh.test.ts`.
 */

// Constructing every adapter starts background discovery against the placeholder
// credentials below. Answer those locally so the audit never reaches the network.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('models.dev')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function registryWithEveryProviderEnabled(): ProviderRegistry {
  const configured: Record<string, unknown> = {};
  for (const name of Object.keys(PROVIDER_AUTH_MODE)) {
    configured[name] = {
      disabled: false,
      apiKey: 'sk-scheduler-coverage-audit',
      baseUrl: 'https://example.invalid/v1',
    };
  }
  return new ProviderRegistry({
    providers: configured,
    agents: { manager: { model: 'm' }, coder: { model: 'm' }, task: { model: 'm' } },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  } as unknown as KoryphaiosConfig);
}

function constructedProviders(registry: ProviderRegistry): Map<string, Provider> {
  return (registry as unknown as { providers: Map<string, Provider> }).providers;
}

describe('scheduler coverage of every provider', () => {
  it('assigns a tier to every adapter that has a discovery hook', () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    try {
      const registry = registryWithEveryProviderEnabled();
      const constructed = [...constructedProviders(registry).keys()];
      expect(constructed.length).toBeGreaterThan(50);

      const tiered: string[] = [];
      for (const name of constructed) {
        const provider = constructedProviders(registry).get(name);
        if (typeof provider?.refreshModels !== 'function') continue;
        tiered.push(name);
        // Falls through to `hourly` for anything unlisted, so this asserts the
        // classification is total rather than that a set was updated by hand.
        expect(['cheap', 'hourly', 'cli']).toContain(catalogRefreshTier(name));
      }

      expect(tiered.length).toBeGreaterThan(80);
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });

  it('excludes exactly the built-ins that publish no catalog to discover', () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    try {
      const registry = registryWithEveryProviderEnabled();
      const providers = constructedProviders(registry);
      const noHook = [...providers.entries()]
        .filter(([, provider]) => typeof provider.refreshModels !== 'function')
        .map(([name]) => name)
        .sort();

      // codebuff pins one documented store agent, gitlab's server picks Duo per
      // request, and hoplite ships a fixed table with no catalog endpoint.
      // Each already explains itself to the user.
      expect(noHook).toEqual(['codebuff', 'gitlab', 'hoplite']);
      for (const name of noHook) {
        expect(providers.get(name)?.getModelDiscoveryError?.()).toBeTruthy();
      }
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });

  it('only refreshes adapters that are enabled, available, and hook-bearing', () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    try {
      const registry = registryWithEveryProviderEnabled();
      for (const target of registry.listModelCatalogRefreshTargets()) {
        expect(typeof target.refreshModels).toBe('function');
        expect(target.config.disabled).not.toBe(true);
        expect(target.isAvailable()).toBe(true);
      }
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });
});
