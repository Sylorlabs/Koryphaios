/**
 * Provider request-shape conformance.
 *
 * This suite is intentionally synthetic. It installs a blocking fetch double
 * before ProviderRegistry exists, feeds canned responses to selected adapters,
 * and records only the request shape they emitted. A passing row does NOT
 * establish that a credential is valid, an account is authenticated, a model
 * is entitled, quota is available, or a live generation succeeds.
 *
 * Live/provider-paid calls belong in explicit provider-specific smoke tests;
 * an environment variable can never silently turn this unit suite into one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ProviderConfig, ProviderName } from '@koryphaios/shared';
import { ANTHROPIC_VERSION, PROVIDER_BASE_URLS, VERTEX_EXPRESS_VERIFY_URL } from '../api-endpoints';
import { providerDefaultBaseUrl } from '../constants';
import { GITHUB_MODELS_CATALOG_URL, GITHUB_MODELS_INFERENCE_BASE } from '../github-models';
import { PROVIDER_CONFIGS } from '../provider-configs';
import { ProviderRegistry, UNSUPPORTED_CHAT_PROVIDER_NAMES } from '../registry';
import type { Provider, ProviderEvent } from '../types';

const MARKER = 'synthetic-shape-ok';
const TEST_KEY = 'synthetic-test-key';
const COPILOT_BEARER = 'synthetic-copilot-bearer';

type EvidenceKind =
  'dedicated-shape' | 'openai-compatible-family-shape' | 'external-suite' | 'unavailable';

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
};

type EvidenceRow = {
  provider: ProviderName;
  kind: EvidenceKind;
  evidence: string;
};

const captured: CapturedRequest[] = [];
const evidence = new Map<ProviderName, EvidenceRow>();
const originalFetch = globalThis.fetch;
const originalDisableCli = process.env.KORY_DISABLE_CLI_AUTODETECT;

const CLI_EXTERNAL = new Set<ProviderName>([
  'claude',
  'codex',
  'codex-auth',
  'grok',
  'antigravity',
  'cursor',
  'devin',
  'cline',
  'freebuff',
]);

const OTHER_EXTERNAL = new Set<ProviderName>([
  // AWS SDK signing/control-plane behavior has a dedicated Bedrock suite and
  // is deliberately not pushed through a global-fetch approximation here.
  'bedrock',
  // OpenCode Go chooses OpenAI vs Anthropic transport per live model metadata.
  'opencodego',
  'codebuff',
]);

const EXPLICITLY_UNAVAILABLE = new Set<ProviderName>([
  ...UNSUPPORTED_CHAT_PROVIDER_NAMES,
  'gitlab',
  'jules',
]);

const DEDICATED = new Set<ProviderName>([
  'anthropic',
  'google',
  'aistudio',
  'vertexai',
  'copilot',
  'azure',
  'azurecognitive',
  'sapai',
  'github-models',
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function eventStream(chunks: string[]): Response {
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const OPENAI_SSE = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: MARKER } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
];

const ANTHROPIC_SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-test', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: MARKER } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
];

const GEMINI_SSE = [
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: MARKER }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\r\n\r\n`,
];

function requestParts(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const request = input instanceof Request ? input : null;
  return {
    url: request?.url ?? String(input),
    method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
    headers: new Headers(init?.headers ?? request?.headers ?? {}),
  };
}

/**
 * Closed synthetic transport. Every attempted HTTP request is captured and
 * answered locally; this function never delegates to originalFetch.
 */
