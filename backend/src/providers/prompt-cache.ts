import { createHash } from 'node:crypto';
import type { PromptCacheLaneKind, PromptCachePlan, ProviderToolDef, StreamRequest } from './types';
import {
  resolvePromptCacheCapabilities,
  type PromptCacheRoutingContext,
} from './cache-capabilities';
import {
  createCacheLane,
  promptCacheDiagnostics,
  type CacheDispatchDiagnostic,
  type CacheLaneIdentity,
} from './cache-fabric';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalizeJson(record[key])]),
  );
}

/** Provider tool declarations are semantically a set, but provider prompt
 * caches see their serialized order. Canonicalize both the declaration order
 * and nested schema keys so equivalent tool belts produce byte-stable wires. */
export function canonicalizeProviderTools(tools: ProviderToolDef[] = []): ProviderToolDef[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: canonicalizeJson(tool.inputSchema) as ProviderToolDef['inputSchema'],
    }))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      const byDescription = a.description.localeCompare(b.description);
      if (byDescription !== 0) return byDescription;
      return JSON.stringify(a.inputSchema).localeCompare(JSON.stringify(b.inputSchema));
    });
}

function cacheLaneKind(
  request: Pick<StreamRequest, 'cacheLaneKind' | 'harnessRole' | 'capabilityProfile'>,
): PromptCacheLaneKind {
  if (request.cacheLaneKind) return request.cacheLaneKind;
  if (request.capabilityProfile === 'research-only') return 'research';
  if (request.harnessRole === 'manager') return 'manager';
  if (request.harnessRole === 'worker') return 'worker';
  if (request.harnessRole === 'critic') return 'critic';
  return 'default';
}

export function derivePromptCacheLane(
  request: Pick<
    StreamRequest,
    | 'model'
    | 'reasoningLevel'
    | 'promptCache'
    | 'sessionId'
    | 'harnessRole'
    | 'capabilityProfile'
    | 'cacheLaneKind'
  > &
    Partial<Pick<StreamRequest, 'messages'>>,
  tools: ProviderToolDef[] = [],
  routingContext: PromptCacheRoutingContext = {},
): CacheLaneIdentity | undefined {
  if (!request.promptCache) return undefined;
  const canonicalTools = canonicalizeProviderTools(tools);
  const toolFingerprint = sha256(JSON.stringify(canonicalTools));
  const capabilities = resolvePromptCacheCapabilities({
    ...routingContext,
    model: request.model,
  });
  const messageFingerprints = (request.messages ?? []).map((message) =>
    sha256(JSON.stringify(canonicalizeJson(message))),
  );
  return createCacheLane({
    baseCacheKey: request.promptCache.cacheKey,
    stablePrefixHash: request.promptCache.stablePrefixHash,
    sessionId: request.sessionId,
    kind: cacheLaneKind(request),
    model: request.model,
    reasoning: request.reasoningLevel,
    reasoningScope: capabilities.effectiveReasoningScope,
    toolFingerprint,
    toolNames: canonicalTools.map((tool) => tool.name),
    messageFingerprints,
    stableComponentHashes: request.promptCache.stableComponentHashes,
  });
}

export function observePromptCacheDispatch(
  request: Pick<
    StreamRequest,
    | 'model'
    | 'reasoningLevel'
    | 'promptCache'
    | 'sessionId'
    | 'harnessRole'
    | 'capabilityProfile'
    | 'cacheLaneKind'
  > &
    Partial<Pick<StreamRequest, 'messages'>>,
  tools: ProviderToolDef[] = [],
  routingContext: PromptCacheRoutingContext = {},
): CacheDispatchDiagnostic | undefined {
  const lane = derivePromptCacheLane(request, tools, routingContext);
  return lane ? promptCacheDiagnostics.observe(lane) : undefined;
}

/** Build an opaque cache identity without leaking paths, goals, or account data. */
export function createPromptCachePlan(input: {
  stableSystemPrompt: string;
  providerAdapter: string;
  role: string;
  workspaceScope?: string;
  stableComponents?: Record<string, string>;
}): PromptCachePlan {
  const stablePrefixHash = sha256(input.stableSystemPrompt);
  const workspaceScopeHash = input.workspaceScope
    ? sha256(`workspace\0${input.workspaceScope}`)
    : undefined;
  const routingHash = sha256(
    `kory-cache-v2\0${input.providerAdapter}\0${input.role}\0${workspaceScopeHash ?? 'unscoped'}\0${stablePrefixHash}`,
  );
  return {
    version: 1,
    stableSystemPrompt: input.stableSystemPrompt,
    stablePrefixHash,
    workspaceScopeHash,
    stableComponentHashes: Object.fromEntries(
      Object.entries(input.stableComponents ?? {}).map(([name, value]) => [name, sha256(value)]),
    ),
    cacheKey: `kory-${routingHash.slice(0, 48)}`,
    strategy: 'hierarchical',
    ttl: '5m',
    // Diagnostic only. Provider tokenizers remain authoritative.
    estimatedStableTokens: Math.ceil(Buffer.byteLength(input.stableSystemPrompt, 'utf8') / 4),
  };
}

export interface ResolvedPromptCacheSegments {
  stable: string;
  dynamic: string;
  valid: boolean;
}

/** A stale or forged plan must never change prompt contents. */
export function resolvePromptCacheSegments(
  request: Pick<StreamRequest, 'systemPrompt' | 'promptCache'>,
): ResolvedPromptCacheSegments {
  const plan = request.promptCache;
  if (
    !plan ||
    plan.version !== 1 ||
    sha256(plan.stableSystemPrompt) !== plan.stablePrefixHash ||
    !request.systemPrompt.startsWith(plan.stableSystemPrompt)
  ) {
    return { stable: request.systemPrompt, dynamic: '', valid: false };
  }
  return {
    stable: plan.stableSystemPrompt,
    dynamic: request.systemPrompt.slice(plan.stableSystemPrompt.length),
    valid: true,
  };
}

/** Tool definitions precede instructions on major provider wires. Include
 * their canonical schema in the routing bucket so unrelated toolsets do not
 * contend for the same provider cache shard while equivalent tool belts keep
 * their affinity even if registration order changes. */
export function deriveProviderPromptCacheKey(
  request: Pick<
    StreamRequest,
    | 'model'
    | 'reasoningLevel'
    | 'promptCache'
    | 'sessionId'
    | 'harnessRole'
    | 'capabilityProfile'
    | 'cacheLaneKind'
  >,
  tools: ProviderToolDef[] = [],
  routingContext: PromptCacheRoutingContext = {},
): string | undefined {
  if (!request.promptCache) return undefined;
  const toolShape = canonicalizeProviderTools(tools);
  const lane = derivePromptCacheLane(request, toolShape, routingContext);
  const hash = sha256(
    JSON.stringify({
      v: 3,
      route: lane?.routingKey ?? request.promptCache.cacheKey,
    }),
  );
  return `kory-${hash.slice(0, 48)}`;
}
