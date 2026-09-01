import { createHash } from 'node:crypto';
import type { PromptCachePlan, ProviderToolDef, StreamRequest } from './types';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Build an opaque cache identity without leaking paths, goals, or account data. */
export function createPromptCachePlan(input: {
  stableSystemPrompt: string;
  providerAdapter: string;
  role: string;
}): PromptCachePlan {
  const stablePrefixHash = sha256(input.stableSystemPrompt);
  const routingHash = sha256(
    `kory-cache-v1\0${input.providerAdapter}\0${input.role}\0${stablePrefixHash}`,
  );
  return {
    version: 1,
    stableSystemPrompt: input.stableSystemPrompt,
    stablePrefixHash,
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
 * their ordered schema in the routing bucket so unrelated toolsets do not
 * contend for the same provider cache shard. */
export function deriveProviderPromptCacheKey(
  request: Pick<StreamRequest, 'model' | 'reasoningLevel' | 'promptCache'>,
  tools: ProviderToolDef[] = [],
): string | undefined {
  if (!request.promptCache) return undefined;
  const toolShape = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const hash = sha256(
    JSON.stringify({
      v: 1,
      base: request.promptCache.cacheKey,
      model: request.model,
      reasoning: request.reasoningLevel ?? '',
      tools: toolShape,
    }),
  );
  return `kory-${hash.slice(0, 48)}`;
}
