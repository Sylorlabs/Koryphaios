// Live reachability probe — the honest "does it actually work" test.
//
// Unlike provider-conformance.test.ts (which mocks the network and only verifies the
// REQUEST SHAPE), this probe makes a REAL network call per provider using a dummy key and
// records the genuine HTTP status the live service returns. No real credentials needed:
//   • 401 / 403 / 400  → ✓ endpoint is LIVE and correct (it reached the real API, which
//                          rejected our fake key — exactly the expected outcome).
//   • 404 / 405        → ✗ wrong PATH (host is up but the route is wrong).
//   • DNS / ENOTFOUND  → ✗ dead HOST (base URL points nowhere).
//   • ECONNREFUSED     → · local server not running (expected for ollama/llamacpp/etc.).
//   • 200              → unexpectedly accepted a dummy key (or returned content) — inspect.
//   • timeout          → · inconclusive (network/slow).
//
// Per-tenant providers (azure/azurecognitive/sapai) and the CLI subscription (claude) can't
// be probed against a generic host without a real tenant/login — they're reported as such.
//
// Run:  bun run scripts/probe-providers.ts
//       bun run scripts/probe-providers.ts --only openai,groq,mistral

import { AsyncLocalStorage } from 'node:async_hooks';
import { ProviderRegistry } from '../src/providers/registry';
import {
  PROVIDER_AUTH_MODE,
  OPENCODE_DEFAULT_BASE_URL,
  LLAMACPP_DEFAULT,
  LMSTUDIO_DEFAULT,
} from '../src/providers/constants';
import { getModelsForProvider } from '../src/providers/models';
import type { Provider, ProviderEvent } from '../src/providers/types';
import type { ProviderConfig, ProviderName } from '@koryphaios/shared';

const DUMMY_KEY = 'sk-probe-invalid-0000000000000000000000000000';
const TIMEOUT_MS = 14_000;
const CONCURRENCY = 6;

// Providers that point at a per-tenant or per-login host and can't be reachability-probed
// against a generic endpoint. Reported as INFO, not pass/fail.
const NOT_GENERICALLY_PROBEABLE: Record<string, string> = {
  claude: 'CLI subscription (verified live in claude-code.test.ts)',
  azure: 'per-tenant resource URL required',
  azurecognitive: 'per-tenant resource URL required',
  sapai: 'per-tenant AI Core service key + OAuth URL required',
  vertexai: 'per-project GCP endpoint + OAuth/ADC required',
  bedrock: 'AWS account + SigV4 creds required',
};
const LOCAL_PROVIDERS = new Set(['local', 'ollama', 'llamacpp', 'lmstudio']);

// Dummy AWS env so bedrock can sign (it still hits the real bedrock-runtime host).
process.env.AWS_ACCESS_KEY_ID ||= 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ||= 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.AWS_REGION ||= 'us-east-1';

interface NetCall { url: string; status?: number; error?: string; body?: string }
// Per-probe call bucket so concurrent providers never cross-contaminate each other's
// captured requests (a shared global races under concurrency).
const als = new AsyncLocalStorage<NetCall[]>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url: string = typeof input === 'string' ? input : input?.url ?? String(input);
  const bucket = als.getStore();
  try {
    const res = await realFetch(input, init);
    const call: NetCall = { url, status: res.status };
    // Peek at error bodies (small JSON) to distinguish a route 404 from a "model not found"
    // 404 — some providers (e.g. Fireworks) validate the model BEFORE auth, so a bogus model
    // id 404s even though the endpoint is correct. Clone so the provider can still read it.
    if (res.status >= 400) {
      try { call.body = (await res.clone().text()).slice(0, 200); } catch { /* streaming/opaque */ }
    }
    bucket?.push(call);
    return res;
  } catch (e: any) {
    bucket?.push({ url, error: e?.code || e?.message || String(e) });
    throw e;
  }
}) as typeof fetch;

