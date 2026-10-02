import type { ProviderRegistry } from '../backend/src/providers';
import { initTools } from '../backend/src/bootstrap';
import {
  createCacheLane,
  evaluateCacheWarmthEconomics,
  explainCacheTransitionDetails,
} from '../backend/src/providers/cache-fabric';
import {
  createPromptCachePlan,
  deriveProviderPromptCacheKey,
} from '../backend/src/providers/prompt-cache';
import { buildExposedToolset } from '../backend/src/tools/tool-exposure';
import { PromptCacheMaintenanceController } from '../backend/src/providers/cache-maintenance';

const providers = {
  get: () => undefined,
  getConfigs: () => ({}),
  executeWithRetry: async function* () {},
} as unknown as ProviderRegistry;

const registry = await initTools(providers);
const allTools = registry.getToolDefsForRole('manager');
const exposed = buildExposedToolset(allTools);
const fullSchemaChars = JSON.stringify(allTools).length;
const exposedSchemaChars = JSON.stringify(exposed).length;
const reduction = fullSchemaChars > 0 ? 1 - exposedSchemaChars / fullSchemaChars : 0;
// The exposure contract: every manager tool is callable by name on every turn,
// with no discovery step in front of it.
const exposedNames = new Set(exposed.map((tool) => tool.name));
const hiddenTools = allTools.filter((tool) => !exposedNames.has(tool.name)).map((t) => t.name);
const stubbedTools = exposed.filter(
  (tool) => JSON.stringify(tool.inputSchema) === JSON.stringify(exposed[0]?.inputSchema),
).length;

const laneBase = {
  baseCacheKey: 'benchmark-policy',
  stablePrefixHash: 'benchmark-prefix',
  sessionId: 'benchmark-session',
  kind: 'manager' as const,
  model: 'benchmark-model',
  reasoning: 'medium',
  toolFingerprint: 'tools-a',
  toolNames: ['read_file', 'grep'],
  stableComponentHashes: { role: 'role-a', style: 'style-a' },
};
const before = createCacheLane({ ...laneBase, messageFingerprints: ['m1', 'm2'] });
const appendOnly = createCacheLane({ ...laneBase, messageFingerprints: ['m1', 'm2', 'm3'] });
const rewritten = createCacheLane({
  ...laneBase,
  stablePrefixHash: 'benchmark-prefix-b',
  toolFingerprint: 'tools-b',
  toolNames: ['read_file', 'patch'],
  stableComponentHashes: { role: 'role-b', style: 'style-a' },
  messageFingerprints: ['m1', 'changed', 'm3'],
});
const appendDetails = explainCacheTransitionDetails(before, appendOnly);
const rewriteDetails = explainCacheTransitionDetails(before, rewritten);

const economical = evaluateCacheWarmthEconomics({
  stableTokens: 100_000,
  freshInputPerMillion: 10,
  cacheReadPerMillion: 1,
  cacheWritePerMillion: 20,
  refreshPerMillion: 1,
  expectedReuseProbability: 0.9,
  expectedReuseCount: 3,
});
const uneconomical = evaluateCacheWarmthEconomics({
  stableTokens: 50_000,
  freshInputPerMillion: 2,
  cacheReadPerMillion: 1.99,
  cacheWritePerMillion: 20,
  refreshPerMillion: 1.99,
  expectedReuseProbability: 0.5,
  expectedReuseCount: 1,
});
const expensiveFreshTail = evaluateCacheWarmthEconomics({
  stableTokens: 100_000,
  freshInputPerMillion: 10,
  cacheReadPerMillion: 1,
  cacheWritePerMillion: 2,
  refreshCachedTokens: 100_000,
  refreshFreshTokens: 900_000,
  expectedReuseProbability: 0.9,
  expectedReuseCount: 3,
});
const mostlyCachedReplay = evaluateCacheWarmthEconomics({
  stableTokens: 900_000,
  freshInputPerMillion: 10,
  cacheReadPerMillion: 1,
  cacheWritePerMillion: 2,
  refreshCachedTokens: 900_000,
  refreshFreshTokens: 100_000,
  expectedReuseProbability: 0.9,
  expectedReuseCount: 3,
});

const benchmarkTools = [
  { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
];
const workspacePlanA = createPromptCachePlan({
  stableSystemPrompt: 'benchmark stable system',
  providerAdapter: 'openai',
  role: 'manager',
  workspaceScope: '/benchmark/workspace-a',
});
const workspacePlanB = createPromptCachePlan({
  stableSystemPrompt: 'benchmark stable system',
  providerAdapter: 'openai',
  role: 'manager',
  workspaceScope: '/benchmark/workspace-b',
});
const workspaceTabAKey = deriveProviderPromptCacheKey(
  {
    model: 'gpt-5.6',
    reasoningLevel: 'medium',
    promptCache: workspacePlanA,
    sessionId: 'tab-a',
    harnessRole: 'manager',
  },
  benchmarkTools,
);
const workspaceTabBKey = deriveProviderPromptCacheKey(
  {
    model: 'gpt-5.6',
    reasoningLevel: 'medium',
    promptCache: workspacePlanA,
    sessionId: 'tab-b',
    harnessRole: 'manager',
  },
  benchmarkTools,
);
const otherWorkspaceKey = deriveProviderPromptCacheKey(
  {
    model: 'gpt-5.6',
    reasoningLevel: 'medium',
    promptCache: workspacePlanB,
    sessionId: 'tab-c',
    harnessRole: 'manager',
  },
  benchmarkTools,
);

let prewarmCalls = 0;
const maintenance = new PromptCacheMaintenanceController({
  clock: {
    now: () => 100_000,
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  },
});
maintenance.observe({
  provider: 'openai',
  sessionId: 'benchmark-session',
  routingKey: 'benchmark-route',
  slotKey: 'benchmark-slot',
  stableTokens: 100_000,
  ttlMs: 30 * 60_000,
  diagnostic: {
    state: 'warm-candidate',
    laneKey: 'benchmark-lane',
    routingKey: 'benchmark-route',
    laneKind: 'manager',
    reasons: [],
    details: {
      toolsAdded: [],
      toolsRemoved: [],
      toolSchemasChanged: false,
      stableComponentsChanged: [],
    },
    warmCandidateStreak: 2,
    workspaceReuseCount: 3,
    observedAt: 100_000,
  },
  pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 20 },
  refresh: async () => {
    prewarmCalls++;
  },
});
const prewarm = await maintenance.prewarmSession('benchmark-session');

