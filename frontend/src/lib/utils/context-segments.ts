import { reconcileContextBreakdown, type ContextBreakdown } from '@koryphaios/shared';

const CATEGORIES = [
  {
    key: 'system',
    label: 'System prompt',
    color: '#8b5cf6',
    hint: 'Standing instructions and persona sent with the request.',
  },
  {
    key: 'memory',
    label: 'Memory',
    color: '#14b8a6',
    hint: 'Durable notes, facts, and retrieved research context.',
  },
  {
    key: 'skills',
    label: 'Skills',
    color: '#a78bfa',
    hint: 'Workflow guidance from the skills attached to this session.',
  },
  {
    key: 'tools',
    label: 'Tools',
    color: '#f59e0b',
    hint: 'Tool definitions, calls, and results in the context.',
  },
  {
    key: 'chat',
    label: 'Chat',
    color: '#3b82f6',
    hint: 'Your messages and earlier agent replies.',
  },
  {
    key: 'output',
    label: 'Output',
    color: '#f472b6',
    hint: 'Generated output in this usage report.',
  },
  {
    key: 'cliHarness',
    label: 'CLI runtime overhead',
    color: '#9ca3af',
    hint: 'Instructions, tool schemas, MCP/runtime instructions, and internal agent history owned by the CLI. The CLI reports only the total, so this category is estimated.',
  },
  {
    key: 'request',
    label: 'Request context',
    color: '#64748b',
    hint: 'Provider-counted request context. This saved report has no category breakdown; a new turn supplies one.',
  },
] as const;

export type ContextMeterUsage = {
  used: number;
  max: number;
  isReliable: boolean;
  estimated?: boolean;
  provider?: string;
  breakdown?: ContextBreakdown;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export function buildContextSegments(usage: ContextMeterUsage) {
  if (!usage.isReliable || usage.max <= 0 || usage.used <= 0) return null;
  const breakdown = reconcileContextBreakdown(usage.breakdown, usage.used, usage.provider);
  const perToken = Math.min(100, (usage.used / usage.max) * 100) / usage.used;
  return CATEGORIES.map((category) => ({
    ...category,
    tokens: breakdown[category.key] ?? 0,
    widthPercent: (breakdown[category.key] ?? 0) * perToken,
  })).filter((category) => category.tokens > 0);
}

/** Cache reads overlap the content categories; they must never widen the bar.
 * Cumulative/approximate turn usage cannot prove a live cache footprint. */
export function contextCacheStatus(usage: ContextMeterUsage) {
  const read = Math.max(0, usage.cachedInputTokens ?? 0);
  const write = Math.max(0, usage.cacheWriteInputTokens ?? 0);
  const output = Math.min(usage.used, Math.max(0, usage.breakdown?.output ?? 0));
  const input = Math.max(0, usage.used - output);
  const known = usage.isReliable && !usage.estimated && read + write <= input;
  const resident = known ? read + write : 0;
  return {
    resident,
    widthPercent: known && usage.max > 0 ? Math.min(100, (resident / usage.max) * 100) : 0,
    label:
      read + write <= 0
        ? ''
        : known
          ? `${resident.toLocaleString()} cache tokens in context · included in total`
          : 'Cache reuse reported for the turn · live context share not reported',
    hint: known
      ? 'Cache reads and writes occupy the same input context as the categories above. The striped portion overlaps them; it is counted once. Cache entries stored outside this request do not occupy this window.'
      : 'This report is approximate or cumulative across CLI requests. Cache reuse is real, but the provider does not identify how much is in the current window. Stored cache outside a request does not occupy that window.',
  };
}