function buildConfig(name: ProviderName): ProviderConfig {
  const base = { name, disabled: false, selectedModels: [], hideModelSelector: false } as ProviderConfig;
  const mode = PROVIDER_AUTH_MODE[name];
  if (LOCAL_PROVIDERS.has(name)) {
    return {
      ...base,
      apiKey: DUMMY_KEY,
      baseUrl: name === 'llamacpp' ? LLAMACPP_DEFAULT : name === 'lmstudio' ? LMSTUDIO_DEFAULT : 'http://localhost:11434/v1',
    };
  }
  if (mode === 'auth_only') {
    return { ...base, authToken: name === 'copilot' ? 'gho_probeInvalidToken' : DUMMY_KEY };
  }
  // api_key / api_key_or_auth / env_auth → dummy key, let the provider use its REAL default host.
  return { ...base, apiKey: DUMMY_KEY, baseUrl: OPENCODE_DEFAULT_BASE_URL[name] };
}

async function drive(provider: Provider, model: string) {
  const events: ProviderEvent[] = [];
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    for await (const e of provider.streamResponse({
      model,
      systemPrompt: 'probe',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })) {
      events.push(e);
      if (e.type === 'complete' || e.type === 'error') break;
    }
  } catch { /* swallowed — captured via fetch wrapper / events */ } finally {
    clearTimeout(guard);
  }
  return events;
}

type Verdict = 'REACHABLE' | 'WRONG_PATH' | 'DEAD_HOST' | 'LOCAL_DOWN' | 'ACCEPTED' | 'SERVER_ERR' | 'TIMEOUT' | 'NO_NET' | 'NO_INSTANCE' | 'NOT_AVAILABLE' | 'INFO';

function classify(name: string, chat: NetCall | undefined, events: ProviderEvent[]): { v: Verdict; detail: string } {
  if (!chat) {
    const errEvt = events.find((e) => e.type === 'error') as any;
    return { v: 'NO_NET', detail: errEvt?.error ? `no network call (${String(errEvt.error).slice(0, 60)})` : 'no network call made' };
  }
  if (chat.error) {
    const e = chat.error.toUpperCase().replace(/[\s_]/g, '');
    // Bun reports BOTH DNS-resolution failure and active refusal as "ConnectionRefused",
    // so for localhost providers this means "no local server running" (expected, not a bug);
    // for a public cloud host it means the host is dead/unreachable (a real defect).
    if (e.includes('ENOTFOUND') || e.includes('EAIAGAIN') || e.includes('DNS')) return { v: 'DEAD_HOST', detail: chat.error };
    if (e.includes('CONNECTIONREFUSED') || e.includes('ECONNREFUSED'))
      return { v: LOCAL_PROVIDERS.has(name) ? 'LOCAL_DOWN' : 'DEAD_HOST', detail: chat.error };
    if (e.includes('ABORT') || e.includes('TIMEOUT') || e.includes('TIMED')) return { v: 'TIMEOUT', detail: chat.error };
    return { v: 'NO_NET', detail: chat.error };
  }
  const s = chat.status!;
  if (s === 401 || s === 403 || s === 400 || s === 422) return { v: 'REACHABLE', detail: `HTTP ${s} (endpoint live, dummy key rejected)` };
  if (s === 404 || s === 405) {
    // A 404 whose body is about the MODEL (not the route) means the endpoint is correct but
    // the probe's catalog model id isn't a real deployment — the host/path are fine.
    if (chat.body && /model.*(not found|inaccessible|not deployed|does not exist)|not_found.{0,20}model|"param"\s*:\s*"model"/i.test(chat.body))
      return { v: 'REACHABLE', detail: `HTTP ${s} (endpoint live; model-id artifact, not a route bug)` };
    return { v: 'WRONG_PATH', detail: `HTTP ${s}${chat.body ? ` — ${chat.body.slice(0, 80)}` : ''}` };
  }
  if (s === 200) return { v: 'ACCEPTED', detail: 'HTTP 200 (inspect)' };
  if (s >= 500) return { v: 'SERVER_ERR', detail: `HTTP ${s}` };
  if (s === 429) return { v: 'REACHABLE', detail: 'HTTP 429 (rate-limited but live)' };
  return { v: 'REACHABLE', detail: `HTTP ${s}` };
}

function pickChat(calls: NetCall[]): NetCall | undefined {
  // The request that proves reachability: the chat/inference/exchange call (skip /models refreshes).
  const rel = calls.filter((c) =>
    /chat\/completions|\/messages|generateContent|\/codex\/|copilot_internal|invoke-with-response-stream|\/oauth\/token|\/v2\/inference\//.test(c.url),
  );
  // Prefer a request that actually reached a status; else the first relevant; else any non-/models call.
  return rel.find((c) => c.status !== undefined) ?? rel[0]
    ?? calls.filter((c) => !/\/models(\b|$|\?)/.test(c.url)).find((c) => c.status !== undefined)
    ?? calls.find((c) => c.status !== undefined);
}

