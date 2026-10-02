import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Provider,
  ProviderEvent,
  ProviderMessage,
  ProviderToolDef,
} from '../backend/src/providers/types';
import { AnthropicProvider } from '../backend/src/providers/anthropic';
import { OpenAIProvider, OpenRouterProvider } from '../backend/src/providers/openai';
import { CustomProvider } from '../backend/src/providers/custom';
import {
  canonicalizeProviderTools,
  createPromptCachePlan,
  derivePromptCacheLane,
} from '../backend/src/providers/prompt-cache';
import {
  explainCacheTransition,
  type CacheLaneIdentity,
} from '../backend/src/providers/cache-fabric';
import {
  getPromptCacheCapabilities,
  resolvePromptCacheCapabilities,
  type PromptCacheRoutingContext,
} from '../backend/src/providers/cache-capabilities';
import { writeProviderReasoningCacheProbe } from '../backend/src/providers/cache-capability-store';
import {
  planContextWindowProjection,
  projectionMessagesTokenUpperBound,
} from '../backend/src/cache/context-window-projection';
import { computeCostUsd } from '../backend/src/pricing';

type SupportedProvider = 'openai' | 'anthropic' | 'openrouter' | 'custom';
type MatrixMode = 'act' | 'plan';
type MatrixStep = {
  label: string;
  model: string;
  reasoning: string;
  mode: MatrixMode;
  sessionId: string;
};
type MatrixTrial = MatrixStep & {
  ttftMs: number | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  costUsd: number | null;
  routeKey: string | null;
  laneKey: string | null;
  nativeLaneState: 'cold' | 'warm-candidate' | 'retained-switch-back';
  breakReasons: string[];
  toolAbiHash: string;
  workspaceContextHash: string;
  cacheExpectedWarm: boolean | null;
  cacheUnexpectedMiss: boolean;
};

const providerName = (process.env.KORY_CACHE_BENCH_PROVIDER ?? '') as SupportedProvider;
const primaryModel = process.env.KORY_CACHE_BENCH_MODEL?.trim() ?? '';
const secondaryModel = process.env.KORY_CACHE_MATRIX_SECONDARY_MODEL?.trim() ?? '';
const customBaseUrl = process.env.KORY_CACHE_BENCH_BASE_URL?.trim() ?? '';
const customProviderId =
  process.env.KORY_CACHE_BENCH_CUSTOM_PROVIDER_ID?.trim() || 'custom:cache-benchmark';
const stableTokenTarget = Math.max(
  4096,
  Number.parseInt(process.env.KORY_CACHE_BENCH_STABLE_TOKENS ?? '25000', 10) || 25_000,
);
const probeReasoning = process.env.KORY_CACHE_MATRIX_PROBE_REASONING === '1';
const recordReasoningProbe = process.env.KORY_CACHE_MATRIX_RECORD_REASONING_PROBE === '1';
const probeHitThreshold = Math.min(
  0.99,
  Math.max(0.5, Number(process.env.KORY_CACHE_MATRIX_PROBE_HIT_THRESHOLD ?? '0.8') || 0.8),
);

