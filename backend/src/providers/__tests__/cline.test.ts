import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { ClineProvider, CLINE_API_BASE_URL } from '../cline';
import {
  CLINE_EFFORT_REASONING_LEVELS,
  CLINE_TOGGLE_REASONING_MODELS,
} from '../cline-catalog.generated';
import type { ProviderConfig } from '@koryphaios/shared';

const CATALOG_URL = 'https://api.cline.bot/api/v1/ai/cline/models';
const RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';

const originalFetch = globalThis.fetch;

/** Cline's rich public catalog row, trimmed to the fields the adapter reads. */
function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anthropic/synthetic-sonnet',
    name: 'Anthropic: Synthetic Sonnet',
    context_length: 1_000_000,
    architecture: { input_modalities: ['text'] },
    pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
    top_provider: { max_completion_tokens: 128_000 },
    supported_parameters: ['max_tokens', 'tools'],
    ...overrides,
  };
}

/** Read a request's Authorization header regardless of Headers vs plain object. */
function authHeader(init?: RequestInit): string | undefined {
  const headers = new Headers((init?.headers as HeadersInit) ?? {});
  return headers.get('authorization') ?? undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RouteOptions {
  servedIds?: string[];
  catalog?: unknown[];
  recommended?: unknown;
  authRequired?: boolean;
}

function installRoutes(options: RouteOptions = {}) {
  const served = options.servedIds ?? ['anthropic/synthetic-sonnet'];
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url === CATALOG_URL) return jsonResponse({ data: options.catalog ?? [catalogRow()] });
    if (url === RECOMMENDED_URL) {
      return jsonResponse(options.recommended ?? { recommended: [], free: [] });
    }
    if (url.endsWith('/models')) {
      if (options.authRequired !== false && !authHeader(init)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      return jsonResponse({
        object: 'list',
        data: served.map((id) => ({ id, object: 'model', owned_by: id.split('/')[0] })),
      });
    }
    return jsonResponse({ data: [] }, 404);
  }) as typeof fetch;
  return seen;
}

function provider(overrides: Partial<ProviderConfig> = {}): ClineProvider {
  return new ClineProvider({
    name: 'cline',
    apiKey: 'sk-synthetic-cline-key',
    baseUrl: '',
    disabled: false,
    ...overrides,
  });
}

/** Drive discovery to completion, then read the catalog. */
async function discovered(overrides: Partial<ProviderConfig> = {}): Promise<ClineProvider> {
  const p = provider(overrides);
  p.listModels();
  // The refresh is kicked off in the background; poll until the ids land.
  for (let i = 0; i < 200 && p.listModels().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return p;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ClineProvider availability', () => {
  it('is a plain API-key provider: no key means no adapter', () => {
    expect(provider().isAvailable()).toBe(true);
    expect(provider({ apiKey: '   ' }).isAvailable()).toBe(false);
    expect(provider({ apiKey: undefined }).isAvailable()).toBe(false);
    expect(provider({ disabled: true }).isAvailable()).toBe(false);
    // An authToken is still an accepted credential for this provider.
    expect(provider({ apiKey: undefined, authToken: 'tok' }).isAvailable()).toBe(true);
  });

  it('points at Cline\\u2019s real OpenAI-compatible base URL', () => {
    expect(CLINE_API_BASE_URL).toBe('https://api.cline.bot/api/v1');
  });

  it('explains the missing credential instead of guessing a model list', () => {
    expect(provider({ apiKey: undefined }).getModelDiscoveryError()).toContain('Cline API key');
    expect(provider().getModelDiscoveryError()).toBeUndefined();
  });
});