async function probe(registry: ProviderRegistry, name: ProviderName) {
  const calls: NetCall[] = [];
  return als.run(calls, async () => {
    const info = NOT_GENERICALLY_PROBEABLE[name];
    let provider: Provider | null = null;
    try {
      provider = (registry as any).createProvider(name, buildConfig(name)) as Provider | null;
    } catch (e: any) {
      return { name, v: 'NO_INSTANCE' as Verdict, detail: `createProvider threw: ${e.message}`, host: '' };
    }
    // null/unavailable: report the per-tenant reason if known, else "requires base URL (BYO)".
    if (!provider) {
      if (info) return { name, v: 'INFO' as Verdict, detail: info, host: '' };
      return { name, v: 'INFO' as Verdict, detail: 'requires user-supplied base URL (BYO) — not generically probeable', host: '' };
    }
    if (!provider.isAvailable?.()) {
      if (info) return { name, v: 'INFO' as Verdict, detail: info, host: '' };
      return { name, v: 'NOT_AVAILABLE' as Verdict, detail: 'isAvailable() false', host: '' };
    }

    const model = getModelsForProvider(name)[0]?.id ?? 'test-model';
    const events = await drive(provider, model);
    const chat = pickChat(calls);
    const host = chat ? (() => { try { return new URL(chat.url).host + new URL(chat.url).pathname; } catch { return chat.url; } })() : '';
    const { v, detail } = classify(name, chat, events);
    // Per-tenant/CLI providers: report as INFO unless we genuinely reached a real shared host.
    if (info && v !== 'REACHABLE') return { name, v: 'INFO' as Verdict, detail: info, host };
    return { name, v, detail, host };
  });
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only'));
  const only = onlyArg ? (process.argv[process.argv.indexOf(onlyArg) + 1] ?? onlyArg.split('=')[1])?.split(',') : null;
  const registry = new ProviderRegistry();
  let names = (Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]);
  if (only) names = names.filter((n) => only.includes(n));

  const results: Awaited<ReturnType<typeof probe>>[] = [];
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const batch = names.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((n) => probe(registry, n)))));
    process.stderr.write(`  probed ${Math.min(i + CONCURRENCY, names.length)}/${names.length}\n`);
  }

  globalThis.fetch = realFetch;
  const icon: Record<Verdict, string> = {
    REACHABLE: '✓', ACCEPTED: '✓', WRONG_PATH: '✗', DEAD_HOST: '✗', SERVER_ERR: '⚠',
    TIMEOUT: '·', LOCAL_DOWN: '·', NO_NET: '✗', NO_INSTANCE: '✗', NOT_AVAILABLE: '·', INFO: 'ℹ',
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  results.sort((a, b) => a.name.localeCompare(b.name));
  const line = (r: typeof results[number]) =>
    `  ${icon[r.v]} ${pad(r.name, 16)} ${pad(r.v, 13)} ${pad(r.host, 52)} ${r.detail}`;
  const reachable = results.filter((r) => r.v === 'REACHABLE' || r.v === 'ACCEPTED').length;
  const broken = results.filter((r) => r.v === 'WRONG_PATH' || r.v === 'DEAD_HOST' || r.v === 'NO_NET' || r.v === 'NO_INSTANCE');

  console.log(`\nPROVIDER REACHABILITY PROBE — real network, dummy credentials`);
  console.log('─'.repeat(120));
  console.log(results.map(line).join('\n'));
  console.log('─'.repeat(120));
  console.log(`${reachable} endpoints LIVE & correct · ${broken.length} BROKEN · ` +
    `${results.filter((r) => r.v === 'INFO').length} per-tenant/CLI (not probeable) · ` +
    `${results.filter((r) => r.v === 'LOCAL_DOWN').length} local (no server) · ` +
    `${results.filter((r) => r.v === 'TIMEOUT' || r.v === 'SERVER_ERR').length} inconclusive`);
  if (broken.length) {
    console.log(`\nBROKEN:\n${broken.map((r) => `  ✗ ${r.name}: ${r.detail} [${r.host}]`).join('\n')}`);
  }
}

main();