if (!['openai', 'anthropic', 'openrouter', 'custom'].includes(providerName) || !primaryModel) {
  console.error(
    'Set KORY_CACHE_BENCH_PROVIDER=openai|anthropic|openrouter|custom and KORY_CACHE_BENCH_MODEL=<model>.',
  );
  process.exit(2);
}
if (providerName === 'custom' && !customBaseUrl) {
  console.error('KORY_CACHE_BENCH_BASE_URL is required when KORY_CACHE_BENCH_PROVIDER=custom.');
  process.exit(2);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required for this live benchmark.`);
    process.exit(2);
  }
  return value;
}

function buildProvider(): Provider {
  if (providerName === 'openai') {
    return new OpenAIProvider({
      name: 'openai',
      apiKey: requiredEnv('OPENAI_API_KEY'),
      disabled: false,
    });
  }
  if (providerName === 'anthropic') {
    return new AnthropicProvider({
      name: 'anthropic',
      apiKey: requiredEnv('ANTHROPIC_API_KEY'),
      disabled: false,
    });
  }
  if (providerName === 'openrouter') {
    return new OpenRouterProvider({
      name: 'openrouter',
      apiKey: requiredEnv('OPENROUTER_API_KEY'),
      disabled: false,
    });
  }
  return new CustomProvider({
    name: customProviderId,
    label: 'Cache switch benchmark endpoint',
    custom: true,
    kind: 'openai',
    baseUrl: customBaseUrl,
    apiKey: requiredEnv('KORY_CACHE_BENCH_API_KEY'),
    disabled: false,
    models: [...new Set([primaryModel, secondaryModel].filter(Boolean))],
  });
}

function stablePrefix(tokens: number): string {
  const line =
    'Kory universal cache matrix stable prefix. Keep this exact byte sequence reusable across switches. ';
  const chars = tokens * 4;
  let text = 'You are running a controlled Koryphaios cache-switch benchmark.\n';
  while (text.length < chars) text += line;
  return text.slice(0, chars);
}

function totalInput(event: ProviderEvent): number {
  const base = event.tokensIn ?? 0;
  return providerName === 'anthropic' ? base + (event.tokensCache ?? 0) : base;
}

const p = buildProvider();
await p.refreshModels?.(true);
const providerId = String(p.name);
const discoveredModel = p
  .listModels()
  .find((candidate) => candidate.id === primaryModel || candidate.apiModelId === primaryModel);
const reasoningCapabilityConfirmed = discoveredModel?.canReason === true;
const stableSystemPrompt = stablePrefix(stableTokenTarget);
const plan = createPromptCachePlan({
  stableSystemPrompt,
  providerAdapter: providerId,
  role: 'manager',
  workspaceScope: process.cwd(),
});
const tools: ProviderToolDef[] = [];
const canonicalTools = canonicalizeProviderTools(tools);
const toolAbiHash = sha256(JSON.stringify(canonicalTools));
const workspaceContextHash = sha256(`${plan.workspaceScopeHash ?? ''}\0${plan.stablePrefixHash}`);
const declaredCapabilities = getPromptCacheCapabilities({
  provider: providerId,
  custom: p.config.custom === true,
});
const forceSharedProbe =
  probeReasoning && declaredCapabilities.reasoningScope === 'probe' && reasoningCapabilityConfirmed;
const routingContext: PromptCacheRoutingContext = {
  provider: providerId,
  custom: p.config.custom === true,
  ...(forceSharedProbe ? { reasoningScopeOverride: 'shared' as const } : {}),
};

const steps: MatrixStep[] = [
  {
    label: 'cold-medium-act',
    model: primaryModel,
    reasoning: 'medium',
    mode: 'act',
    sessionId: 'matrix-tab-a',
  },
  {
    label: 'high-act',
    model: primaryModel,
    reasoning: 'high',
    mode: 'act',
    sessionId: 'matrix-tab-a',
  },
  {
    label: 'medium-return',
    model: primaryModel,
    reasoning: 'medium',
    mode: 'act',
    sessionId: 'matrix-tab-a',
  },
  {
    label: 'medium-plan',
    model: primaryModel,
    reasoning: 'medium',
    mode: 'plan',
    sessionId: 'matrix-tab-a',
  },
  {
    label: 'medium-act-return',
    model: primaryModel,
    reasoning: 'medium',
    mode: 'act',
    sessionId: 'matrix-tab-b',
  },
];
if (secondaryModel) {
  steps.push(
    {
      label: 'secondary-model',
      model: secondaryModel,
      reasoning: 'medium',
      mode: 'act',
      sessionId: 'matrix-tab-a',
    },
    {
      label: 'primary-switch-back',
      model: primaryModel,
      reasoning: 'medium',
      mode: 'act',
      sessionId: 'matrix-tab-a',
    },
  );
}

let previousLane: CacheLaneIdentity | undefined;
const seenRoutes = new Set<string>();

async function runTrial(step: MatrixStep): Promise<MatrixTrial> {
  const systemPrompt = `${stableSystemPrompt}\n\n[KORY_MATRIX_MODE ${step.mode}]`;
  const messages: ProviderMessage[] = [
    {
      role: 'user',
      content: `Return exactly: KORY_MATRIX_${step.label.toUpperCase().replaceAll('-', '_')}`,
    },
  ];
  const lane = derivePromptCacheLane(
    {
      model: step.model,
      reasoningLevel: step.reasoning,
      promptCache: plan,
      messages,
      sessionId: step.sessionId,
      harnessRole: 'manager',
      cacheLaneKind: 'manager',
    },
    canonicalTools,
    routingContext,
  );
  const routeSeenBefore = lane ? seenRoutes.has(lane.routingKey) : false;
  const sameRouteAsPrevious = !!lane && previousLane?.routingKey === lane.routingKey;
  const breakReasons =
    lane && previousLane ? explainCacheTransition(previousLane, lane) : ['new-lane'];
  const nativeLaneState: MatrixTrial['nativeLaneState'] = sameRouteAsPrevious
    ? 'warm-candidate'
    : routeSeenBefore
      ? 'retained-switch-back'
      : 'cold';

  const started = performance.now();
  let first: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheExpectedWarm: boolean | null = null;
  let cacheUnexpectedMiss = false;
  for await (const event of p.streamResponse({
    model: step.model,
    systemPrompt,
    messages,
    sessionId: step.sessionId,
    harnessRole: 'manager',
    cacheLaneKind: 'manager',
    promptCache: plan,
    promptCacheKeepaliveMode: 'off',
    reasoningLevel: step.reasoning,
    ...(forceSharedProbe ? { cacheReasoningScopeOverride: 'shared' as const } : {}),
    maxTokens: 12,
  })) {
    if (
      (event.type === 'content_delta' || event.type === 'thinking_delta') &&
      first === undefined
    ) {
      first = performance.now();
    }
    if (event.type === 'usage_update') {
      inputTokens = Math.max(inputTokens, totalInput(event));
      outputTokens = Math.max(outputTokens, event.tokensOut ?? 0);
      cacheReadTokens = Math.max(cacheReadTokens, event.tokensCacheRead ?? 0);
      cacheWriteTokens = Math.max(cacheWriteTokens, event.tokensCacheWrite ?? 0);
      if (event.cacheExpectedWarm !== undefined) cacheExpectedWarm = event.cacheExpectedWarm;
      cacheUnexpectedMiss ||= event.cacheUnexpectedMiss === true;
    }
    if (event.type === 'error')
      throw new Error(event.error ?? `Provider failed during ${step.label}`);
  }
  const latencyMs = performance.now() - started;
  const priced = computeCostUsd(p.name, step.model, inputTokens, outputTokens, {
    cacheReadTokens,
    cacheWriteTokens,
  });
  if (lane) seenRoutes.add(lane.routingKey);
  previousLane = lane;
  return {
    ...step,
    ttftMs: first === undefined ? null : first - started,
    latencyMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
    costUsd: priced?.costUsd ?? null,
    routeKey: lane?.routingKey ?? null,
    laneKey: lane?.key ?? null,
    nativeLaneState,
    breakReasons,
    toolAbiHash,
    workspaceContextHash,
    cacheExpectedWarm,
    cacheUnexpectedMiss,
  };
}

const trials: MatrixTrial[] = [];
for (const step of steps) trials.push(await runTrial(step));

const high = trials.find((trial) => trial.label === 'high-act');
const mediumReturn = trials.find((trial) => trial.label === 'medium-return');
const reasoningProbe = (() => {
  if (probeReasoning && !reasoningCapabilityConfirmed) {
    return {
      attempted: false as const,
      reason: 'model-reasoning-capability-not-confirmed' as const,
    };
  }
  if (!forceSharedProbe || !high || !mediumReturn) return { attempted: false as const };
  const samples = [high, mediumReturn];
  const telemetryObserved = samples.every(
    (sample) =>
      sample.inputTokens > 0 && (sample.cacheReadTokens > 0 || sample.cacheWriteTokens > 0),
  );
  const sharedConfirmed =
    telemetryObserved &&
    samples.every((sample) => sample.hitRate >= probeHitThreshold && !sample.cacheUnexpectedMiss);
  const isolatedConfirmed =
    telemetryObserved &&
    samples.some(
      (sample) =>
        sample.cacheUnexpectedMiss || (sample.cacheReadTokens === 0 && sample.cacheWriteTokens > 0),
    );
  const scope = sharedConfirmed
    ? ('shared' as const)
    : isolatedConfirmed
      ? ('isolated' as const)
      : null;
  if (recordReasoningProbe && scope) {
    writeProviderReasoningCacheProbe({
      provider: providerId,
      model: primaryModel,
      scope,
      samples: samples.length,
    });
  }
  return {
    attempted: true as const,
    telemetryObserved,
    threshold: probeHitThreshold,
    sharedConfirmed,
    isolatedConfirmed,
    persisted: recordReasoningProbe && scope !== null,
    scope,
  };
})();

function largeContextProjectionMatrix() {
  const payload = 'x'.repeat(3976);
  const messages: ProviderMessage[] = Array.from({ length: 500 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${index.toString().padStart(4, '0')}:${payload}`,
  }));
  const sourceContextKey = sha256('kory-cache-matrix-500k-canonical-context');
  const universalContextKey = sha256(`${workspaceContextHash}\0universal-context`);
  const project = (targetModel: string, targetWindow: number) =>
    planContextWindowProjection({
      sourceContextKey,
      universalContextKey,
      messages,
      targetModel,
      targetWindow,
      reservedOutputTokens: 16_384,
      stableOverheadTokens: stableTokenTarget,
    });
  const millionA = project('matrix-1m-model', 1_000_000);
  const smallA = project('matrix-256k-model', 256_000);
  const millionB = project('matrix-1m-model', 1_000_000);
  const smallB = project('matrix-256k-model', 256_000);
  return {
    canonicalInputTokens: projectionMessagesTokenUpperBound(messages),
    canonicalMessageCount: messages.length,
    canonicalSourcePreserved: messages.length === 500,
    sequence: [millionA, smallA, millionB, smallB].map((entry) => ({
      targetModel: entry.targetModel,
      targetWindow: entry.targetWindow,
      projectionRequired: entry.required,
      checkpointKey: entry.checkpointKey,
      checkpointSourceTokens: entry.checkpointSourceTokens,
      recentTailTokens: entry.recentTailTokens,
      targetInputBudget: entry.targetInputBudget,
    })),
    smallerWindowCheckpointReusable: smallA.checkpointKey === smallB.checkpointKey,
    fullWindowReturnsToCanonical: !millionA.required && !millionB.required,
  };
}