describe('ClineProvider model discovery', () => {
  it('reads all three endpoints and publishes the deployment inventory', async () => {
    const seen = installRoutes({ servedIds: ['anthropic/synthetic-sonnet', 'openai/synthetic'] });
    const models = (await discovered()).listModels();

    expect(seen).toContain(CATALOG_URL);
    expect(seen).toContain(RECOMMENDED_URL);
    expect(seen.some((u) => u === `${CLINE_API_BASE_URL}/models`)).toBe(true);
    // Every served id is offered, each carrying its real catalog metadata.
    expect(models.map((m) => m.apiModelId).sort()).toEqual([
      'anthropic/synthetic-sonnet',
      'openai/synthetic',
    ]);
  });

  it('never attaches a key to the public catalog reads', async () => {
    const authed: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (authHeader(init)) authed.push(url);
      if (url === CATALOG_URL) return jsonResponse({ data: [catalogRow()] });
      if (url === RECOMMENDED_URL) return jsonResponse({ recommended: [], free: [] });
      return jsonResponse({ object: 'list', data: [{ id: 'anthropic/synthetic-sonnet' }] });
    }) as typeof fetch;

    await discovered();
    expect(authed.every((u) => !u.includes('/ai/cline/'))).toBe(true);
  });

  it('maps Cline\\u2019s rich catalog onto real per-model metadata', async () => {
    installRoutes();
    const [model] = (await discovered()).listModels();

    expect(model).toMatchObject({
      provider: 'cline',
      apiModelId: 'anthropic/synthetic-sonnet',
      name: 'Anthropic: Synthetic Sonnet',
      contextWindow: 1_000_000,
      contextVerified: true,
      maxOutputTokens: 128_000,
      supportsStreaming: true,
      // pricing is decimal USD per token; the catalog is USD per million.
      costPerMInputTokens: 3,
      costPerMOutputTokens: 15,
      costPerMInputCached: 0.3,
    });
    expect(model!.functionCall).toBe(true);
  });

  it('reports vision and attachments only from real input modalities', async () => {
    installRoutes({ catalog: [catalogRow({ architecture: { input_modalities: ['text', 'image'] } })] });
    const [vision] = (await discovered()).listModels();
    expect(vision!.vision).toBe(true);
    expect(vision!.supportsAttachments).toBe(true);

    // A fresh provider so the previous catalog cache cannot leak in.
    installRoutes({ catalog: [catalogRow({ architecture: { input_modalities: ['text'] } })] });
    const [textOnly] = (await discovered()).listModels();
    expect(textOnly!.vision).toBeUndefined();
  });

  it('leaves the picker empty rather than inventing a list when discovery fails', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const p = provider();
    p.listModels();
    await new Promise((r) => setTimeout(r, 40));
    expect(p.listModels()).toEqual([]);
  });

  it('re-reads the catalog on a forced refresh', async () => {
    let catalogReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === CATALOG_URL) {
        catalogReads += 1;
        return jsonResponse({ data: [catalogRow()] });
      }
      if (String(input) === RECOMMENDED_URL) return jsonResponse({ recommended: [], free: [] });
      return jsonResponse({ object: 'list', data: [{ id: 'anthropic/synthetic-sonnet' }] });
    }) as typeof fetch;

    const p = await discovered();
    const before = catalogReads;
    p.refreshModels(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(catalogReads).toBeGreaterThan(before);
  });

  it('still publishes models when the cosmetic badge endpoint is down', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CATALOG_URL) return jsonResponse({ data: [catalogRow()] });
      if (url === RECOMMENDED_URL) return new Response('down', { status: 503 });
      return jsonResponse({ object: 'list', data: [{ id: 'anthropic/synthetic-sonnet' }] });
    }) as typeof fetch;

    expect((await discovered()).listModels()).toHaveLength(1);
  });

  it('puts Cline\\u2019s recommended models first in the picker', async () => {
    installRoutes({
      servedIds: ['zzz/synthetic-last', 'aaa/synthetic-first', 'mmm/synthetic-middle'],
      recommended: { recommended: [{ id: 'mmm/synthetic-middle' }], free: [] },
    });
    const order = (await discovered()).listModels().map((m) => m.apiModelId);
    expect(order[0]).toBe('mmm/synthetic-middle');
    // The rest stay alphabetical for a stable list.
    expect(order.slice(1)).toEqual(['aaa/synthetic-first', 'zzz/synthetic-last']);
  });
});