async function syntheticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = requestParts(input, init);
  captured.push(request);
  const url = new URL(request.url);
  const authorization = request.headers.get('authorization') ?? '';

  if (request.url === 'https://models.dev/api.json') return json({});

  if (request.url === 'https://api.github.com/copilot_internal/v2/token') {
    if (!authorization.startsWith('Token '))
      return json({ error: 'wrong synthetic auth shape' }, 401);
    return json({ token: COPILOT_BEARER, expires_at: Math.floor(Date.now() / 1000) + 3600 });
  }

  if (url.host === 'api.githubcopilot.com' && url.pathname === '/models') {
    return json({ object: 'list', data: [{ id: 'test-model' }] });
  }

  if (request.url === GITHUB_MODELS_CATALOG_URL) {
    return json([
      {
        id: 'openai/gpt-test',
        name: 'Synthetic catalog model',
        capabilities: ['streaming'],
        limits: { max_input_tokens: 4096, max_output_tokens: 512 },
      },
    ]);
  }

  if (url.pathname.endsWith('/oauth/token')) {
    if (!authorization.startsWith('Basic '))
      return json({ error: 'wrong synthetic auth shape' }, 401);
    return json({ access_token: 'synthetic-sap-bearer', token_type: 'bearer', expires_in: 3600 });
  }

  if (url.pathname === '/v2/lm/deployments/synthetic-deployment') {
    return json({
      id: 'synthetic-deployment',
      status: 'RUNNING',
      deploymentUrl:
        'https://synthetic-deployment.inference.ai.us10.hana.ondemand.com/v2/inference/deployments/synthetic-deployment',
    });
  }

  if (request.url === VERTEX_EXPRESS_VERIFY_URL) return json({ totalTokens: 4 });

  if (/streamGenerateContent/.test(url.pathname)) return eventStream(GEMINI_SSE);

  if (/\/messages$/.test(url.pathname)) return eventStream(ANTHROPIC_SSE);

  if (/\/chat\/completions$/.test(url.pathname)) return eventStream(OPENAI_SSE);

  // Model discovery is incidental to the request-shape being exercised. It is
  // still intercepted and recorded so it cannot leak onto the network.
  if (
    request.method === 'GET' &&
    (/\/models$/.test(url.pathname) || url.pathname === '/api/tags')
  ) {
    return json({ object: 'list', data: [{ id: 'test-model' }], models: [] });
  }

  return json({ error: `unexpected synthetic request: ${request.method} ${request.url}` }, 418);
}

function canonicalFamilyBase(name: ProviderName): string {
  if (name === 'local') return 'http://127.0.0.1:1234/v1';
  if (name === 'ollama' || name === 'lmstudio' || name === 'llamacpp') {
    const root = providerDefaultBaseUrl(name);
    if (!root) throw new Error(`No configured local base URL for ${name}`);
    return `${root.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/v1`;
  }
  if (name === 'github-models') return GITHUB_MODELS_INFERENCE_BASE;
  const base = providerDefaultBaseUrl(name) ?? PROVIDER_BASE_URLS[name];
  if (!base) throw new Error(`No configured base URL for ${name}`);
  return base.replace(/\/+$/, '');
}

function configFor(name: ProviderName): ProviderConfig {
  const base: ProviderConfig = {
    name,
    disabled: false,
    selectedModels: [],
    hideModelSelector: false,
  };
  if (name === 'anthropic') {
    // Anthropic's SDK appends /v1/messages to its origin-level base URL.
    return { ...base, apiKey: TEST_KEY, baseUrl: 'https://api.anthropic.com' };
  }
  if (name === 'sapai') {
    return {
      ...base,
      apiKey: JSON.stringify({
        clientid: 'synthetic-client',
        clientsecret: 'synthetic-secret',
        url: 'https://synthetic.authentication.sap.hana.ondemand.com',
        serviceurls: { AI_API_URL: 'https://synthetic.ai.us10.hana.ondemand.com' },
      }),
      baseUrl: 'https://synthetic.ai.us10.hana.ondemand.com',
      deployment: 'synthetic-deployment',
      headers: { 'AI-Resource-Group': 'synthetic-resource-group' },
    };
  }
  if (name === 'azure' || name === 'azurecognitive') {
    return {
      ...base,
      apiKey: TEST_KEY,
      baseUrl:
        name === 'azure'
          ? 'https://synthetic-resource.openai.azure.com'
          : 'https://synthetic-resource.cognitiveservices.azure.com',
      deployment: 'synthetic-deployment',
    };
  }
  if (name === 'copilot') return { ...base, authToken: 'synthetic-github-token' };
  if (name === 'kimicode') {
    return { ...base, authToken: TEST_KEY, baseUrl: canonicalFamilyBase(name) };
  }
  if (name === 'bedrock') return base;
  return { ...base, apiKey: TEST_KEY, baseUrl: canonicalFamilyBase(name) };
}

function createProvider(registry: ProviderRegistry, name: ProviderName): Provider | null {
  return (
    registry as unknown as {
      createProvider: (providerName: ProviderName, config: ProviderConfig) => Provider | null;
    }
  ).createProvider(name, configFor(name));
}

function runtimeDefaultConfig(registry: ProviderRegistry, name: ProviderName): ProviderConfig {
  return (
    registry as unknown as {
      buildProviderConfig: (providerName: ProviderName) => ProviderConfig;
    }
  ).buildProviderConfig(name);
}

async function drive(
  provider: Provider,
  model = 'test-model',
): Promise<{
  events: ProviderEvent[];
  text: string;
  error?: string;
}> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamResponse({
    model,
    systemPrompt: 'Synthetic request-shape fixture',
    messages: [{ role: 'user', content: 'Return the canned marker.' }],
  })) {
    events.push(event);
  }
  return {
    events,
    text: events
      .filter((event) => event.type === 'content_delta')
      .map((event) => event.content)
      .join(''),
    error: events.find((event) => event.type === 'error')?.error,
  };
}

