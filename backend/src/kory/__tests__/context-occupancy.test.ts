import { afterEach, describe, expect, test } from 'bun:test';
import type { ModelDef } from '@koryphaios/shared';
import { registerLiveModelResolver } from '../../providers/models';
import { resolveLiveOccupancy } from '../context-occupancy';

function liveWindow(contextWindow: number): ModelDef {
  return {
    id: 'gpt-codex',
    name: 'gpt-codex',
    provider: 'codex',
    contextWindow,
    contextVerified: true,
    maxOutputTokens: 16_384,
    supportsStreaming: true,
  };
}

afterEach(() => {
  registerLiveModelResolver(() => undefined);
});

describe('compaction context-occupancy resolveLiveOccupancy', () => {
  test('clamps an impossible cumulative total to the window and marks it estimated', () => {
    registerLiveModelResolver(() => liveWindow(285_000));
    // The reported meter bug: 860.3k cumulative input on a 285.0k window.
    const occupancy = resolveLiveOccupancy({
      tokensIn: 860_300,
      tokensOut: 1_200,
      model: 'gpt-codex',
      provider: 'codex',
      usageKnown: true,
      estimated: true,
    });
    expect(occupancy.tokensUsed).toBe(285_000);
    expect(occupancy.tokensUsed).toBeLessThanOrEqual(285_000);
    expect(occupancy.estimated).toBe(true);
    expect(occupancy.usageKnown).toBe(true);
    expect(occupancy.contextKnown).toBe(true);
  });

  test('clamps even unflagged totals that exceed the window', () => {
    registerLiveModelResolver(() => liveWindow(285_000));
    const occupancy = resolveLiveOccupancy({
      tokensIn: 400_000,
      tokensOut: 0,
      model: 'gpt-codex',
      provider: 'codex',
      usageKnown: true,
    });
    expect(occupancy.tokensIn).toBe(285_000);
    expect(occupancy.tokensUsed).toBe(285_000);
    expect(occupancy.estimated).toBe(true);
  });

  test('passes exact in-window usage through untouched', () => {
    registerLiveModelResolver(() => liveWindow(1_000_000));
    const occupancy = resolveLiveOccupancy({
      tokensIn: 211_000,
      tokensOut: 700,
      model: 'gpt-codex',
      provider: 'codex',
      usageKnown: true,
    });
    expect(occupancy).toMatchObject({
      tokensIn: 211_000,
      tokensOut: 700,
      tokensUsed: 211_700,
      usageKnown: true,
      estimated: false,
      contextKnown: true,
      contextWindow: 1_000_000,
    });
  });

  test('keeps a provider-flagged estimate marked even under the window', () => {
    registerLiveModelResolver(() => liveWindow(1_000_000));
    const occupancy = resolveLiveOccupancy({
      tokensIn: 50_000,
      tokensOut: 500,
      model: 'gpt-codex',
      provider: 'codex',
      usageKnown: true,
      estimated: true,
    });
    expect(occupancy.tokensUsed).toBe(50_500);
    expect(occupancy.estimated).toBe(true);
  });

  test('passes usage through unclamped when the window is unknown', () => {
    const occupancy = resolveLiveOccupancy({
      tokensIn: 860_300,
      tokensOut: 1_200,
      model: 'unknown-model',
      provider: 'codex',
      usageKnown: true,
    });
    expect(occupancy.tokensUsed).toBe(861_500);
    expect(occupancy.estimated).toBe(false);
    expect(occupancy.contextKnown).toBe(false);
  });

  test('fails closed to zero when usage is unknown', () => {
    registerLiveModelResolver(() => liveWindow(285_000));
    const occupancy = resolveLiveOccupancy({
      tokensIn: 860_300,
      tokensOut: 1_200,
      model: 'gpt-codex',
      provider: 'codex',
      usageKnown: false,
    });
    expect(occupancy).toMatchObject({
      tokensIn: 0,
      tokensOut: 0,
      tokensUsed: 0,
      usageKnown: false,
      estimated: true,
      contextKnown: true,
    });
  });
});