describe('ClineProvider reasoning', () => {
  const effortModel = Object.keys(CLINE_EFFORT_REASONING_LEVELS)[0]!;
  const toggleModel = [...CLINE_TOGGLE_REASONING_MODELS][0]!;

  it('uses the exact ladder Cline publishes, in canonical order', async () => {
    installRoutes({ servedIds: [effortModel], catalog: [catalogRow({ id: effortModel })] });
    const [model] = (await discovered()).listModels();
    expect(model!.canReason).toBe(true);
    expect(model!.reasoningLevels).toEqual([...CLINE_EFFORT_REASONING_LEVELS[effortModel]!]);
  });

  it('offers on/off for toggle-only models, which have no effort ladder', async () => {
    installRoutes({
      servedIds: [toggleModel],
      catalog: [
        catalogRow({
          id: toggleModel,
          supported_parameters: ['max_tokens', 'reasoning', 'include_reasoning'],
        }),
      ],
    });
    const [model] = (await discovered()).listModels();
    expect(model!.canReason).toBe(true);
    expect(model!.reasoningLevels).toEqual(['off', 'on']);
  });

  it('shows no reasoning picker for a model with no declared ladder', async () => {
    installRoutes({
      servedIds: ['mystery/unknown-model'],
      catalog: [catalogRow({ id: 'mystery/unknown-model' })],
    });
    const [model] = (await discovered()).listModels();
    // No ladder declared, so the reasoning picker is not shown and no control is
    // ever sent. `canReason` stays at the shared default of false rather than
    // being guessed upward from a bare `reasoning` parameter name.
    expect(model!.reasoningLevels).toBeUndefined();
    expect(model!.canReason).toBe(false);
  });

  it('sends reasoning_effort only for a tier the model actually declares', () => {
    const p = provider();
    const def = { apiModelId: effortModel } as never;
    const levels = CLINE_EFFORT_REASONING_LEVELS[effortModel]!;
    const declared = levels[0]!;

    const ok: Record<string, unknown> = {};
    (p as never as { applyReasoningControls: Function }).applyReasoningControls(ok, {
      canReason: true,
      effort: declared,
      supported: new Set(levels),
      modelDef: def,
      requestModel: effortModel,
    });
    expect(ok).toEqual({ reasoning_effort: declared });

    // A tier this model does not declare must never reach the wire.
    const undeclared = ['none', 'low', 'medium', 'high', 'xhigh', 'max'].find(
      (l) => !levels.includes(l),
    )!;
    const rejected: Record<string, unknown> = {};
    (p as never as { applyReasoningControls: Function }).applyReasoningControls(rejected, {
      canReason: true,
      effort: undeclared,
      supported: new Set([...levels, undeclared]),
      modelDef: def,
      requestModel: effortModel,
    });
    expect(rejected).toEqual({});
  });

  it('maps a toggle model\\u2019s selection onto the boolean include_reasoning control', () => {
    const p = provider();
    const def = { apiModelId: toggleModel } as never;
    const send = (effort: string) => {
      const params: Record<string, unknown> = {};
      (p as never as { applyReasoningControls: Function }).applyReasoningControls(params, {
        canReason: true,
        effort,
        supported: new Set(['off', 'on']),
        modelDef: def,
        requestModel: toggleModel,
      });
      return params;
    };
    expect(send('on')).toEqual({ include_reasoning: true });
    expect(send('off')).toEqual({ include_reasoning: false });
    // A tier name cannot leak onto a toggle-only model.
    expect(send('high')).toEqual({});
  });

  it('maps a live off/on ladder before the generated catalog is refreshed', () => {
    const p = provider();
    const params: Record<string, unknown> = {};
    (p as never as { applyReasoningControls: Function }).applyReasoningControls(params, {
      canReason: true,
      effort: 'off',
      supported: new Set(['off', 'on']),
      modelDef: {
        apiModelId: 'nvidia/nemotron-3.5-lightning:free',
        reasoningLevels: ['off', 'on'],
      } as never,
      requestModel: 'nvidia/nemotron-3.5-lightning:free',
    });
    expect(params).toEqual({ include_reasoning: false });
  });

  it('never sends a reasoning control for a model with no declared ladder', () => {
    const p = provider();
    const params: Record<string, unknown> = {};
    (p as never as { applyReasoningControls: Function }).applyReasoningControls(params, {
      canReason: true,
      effort: 'high',
      supported: new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
      modelDef: { apiModelId: 'mystery/unknown-model' } as never,
      requestModel: 'mystery/unknown-model',
    });
    expect(params).toEqual({});
  });

  it('sends the control from the request model id, with no live discovery at all', () => {
    // Regression: the hook once read the ladder only from `listModels()`, which
    // is populated asynchronously. On a cold adapter the user's reasoning
    // selection was therefore dropped even though the model supports it.
    const p = provider();
    const params: Record<string, unknown> = {};
    (p as never as { applyReasoningControls: Function }).applyReasoningControls(params, {
      canReason: false, // live discovery has not run, so nothing knows this yet
      effort: 'low',
      supported: new Set(),
      modelDef: undefined,
      requestModel: effortModel,
    });
    expect(params).toEqual({ reasoning_effort: 'low' });
  });

  it('keeps the generated catalog internally consistent', () => {
    const effortIds = Object.keys(CLINE_EFFORT_REASONING_LEVELS);
    const toggleIds = [...CLINE_TOGGLE_REASONING_MODELS];
    expect(effortIds.length).toBeGreaterThan(0);
    expect(toggleIds.length).toBeGreaterThan(0);
    // A model has exactly one control; a ladder and a toggle are exclusive.
    expect(effortIds.filter((id) => CLINE_TOGGLE_REASONING_MODELS.has(id))).toEqual([]);
    for (const [id, levels] of Object.entries(CLINE_EFFORT_REASONING_LEVELS)) {
      expect(levels.length).toBeGreaterThan(0);
      // Levels are ordered cheapest-effort first and never duplicated.
      expect(new Set(levels).size).toBe(levels.length);
      expect(levels).toEqual([...levels].sort((a, b) => levels.indexOf(a) - levels.indexOf(b)));
      expect(id).toMatch(/^[\w.~-]+\/[\w.:~-]+$/);
    }
  });
});