function requestsSince(index: number): CapturedRequest[] {
  return captured.slice(index);
}

function chatRequest(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find(
    (request) =>
      request.method === 'POST' && /\/chat\/completions$/.test(new URL(request.url).pathname),
  );
}

describe('provider synthetic request-shape conformance', () => {
  let registry: ProviderRegistry;

  beforeAll(() => {
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    // Install before constructing ProviderRegistry: startup model warming and
    // lazy SDK clients must capture the closed transport, never real fetch.
    globalThis.fetch = syntheticFetch;
    registry = new ProviderRegistry();
  });

  afterAll(async () => {
    // Let fire-and-forget model discovery settle while the closed transport is
    // still installed; restoring first would create background network leakage.
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.fetch = originalFetch;
    if (originalDisableCli === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
    else process.env.KORY_DISABLE_CLI_AUTODETECT = originalDisableCli;

    const counts = [...evidence.values()].reduce<Record<EvidenceKind, number>>(
      (acc, row) => {
        acc[row.kind] += 1;
        return acc;
      },
      {
        'dedicated-shape': 0,
        'openai-compatible-family-shape': 0,
        'external-suite': 0,
        unavailable: 0,
      },
    );
    const rows = [...evidence.values()]
      .sort((a, b) => a.provider.localeCompare(b.provider))
      .map((row) => `  ${row.provider.padEnd(18)} ${row.kind.padEnd(34)} ${row.evidence}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\nPROVIDER SYNTHETIC REQUEST-SHAPE REPORT — ${counts['dedicated-shape']} dedicated, ${counts['openai-compatible-family-shape']} OpenAI-family, ${counts['external-suite']} delegated, ${counts.unavailable} unavailable; 0 live provider calls.\n` +
        'PASS means only that a local adapter emitted the categorized request shape and parsed a canned response. It does not prove credential correctness, authentication, account/model entitlement, quota, service availability, or end-to-end generation.\n' +
        rows,
    );
  });

  it('categorizes every configured provider without making a live call', () => {
    for (const definition of PROVIDER_CONFIGS) {
      const name = definition.name;
      let kind: EvidenceKind;
      let detail: string;
      if (EXPLICITLY_UNAVAILABLE.has(name)) {
        kind = 'unavailable';
        detail = 'chat execution intentionally fails closed';
      } else if (CLI_EXTERNAL.has(name) || OTHER_EXTERNAL.has(name)) {
        kind = 'external-suite';
        detail = 'subprocess/SDK-specific proof is outside this fetch-shape suite';
      } else if (DEDICATED.has(name)) {
        kind = 'dedicated-shape';
        detail = 'provider-specific synthetic check below';
      } else {
        kind = 'openai-compatible-family-shape';
        detail = 'Bearer + configured host + canned OpenAI SSE only';
      }
      evidence.set(name, { provider: name, kind, evidence: detail });
    }

    expect(evidence.size).toBe(PROVIDER_CONFIGS.length);
    expect([...evidence.keys()].sort()).toEqual(PROVIDER_CONFIGS.map((entry) => entry.name).sort());
  });

  it('records OpenAI-compatible family shape at each configured canonical host', async () => {
    const family = [...evidence.values()].filter(
      (row) => row.kind === 'openai-compatible-family-shape',
    );
    expect(family.length).toBeGreaterThan(30);

    for (const row of family) {
      if (!['local', 'ollama', 'lmstudio', 'llamacpp'].includes(row.provider)) {
        expect(
          runtimeDefaultConfig(registry, row.provider).baseUrl?.replace(/\/+$/, ''),
          `${row.provider} runtime default must match the recorded configured host`,
        ).toBe(canonicalFamilyBase(row.provider));
      }
      const provider = createProvider(registry, row.provider);
      expect(provider, `${row.provider} should construct its family adapter`).not.toBeNull();
      expect(provider!.isAvailable(), `${row.provider} synthetic config should be usable`).toBe(
        true,
      );

      const start = captured.length;
      const result = await drive(provider!);
      const request = chatRequest(requestsSince(start));
      expect(
        result.error,
        `${row.provider} should parse the canned family response`,
      ).toBeUndefined();
      expect(result.text, `${row.provider} should emit the canned marker`).toContain(MARKER);
      expect(request, `${row.provider} should emit a chat request`).toBeDefined();

      const expectedBase = new URL(canonicalFamilyBase(row.provider));
      const actual = new URL(request!.url);
      expect(actual.host, `${row.provider} host`).toBe(expectedBase.host);
      expect(actual.pathname, `${row.provider} path`).toBe(
        `${expectedBase.pathname.replace(/\/$/, '')}/chat/completions`,
      );
      expect(request!.headers.get('authorization'), `${row.provider} auth family`).toMatch(
        /^Bearer /,
      );
      expect(actual.hostname).not.toContain('mock.local');

      evidence.set(row.provider, {
        provider: row.provider,
        kind: row.kind,
        evidence: `${actual.host}${actual.pathname} [synthetic Bearer family]`,
      });
    }
  }, 120_000);

  it('normalizes local-server inference to /v1 while retaining native discovery roots', async () => {
    for (const name of ['ollama', 'lmstudio', 'llamacpp'] as const) {
      const config = { ...runtimeDefaultConfig(registry, name), disabled: false };
      const provider = (
        registry as unknown as {
          createProvider: (providerName: ProviderName, config: ProviderConfig) => Provider | null;
        }
      ).createProvider(name, config);
      expect(provider).not.toBeNull();
      const start = captured.length;
      const result = await drive(provider!);
      const request = chatRequest(requestsSince(start));
      expect(result.text).toContain(MARKER);
      expect(request?.url).toBe(`${canonicalFamilyBase(name)}/chat/completions`);
    }
  });

  it('pins Anthropic Messages shape and the documented API version', async () => {
    const provider = createProvider(registry, 'anthropic');
    expect(provider).not.toBeNull();
    const start = captured.length;
    const result = await drive(provider!);
    const request = requestsSince(start).find(
      (item) => item.method === 'POST' && /\/v1\/messages$/.test(new URL(item.url).pathname),
    );

    expect(result.text).toContain(MARKER);
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers.get('x-api-key')).toBe(TEST_KEY);
    expect(request?.headers.get('anthropic-version')).toBe(ANTHROPIC_VERSION);
    expect(ANTHROPIC_VERSION).toBe('2023-06-01');
    evidence.set('anthropic', {
      provider: 'anthropic',
      kind: 'dedicated-shape',
      evidence: '/v1/messages + x-api-key + anthropic-version 2023-06-01 (synthetic)',
    });
  });

  it('captures Gemini API-key streaming shape for Google and AI Studio', async () => {
    for (const name of ['google', 'aistudio'] as const) {
      const provider = createProvider(registry, name);
      expect(provider).not.toBeNull();
      const start = captured.length;
      const result = await drive(provider!);
      const request = requestsSince(start).find((item) =>
        /streamGenerateContent/.test(new URL(item.url).pathname),
      );
      expect(result.text).toContain(MARKER);
      expect(new URL(request!.url).host).toBe('generativelanguage.googleapis.com');
      const keyShape =
        request!.headers.get('x-goog-api-key') === TEST_KEY ||
        new URL(request!.url).searchParams.get('key') === TEST_KEY;
      expect(keyShape).toBe(true);
      evidence.set(name, {
        provider: name,
        kind: 'dedicated-shape',
        evidence: 'generativelanguage.googleapis.com streamGenerateContent + API key (synthetic)',
      });
    }
  });

  it('captures Vertex express-mode countTokens verification without generation', async () => {
    const start = captured.length;
    const result = await registry.verifyConnection('vertexai', { apiKey: TEST_KEY });
    const request = requestsSince(start).find((item) => item.url === VERTEX_EXPRESS_VERIFY_URL);
    expect(result).toEqual({ success: true });
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('x-goog-api-key')).toBe(TEST_KEY);
    evidence.set('vertexai', {
      provider: 'vertexai',
      kind: 'dedicated-shape',
      evidence: 'aiplatform.googleapis.com countTokens + x-goog-api-key (synthetic)',
    });
  });

  it('captures Copilot token exchange and required integration headers', async () => {
    const provider = createProvider(registry, 'copilot');
    expect(provider).not.toBeNull();
    const start = captured.length;
    const result = await drive(provider!);
    const requests = requestsSince(start);
    const exchange = requests.find((item) => item.url.includes('copilot_internal/v2/token'));
    const chat = chatRequest(requests);

    expect(result.text).toContain(MARKER);
    expect(exchange?.headers.get('authorization')).toBe('Token synthetic-github-token');
    expect(new URL(chat!.url).host).toBe('api.githubcopilot.com');
    expect(chat?.headers.get('authorization')).toBe(`Bearer ${COPILOT_BEARER}`);
    expect(chat?.headers.get('editor-version')).toBeTruthy();
    expect(chat?.headers.get('copilot-integration-id')).toBe('vscode-chat');
    evidence.set('copilot', {
      provider: 'copilot',
      kind: 'dedicated-shape',
      evidence: 'GitHub Token exchange -> Copilot Bearer + IDE headers (synthetic)',
    });
  });

  it('keeps Azure base-model catalogs separate from explicit deployment inference', async () => {
    for (const name of ['azure', 'azurecognitive'] as const) {
      const provider = createProvider(registry, name);
      expect(provider).not.toBeNull();
      expect(provider!.listModels().map((model) => model.id)).toEqual(['synthetic-deployment']);
      const start = captured.length;
      const result = await drive(provider!, 'synthetic-deployment');
      const request = chatRequest(requestsSince(start));
      const url = new URL(request!.url);
      expect(result.text).toContain(MARKER);
      expect(url.pathname).toBe('/openai/deployments/synthetic-deployment/chat/completions');
      expect(url.searchParams.get('api-version')).toBeTruthy();
      expect(request?.headers.get('api-key')).toBe(TEST_KEY);
      expect(provider!.listModels().some((model) => model.id === 'test-model')).toBe(false);
      evidence.set(name, {
        provider: name,
        kind: 'dedicated-shape',
        evidence: `${url.host}${url.pathname} [explicit deployment + synthetic api-key]`,
      });
    }
  });

  it('captures SAP service-key OAuth and explicit deployment shape', async () => {
    const provider = createProvider(registry, 'sapai');
    expect(provider).not.toBeNull();
    expect(provider!.listModels().map((model) => model.id)).toEqual(['synthetic-deployment']);
    const start = captured.length;
    const result = await drive(provider!, 'synthetic-deployment');
    const requests = requestsSince(start);
    const oauth = requests.find((item) => new URL(item.url).pathname.endsWith('/oauth/token'));
    const chat = chatRequest(requests);

    expect(result.text).toContain(MARKER);
    expect(oauth?.headers.get('authorization')).toMatch(/^Basic /);
    expect(chat?.headers.get('authorization')).toBe('Bearer synthetic-sap-bearer');
    expect(chat?.headers.get('ai-resource-group')).toBe('synthetic-resource-group');
    expect(new URL(chat!.url).pathname).toBe(
      '/v2/inference/deployments/synthetic-deployment/chat/completions',
    );
    evidence.set('sapai', {
      provider: 'sapai',
      kind: 'dedicated-shape',
      evidence:
        'service-key Basic OAuth -> Bearer + resource group + explicit deployment (synthetic)',
    });
  });

  it('uses GitHub Models catalog and inference hosts for their distinct purposes', async () => {
    const verificationStart = captured.length;
    const verified = await registry.verifyConnection('github-models', { apiKey: TEST_KEY });
    const catalog = requestsSince(verificationStart).find(
      (item) => item.url === GITHUB_MODELS_CATALOG_URL,
    );
    expect(verified).toEqual({ success: true });
    expect(catalog?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(catalog?.headers.get('x-github-api-version')).toBe('2022-11-28');

    const provider = createProvider(registry, 'github-models');
    expect(provider).not.toBeNull();
    const inferenceStart = captured.length;
    const result = await drive(provider!, 'openai/gpt-test');
    const inference = chatRequest(requestsSince(inferenceStart));
    expect(result.text).toContain(MARKER);
    expect(new URL(inference!.url).origin + new URL(inference!.url).pathname).toBe(
      `${GITHUB_MODELS_INFERENCE_BASE}/chat/completions`,
    );
    evidence.set('github-models', {
      provider: 'github-models',
      kind: 'dedicated-shape',
      evidence: '/catalog/models for discovery; /inference/chat/completions for canned inference',
    });
  });

  it('keeps unavailable and delegated providers out of the synthetic family claim', () => {
    for (const name of EXPLICITLY_UNAVAILABLE) {
      expect(evidence.get(name)?.kind).toBe('unavailable');
    }
    for (const name of [...CLI_EXTERNAL, ...OTHER_EXTERNAL]) {
      expect(evidence.get(name)?.kind).toBe('external-suite');
    }
    expect(evidence.get('bedrock')?.evidence).toContain('SDK-specific');
    expect(evidence.get('gitlab')?.evidence).toContain('fails closed');
    expect(evidence.get('jules')?.kind).toBe('unavailable');
  });

  it('intercepts every HTTP attempt, including background discovery, before teardown', async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(globalThis.fetch).toBe(syntheticFetch);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((request) => request.url.includes('mock.local'))).toBe(false);
    // The test double never calls originalFetch. This identity assertion also
    // catches a provider that replaced the closed transport during the suite.
    expect(globalThis.fetch).not.toBe(originalFetch);
  });
});
