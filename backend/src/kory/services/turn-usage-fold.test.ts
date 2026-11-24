import { describe, expect, test } from 'bun:test';
import { boundOpaqueCumulativeOccupancy, reconcileContextBreakdown } from '@koryphaios/shared';
import type { ProviderConfig } from '@koryphaios/shared';
import type { ProviderEvent } from '../../providers/types';
import { ClaudeCodeProvider } from '../../providers/claude-code';
import { CursorProvider } from '../../providers/cursor';
import { codexJsonEvents } from '../../providers/codex-cli';
import { trajectoryToEvents } from '../../providers/devin-bridge';
import { parseAntigravityStreamLine } from '../../providers/antigravity';
import { TurnUsageFold } from './turn-usage-fold';

/** Kory's own measured categories for the turn (what the manager sent). */
const BREAKDOWN = {
  system: 6_000,
  memory: 1_000,
  skills: 500,
  tools: 2_500,
  chat: 4_000,
  output: 0,
};
const MEASURED = 14_000;

function fold(events: ProviderEvent[]) {
  const f = new TurnUsageFold();
  for (const event of events) f.apply(event);
  return f;
}

/** The meter value: occupancy (+output), then the accounting-layer bound. */
function meter(events: ProviderEvent[], provider: string) {
  const f = fold(events);
  const used = f.tokensIn + f.tokensOut;
  // The manager patches the reported output into the breakdown (applyUsageOutput).
  const breakdown = { ...BREAKDOWN, output: f.tokensOut };
  const bounded = boundOpaqueCumulativeOccupancy(breakdown, used, provider, f.estimated);
  const segments = reconcileContextBreakdown(breakdown, bounded.used, provider);
  return { fold: f, used: bounded.used, bounded, cliHarness: segments.cliHarness ?? 0 };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe('CLI turns with three internal requests', () => {
  test('claude: message_start snapshots win over the cumulative result receipt', () => {
    const provider = new ClaudeCodeProvider({ name: 'claude' } as ProviderConfig);
    const map = (envelope: unknown) => [
      ...(
        provider as unknown as {
          mapEnvelope: (e: unknown, p: Map<string, unknown>) => Iterable<ProviderEvent>;
        }
      ).mapEnvelope(envelope, new Map()),
    ];
    // Three requests: 20k, 24k, 28k of context (input + cache read + write).
    const requests = [
      { input_tokens: 2_000, cache_read_input_tokens: 17_000, cache_creation_input_tokens: 1_000 },
      { input_tokens: 1_000, cache_read_input_tokens: 21_000, cache_creation_input_tokens: 2_000 },
      { input_tokens: 1_500, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 1_500 },
    ];
    const events = requests.flatMap((usage) =>
      map({
        type: 'stream_event',
        event: { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } },
      }),
    );
    const totals = {
      input_tokens: sum(requests.map((r) => r.input_tokens)),
      cache_read_input_tokens: sum(requests.map((r) => r.cache_read_input_tokens)),
      cache_creation_input_tokens: sum(requests.map((r) => r.cache_creation_input_tokens)),
      output_tokens: 900,
    };
    const receipt = map({ type: 'result', subtype: 'success', is_error: false, usage: totals });
    expect(receipt[0]).toMatchObject({
      type: 'usage_update',
      estimated: true,
      billingTokensIn: 72_000,
      billingTokensOut: 900,
    });

    const result = meter([...events, ...receipt], 'claude');
    expect(result.fold.tokensIn).toBe(28_000);
    expect(result.fold.estimated).toBe(false);
    expect(result.fold.cachedInputTokens).toBe(25_000);
    expect(result.used).toBe(28_001);
    expect(result.used).not.toBe(72_000 + 900);
    expect(result.cliHarness).toBe(28_000 - MEASURED);
  });

  test('devin: the latest ATIF step is occupancy; final_metrics totals stay billing evidence', () => {
    const step = (prompt: number, cached: number) => ({
      source: 'agent',
      message: '',
      metrics: { prompt_tokens: prompt, completion_tokens: 200, cached_tokens: cached },
    });
    const steps = [step(30_000, 29_000), step(34_000, 33_000), step(38_000, 37_000)];
    const events = trajectoryToEvents({
      steps,
      finalMetrics: {
        promptTokens: 102_000,
        completionTokens: 600,
        cachedTokens: 99_000,
        totalSteps: 3,
      },
    });
    expect(events.at(-1)).toMatchObject({
      estimated: true,
      billingTokensIn: 102_000,
      tokensCacheRead: 99_000,
    });
    const result = meter(events, 'devin');
    expect(result.fold.tokensIn).toBe(38_000);
    expect(result.fold.estimated).toBe(false);
    expect(result.used).toBe(38_200);
    expect(result.cliHarness).toBe(38_000 - MEASURED);
  });

  test('devin: an export without per-step metrics is an estimate whose CLI overhead is bounded', () => {
    const events = trajectoryToEvents({
      steps: [{ source: 'agent', message: 'done' }],
      finalMetrics: { promptTokens: 102_000, completionTokens: 600, totalSteps: 3 },
    });
    const result = meter(events, 'devin');
    expect(result.fold.estimated).toBe(true);
    expect(result.bounded.harnessCapped).toBe(true);
    expect(result.cliHarness).toBe(MEASURED);
    expect(result.used).toBeLessThan(102_600);
  });

  test('opencode: ACP usage_update `used` is occupancy; the cumulative prompt receipt carries no tokensIn', () => {
    // Event shapes emitted by opencode-cli.ts for usage_update and the final receipt.
    const result = meter(
      [
        {
          type: 'usage_update',
          tokensIn: 20_000,
          usagePrecision: 'provider-reported',
          estimated: false,
        },
        {
          type: 'usage_update',
          tokensIn: 24_000,
          usagePrecision: 'provider-reported',
          estimated: false,
        },
        {
          type: 'usage_update',
          tokensIn: 28_000,
          usagePrecision: 'provider-reported',
          estimated: false,
        },
        { type: 'usage_update', estimated: true, billingTokensIn: 72_000, billingTokensOut: 500 },
      ],
      'opencode',
    );
    expect(result.fold.tokensIn).toBe(28_000);
    // The billing-only receipt must not flag exact occupancy as estimated.
    expect(result.fold.estimated).toBe(false);
    expect(result.used).toBe(28_000);
  });

  test('freebuff: the final request-log context is occupancy, not the summed samples', () => {
    const samples = [20_000, 24_000, 28_000];
    const result = meter(
      [
        {
          type: 'usage_update',
          tokensIn: samples.at(-1),
          tokensOut: 0,
          billingTokensIn: sum(samples),
          billingUsageSamples: samples.map((tokensIn) => ({ tokensIn, tokensOut: 0 })),
          usagePrecision: 'input-context-only',
        },
      ],
      'freebuff',
    );
    expect(result.used).toBe(28_000);
    expect(result.fold.estimated).toBe(false);
  });

  test('codex: a cumulative-only turn total is estimated and its CLI overhead is bounded', () => {
    const cumulative = 20_000 + 24_000 + 28_000;
    const { events } = codexJsonEvents(
      {
        type: 'turn.completed',
        usage: { input_tokens: cumulative, cached_input_tokens: 60_000, output_tokens: 400 },
      },
      [],
    );
    const result = meter(events, 'codex');
    expect(result.fold.estimated).toBe(true);
    expect(result.bounded.harnessCapped).toBe(true);
    expect(result.cliHarness).toBe(MEASURED);
    expect(result.used).toBe(MEASURED * 2 + 400);
    expect(result.used).toBeLessThan(cumulative);
  });

  test('cursor: the result receipt is estimated and bounded, with billing evidence intact', () => {
    const provider = new CursorProvider({ name: 'cursor' } as ProviderConfig);
    const events = [
      ...(provider as unknown as { mapLine: (row: unknown) => Iterable<ProviderEvent> }).mapLine({
        type: 'result',
        usage: { inputTokens: 72_000, outputTokens: 400, cacheReadTokens: 60_000 },
      }),
    ];
    expect(events[0]).toMatchObject({
      estimated: true,
      billingTokensIn: 72_000,
      billingTokensOut: 400,
    });
    const result = meter(events, 'cursor');
    expect(result.bounded.harnessCapped).toBe(true);
    expect(result.cliHarness).toBe(MEASURED);
  });

  test('antigravity: the turn receipt is estimated and bounded', () => {
    const events = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          usage: { input_tokens: 60_000, output_tokens: 300, cache_read_tokens: 12_000 },
        },
      }),
    );
    const result = meter(events, 'antigravity');
    expect(result.bounded.harnessCapped).toBe(true);
    expect(result.cliHarness).toBe(MEASURED);
  });
});

describe('TurnUsageFold for API providers', () => {
  test('keeps one request’s input and lets a later output-only event refine the output', () => {
    const f = fold([
      {
        type: 'usage_update',
        tokensIn: 500,
        tokensCache: 9_500,
        tokensOut: 1,
        tokensCacheRead: 9_500,
      },
      { type: 'usage_update', tokensOut: 320 },
    ]);
    expect(f).toMatchObject({
      tokensIn: 10_000,
      tokensOut: 320,
      cachedInputTokens: 9_500,
      estimated: false,
    });
  });

  test('a zero placeholder never erases a real snapshot', () => {
    const f = fold([
      { type: 'usage_update', tokensIn: 12_000, tokensOut: 10 },
      { type: 'usage_update', tokensIn: 0, tokensOut: 0 },
    ]);
    expect(f.tokensIn).toBe(12_000);
  });

  test('latest snapshot wins after a mid-turn compaction', () => {
    const f = fold([
      { type: 'usage_update', tokensIn: 180_000 },
      { type: 'usage_update', tokensIn: 40_000 },
    ]);
    expect(f.tokensIn).toBe(40_000);
  });
});
