import type { ContextBreakdown } from './websocket/WSPayloads';

const OPAQUE_CONTEXT_PROVIDERS = new Set([
  'claude',
  'codex',
  'codex-auth',
  'grok',
  'antigravity',
  'cursor',
  'devin',
  'freebuff',
  'gemini-cli',
  'codebuff',
  'opencode',
]);

/** Native agent runtimes own context which Kory cannot fully inspect. */
export function hasOpaqueContextHarness(provider: string | undefined): boolean {
  return OPAQUE_CONTEXT_PROVIDERS.has(provider ?? '');
}

const INPUT_KEYS = ['system', 'memory', 'skills', 'tools', 'chat'] as const;
const tokens = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/** Reconcile heuristic categories to an authoritative occupancy without
 * inventing a remainder from tokenizer differences. Cache is a reuse property
 * of these same tokens, not an additional content category. */
export function reconcileContextBreakdown(
  breakdown: ContextBreakdown | undefined,
  used: number,
  provider?: string,
): ContextBreakdown {
  const total = tokens(used);
  const output = Math.min(total, tokens(breakdown?.output));
  const input = total - output;
  const result: ContextBreakdown = { system: 0, memory: 0, skills: 0, tools: 0, chat: 0, output };
  const weights = INPUT_KEYS.map((key) => tokens(breakdown?.[key]));
  const sum = weights.reduce((a, b) => a + b, 0);
  const opaque = hasOpaqueContextHarness(provider);
  const attributed = opaque ? Math.min(input, sum) : input;
  if (sum > 0) {
    // Largest-remainder rounding keeps every token accounted for, even when
    // input is tiny or the category estimate exceeds the reported window.
    const shares = weights.map((weight) => (attributed * weight) / sum);
    const counts = shares.map(Math.floor);
    const order = shares
      .map((share, index) => ({ index, fraction: share - counts[index] }))
      .sort((a, b) => b.fraction - a.fraction);
    const leftover = attributed - counts.reduce((a, b) => a + b, 0);
    for (let i = 0; i < leftover; i++) {
      counts[order[i].index]++;
    }
    INPUT_KEYS.forEach((key, index) => {
      result[key] = counts[index];
    });
  }
  const remaining = input - (sum > 0 ? attributed : 0);
  if (remaining > 0) {
    if (opaque) result.cliHarness = remaining;
    else result.request = remaining;
  }
  return result;
}

/** Band for a CLI's own native prefix (system prompt, tool schemas, MCP
 * instructions). Matches the 8k floor / 48k ceiling Kory already reserves for
 * Antigravity's native prefix (`antigravityPromptBudget`). */
export const CLI_HARNESS_ESTIMATE_FLOOR_TOKENS = 8_000;
export const CLI_HARNESS_ESTIMATE_CEILING_TOKENS = 48_000;

export interface BoundedOpaqueOccupancy {
  /** Occupancy to display: `used` unless the CLI harness remainder was capped. */
  used: number;
  /** True when `used` was lowered because the remainder could only be a
   * cumulative multi-request total, not one request's context. */
  harnessCapped: boolean;
  /** The cap applied to the CLI runtime overhead category, when capped. */
  harnessCap?: number;
}

/** Bound an opaque CLI's occupancy when the CLI only reported a cumulative
 * (estimated) turn total. That total counts the same prefix once per internal
 * request, so everything beyond Kory's measured categories would otherwise land
 * in `cliHarness` and balloon. The harness may be at most as large as what Kory
 * measured itself, kept inside the 8k–48k native-prefix band. Exact per-request
 * occupancy, non-CLI providers, and snapshots without a measured breakdown are
 * returned unchanged. */
export function boundOpaqueCumulativeOccupancy(
  breakdown: ContextBreakdown | undefined,
  used: number,
  provider: string | undefined,
  estimated: boolean | undefined,
): BoundedOpaqueOccupancy {
  const total = tokens(used);
  if (estimated !== true || !hasOpaqueContextHarness(provider) || !breakdown) {
    return { used: total, harnessCapped: false };
  }
  const measured = INPUT_KEYS.reduce((sum, key) => sum + tokens(breakdown[key]), 0);
  if (measured <= 0) return { used: total, harnessCapped: false };
  const output = Math.min(total, tokens(breakdown.output));
  const input = total - output;
  const harness = Math.max(0, input - measured);
  const cap = Math.min(
    CLI_HARNESS_ESTIMATE_CEILING_TOKENS,
    Math.max(CLI_HARNESS_ESTIMATE_FLOOR_TOKENS, measured),
  );
  if (harness <= cap) return { used: total, harnessCapped: false };
  return { used: measured + cap + output, harnessCapped: true, harnessCap: cap };
}
