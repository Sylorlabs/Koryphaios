import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Provider, ProviderEvent } from '../backend/src/providers/types';
import { AnthropicProvider } from '../backend/src/providers/anthropic';
import { OpenAIProvider, OpenRouterProvider } from '../backend/src/providers/openai';
import { CustomProvider } from '../backend/src/providers/custom';
import { createPromptCachePlan } from '../backend/src/providers/prompt-cache';
import { computeCostUsd } from '../backend/src/pricing';

type SupportedProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';
type Message = { role: 'user' | 'assistant'; content: string };
type Trial = {
  label: string;
  sessionId: string;
  ttftMs: number | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  costUsd: number | null;
  text: string;
};
type Baseline = { hitRate?: number; ttftMs?: number; latencyMs?: number; costUsd?: number };

const providerName = (process.env.KORY_CACHE_BENCH_PROVIDER ?? '') as SupportedProvider;
const model = process.env.KORY_CACHE_BENCH_MODEL?.trim() ?? '';
const customBaseUrl = process.env.KORY_CACHE_BENCH_BASE_URL?.trim() ?? '';
const stableTokenTarget = Math.max(
  1024,
  Number.parseInt(process.env.KORY_CACHE_BENCH_STABLE_TOKENS ?? '5000', 10) || 5000,
);
if (!['openai', 'anthropic', 'openrouter', 'custom'].includes(providerName) || !model) {
  console.error(
    'Set KORY_CACHE_BENCH_PROVIDER=openai|anthropic|openrouter|custom and KORY_CACHE_BENCH_MODEL=<model>.',
  );
  process.exit(2);
}
if (providerName === 'custom' && !customBaseUrl) {
  console.error('KORY_CACHE_BENCH_BASE_URL is required when KORY_CACHE_BENCH_PROVIDER=custom.');
  process.exit(2);
}