const report = {
  provider: providerName,
  providerId,
  primaryModel,
  ...(secondaryModel ? { secondaryModel } : {}),
  stableTokenTarget,
  generatedAt: new Date().toISOString(),
  modelCapability: discoveredModel
    ? {
        canReason: discoveredModel.canReason === true,
        reasoningLevels: discoveredModel.reasoningLevels ?? [],
        contextWindow: discoveredModel.contextWindow,
      }
    : null,
  declaredCapabilities,
  effectiveCapabilities: resolvePromptCacheCapabilities({
    provider: providerId,
    custom: p.config.custom === true,
    model: primaryModel,
  }),
  forceSharedReasoningProbe: forceSharedProbe,
  trials,
  reasoningProbe,
  largeContextProjection: largeContextProjectionMatrix(),
};

const output = process.env.KORY_CACHE_BENCH_OUTPUT?.trim();
if (output) writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (process.env.KORY_CACHE_BENCH_STRICT === '1') {
  const warmFailures = trials
    .slice(1)
    .filter(
      (trial) =>
        trial.nativeLaneState !== 'cold' && trial.inputTokens > 0 && trial.cacheReadTokens === 0,
    );
  const projection = report.largeContextProjection;
  if (
    warmFailures.length > 0 ||
    !projection.smallerWindowCheckpointReusable ||
    !projection.fullWindowReturnsToCanonical ||
    (reasoningProbe.attempted && !reasoningProbe.sharedConfirmed)
  ) {
    process.exit(1);
  }
}