describe('ClineProvider credential verification through the registry', () => {
  it('verifies against the real catalog when the stored base URL is blank', async () => {
    // Regression: `baseUrl ?? defaultBase` treated a configured-but-blank
    // baseUrl — what the Settings UI and the shipped koryphaios.json both
    // write — as authoritative, so verification answered "Unsupported
    // provider" for every built-in OpenAI-compatible provider with a known
    // default URL. A blank value must fall back to the provider's own default.
    const { ProviderRegistry } = await import('../registry');
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Only the inference catalog; the public capability catalog under
      // /ai/cline/models is a different route and is unauthenticated.
      if (url === `${CLINE_API_BASE_URL}/models`) {
        seen.push(url);
        if (!authHeader(init)) return new Response('{"error":"Unauthorized"}', { status: 401 });
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'anthropic/synthetic-sonnet', object: 'model', owned_by: 'anthropic' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return jsonResponse({ data: [] });
    }) as typeof fetch;

    for (const baseUrl of ['', '   ', CLINE_API_BASE_URL]) {
      const registry = new ProviderRegistry({
        server: { port: 3001, host: '127.0.0.1' },
        providers: { cline: { name: 'cline', apiKey: 'sk-synthetic-key', baseUrl, disabled: false } },
      } as never);
      const result = await registry.verifyConnection('cline');
      expect(result, `baseUrl=${JSON.stringify(baseUrl)}`).toEqual({ success: true });
    }
    // Every request reached Cline's real catalog endpoint — never a bare host
    // root. Background discovery adds its own call per registry, so assert the
    // invariant over all of them rather than an exact count.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const url of seen) expect(url).toBe(`${CLINE_API_BASE_URL}/models`);
  });
});

describe('ClineProvider attribution headers', () => {
  let seen: Headers | undefined;

  beforeEach(() => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers as HeadersInit);
      return jsonResponse({ object: 'list', data: [] });
    }) as typeof fetch;
  });

  it("sends Cline's documented usage-attribution headers", async () => {
    await discovered();
    expect(seen?.get('HTTP-Referer')).toBe('https://koryphaios.com');
    expect(seen?.get('X-Title')).toBe('Koryphaios');
  });

  it('lets user-configured headers override the defaults', async () => {
    await discovered({ headers: { 'X-Title': 'My App' } });
    expect(seen?.get('X-Title')).toBe('My App');
  });
});