function key(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required for this live benchmark.`);
    process.exit(2);
  }
  return value;
}
function provider(): Provider {
  if (providerName === 'openai')
    return new OpenAIProvider({ name: 'openai', apiKey: key('OPENAI_API_KEY'), disabled: false });
  if (providerName === 'anthropic')
    return new AnthropicProvider({
      name: 'anthropic',
      apiKey: key('ANTHROPIC_API_KEY'),
      disabled: false,
    });
  if (providerName === 'openrouter')
    return new OpenRouterProvider({
      name: 'openrouter',
      apiKey: key('OPENROUTER_API_KEY'),
      disabled: false,
    });
  return new CustomProvider({
    name: 'custom:cache-benchmark',
    label: 'Cache benchmark endpoint',
    custom: true,
    kind: 'openai',
    baseUrl: customBaseUrl,
    apiKey: key('KORY_CACHE_BENCH_API_KEY'),
    disabled: false,
    models: [model],
  });
}
function stablePrefix(tokens: number): string {
  const line =
    'Kory cache benchmark stable policy block. Preserve this exact sentence and ordering across turns. ';
  const chars = tokens * 4;
  let text = 'You are running a controlled prompt-cache benchmark.\n';
  while (text.length < chars) text += line;
  return text.slice(0, chars);
}
function totalInput(event: ProviderEvent): number {
  const base = event.tokensIn ?? 0;
  return providerName === 'anthropic' ? base + (event.tokensCache ?? 0) : base;
}
async function trial(
  p: Provider,
  label: string,
  sessionId: string,
  systemPrompt: string,
  messages: Message[],
): Promise<Trial> {
  const plan = createPromptCachePlan({
    stableSystemPrompt: systemPrompt,
    providerAdapter: p.name,
    role: 'manager',
    workspaceScope: process.cwd(),
  });
  const started = performance.now();
  let first: number | undefined,
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    text = '';
  for await (const event of p.streamResponse({
    model,
    systemPrompt,
    messages,
    sessionId,
    harnessRole: 'manager',
    cacheLaneKind: 'manager',
    promptCache: plan,
    promptCacheKeepaliveMode: 'off',
    maxTokens: 16,
  })) {
    if ((event.type === 'content_delta' || event.type === 'thinking_delta') && first === undefined)
      first = performance.now();
    if (event.type === 'content_delta' && event.content) text += event.content;
    if (event.type === 'usage_update') {
      inputTokens = Math.max(inputTokens, totalInput(event));
      outputTokens = Math.max(outputTokens, event.tokensOut ?? 0);
      cacheReadTokens = Math.max(cacheReadTokens, event.tokensCacheRead ?? 0);
      cacheWriteTokens = Math.max(cacheWriteTokens, event.tokensCacheWrite ?? 0);
    }
    if (event.type === 'error') throw new Error(event.error ?? 'Provider benchmark failed');
  }
  const latencyMs = performance.now() - started;
  const priced = computeCostUsd(p.name, model, inputTokens, outputTokens, {
    cacheReadTokens,
    cacheWriteTokens,
  });
  return {
    label,
    sessionId,
    ttftMs: first === undefined ? null : first - started,
    latencyMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
    costUsd: priced?.costUsd ?? null,
    text,
  };
}

const p = provider();
const systemPrompt = stablePrefix(stableTokenTarget);
const seed = 'Return exactly: CACHE_BENCH_SEED';
const cold = await trial(p, 'cold', 'cache-bench-tab-a', systemPrompt, [
  { role: 'user', content: seed },
]);
const history: Message[] = [
  { role: 'user', content: seed },
  { role: 'assistant', content: cold.text || 'CACHE_BENCH_SEED' },
  { role: 'user', content: 'Return exactly: CACHE_BENCH_WARM' },
];
const warm = await trial(p, 'warm', 'cache-bench-tab-a', systemPrompt, history);
const siblingTab = await trial(p, 'sibling-tab', 'cache-bench-tab-b', systemPrompt, history);
const scorecard = {
  provider: providerName,
  ...(providerName === 'custom' ? { endpoint: customBaseUrl } : {}),
  model,
  stableTokenTarget,
  generatedAt: new Date().toISOString(),
  trials: [cold, warm, siblingTab],
  proof: {
    warmCacheHit: warm.cacheReadTokens > 0,
    siblingTabCacheHit: siblingTab.cacheReadTokens > 0,
    warmHitRate: warm.hitRate,
    siblingTabHitRate: siblingTab.hitRate,
    warmTtftMs: warm.ttftMs,
    warmLatencyMs: warm.latencyMs,
    warmCostUsd: warm.costUsd,
  },
};
const output = process.env.KORY_CACHE_BENCH_OUTPUT?.trim();
if (output) writeFileSync(resolve(output), `${JSON.stringify(scorecard, null, 2)}\n`);
const baselinePath = process.env.KORY_CACHE_BENCH_BASELINE?.trim();
let comparison: Record<string, boolean | null> | undefined;
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8')) as Baseline;
  comparison = {
    hitRateAtLeastBaseline:
      baseline.hitRate === undefined ? null : warm.hitRate >= baseline.hitRate,
    ttftAtMostBaseline:
      baseline.ttftMs === undefined || warm.ttftMs === null ? null : warm.ttftMs <= baseline.ttftMs,
    latencyAtMostBaseline:
      baseline.latencyMs === undefined ? null : warm.latencyMs <= baseline.latencyMs,
    costAtMostBaseline:
      baseline.costUsd === undefined || warm.costUsd === null
        ? null
        : warm.costUsd <= baseline.costUsd,
  };
}
console.log(JSON.stringify({ ...scorecard, comparison }, null, 2));
if (process.env.KORY_CACHE_BENCH_STRICT === '1') {
  const lost = comparison && Object.values(comparison).some((value) => value === false);
  if (!warm.cacheReadTokens || !siblingTab.cacheReadTokens || lost) process.exit(1);
}
