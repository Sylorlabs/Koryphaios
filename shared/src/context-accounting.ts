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