let workspacePrewarmCalls = 0;
const workspaceMaintenance = new PromptCacheMaintenanceController({
  clock: {
    now: () => 100_000,
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  },
});
workspaceMaintenance.observe({
  provider: 'openai',
  sessionId: 'workspace-tab-a',
  routingKey: 'workspace-shared-route',
  slotKey: 'workspace-slot-a',
  stableTokens: 100_000,
  ttlMs: 30 * 60_000,
  diagnostic: {
    state: 'warm-candidate',
    laneKey: 'workspace-lane-a',
    routingKey: 'workspace-shared-route',
    laneKind: 'manager',
    reasons: [],
    details: {
      toolsAdded: [],
      toolsRemoved: [],
      toolSchemasChanged: false,
      stableComponentsChanged: [],
    },
    warmCandidateStreak: 2,
    workspaceReuseCount: 3,
    observedAt: 100_000,
  },
  pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 20 },
  refresh: async () => {
    workspacePrewarmCalls++;
  },
});
const siblingTabPrewarm = await workspaceMaintenance.prewarmRoute('workspace-shared-route');

const result = {
  managerToolCount: allTools.length,
  exposedToolCount: exposed.length,
  hiddenToolCount: hiddenTools.length,
  hiddenTools,
  stubbedToolCount: stubbedTools,
  fullSchemaChars,
  exposedSchemaChars,
  schemaCharsAvoided: fullSchemaChars - exposedSchemaChars,
  schemaReductionPct: Number((reduction * 100).toFixed(1)),
  everyToolExposedByName: hiddenTools.length === 0,
  appendOnlyPreservesHistory: appendDetails.historyRewriteAt === undefined,
  rewriteDetectedAtMessage:
    rewriteDetails.historyRewriteAt === undefined ? null : rewriteDetails.historyRewriteAt + 1,
  exactBreakAttribution: {
    toolsAdded: rewriteDetails.toolsAdded,
    toolsRemoved: rewriteDetails.toolsRemoved,
    stableComponentsChanged: rewriteDetails.stableComponentsChanged,
  },
  economicalRefreshAccepted: economical.keepWarm,
  uneconomicalRefreshRejected: !uneconomical.keepWarm,
  expensiveFreshTailRejected: !expensiveFreshTail.keepWarm,
  mostlyCachedReplayAccepted: mostlyCachedReplay.keepWarm,
  workspaceCacheSharedAcrossTabs: workspaceTabAKey === workspaceTabBKey,
  cacheIsolatedAcrossWorkspaces: workspaceTabAKey !== otherWorkspaceKey,
  siblingTabPrewarmTriggered: siblingTabPrewarm.triggered,
  siblingTabPrewarmCalls: workspacePrewarmCalls,
  typingPrewarmTriggered: prewarm.triggered,
  typingPrewarmCalls: prewarmCalls,
};

const failures: string[] = [];
if (result.hiddenToolCount > 0) {
  failures.push(`tools were hidden from the manager: ${result.hiddenTools.join(', ')}`);
}
if (result.everyToolExposedByName !== true)
  failures.push('not every manager tool was exposed by name');
if (reduction < 0.7)
  failures.push(`exposed schema reduction fell below 70% (${result.schemaReductionPct}%)`);
if (!result.appendOnlyPreservesHistory)
  failures.push('append-only history was misclassified as a rewrite');
if (result.rewriteDetectedAtMessage !== 2)
  failures.push('history rewrite position was not attributed exactly');
if (!economical.keepWarm) failures.push('positive-value keepalive was rejected');
if (uneconomical.keepWarm) failures.push('negative-value keepalive was accepted');
if (expensiveFreshTail.keepWarm)
  failures.push('full-replay economics accepted an expensive uncached tail');
if (!mostlyCachedReplay.keepWarm)
  failures.push('full-replay economics rejected a mostly-cached profitable replay');
if (workspaceTabAKey !== workspaceTabBKey)
  failures.push('same-workspace tabs did not share the provider cache route');
if (workspaceTabAKey === otherWorkspaceKey)
  failures.push('different workspaces shared a provider cache route');
if (!siblingTabPrewarm.triggered || workspacePrewarmCalls !== 1) {
  failures.push('a sibling tab could not refresh an established workspace cache route');
}
if (!prewarm.triggered || prewarmCalls !== 1)
  failures.push('typing prewarm did not refresh the active cache lane');
if (
  rewriteDetails.toolsAdded.join(',') !== 'patch' ||
  rewriteDetails.toolsRemoved.join(',') !== 'grep'
) {
  failures.push('tool-set cache break was not attributed exactly');
}
if (rewriteDetails.stableComponentsChanged.join(',') !== 'role') {
  failures.push('stable system-component cache break was not attributed exactly');
}

console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) {
  console.error(`Cache benchmark failed: ${failures.join('; ')}`);
  process.exit(1);
}
