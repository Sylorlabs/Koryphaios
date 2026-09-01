import { describe, expect, it } from 'vitest';
import {
  chooseVariantRepresentative,
  exactModelSelection,
  observedRunOutcome,
  parseMessageDisplayProjection,
  type DisplayMessage,
} from './message-variants';

function variant(id: string, index: number, isActive = false): DisplayMessage {
  return {
    id,
    role: 'assistant',
    content: `answer ${id}`,
    createdAt: 100 + index,
    model: `model-${id}`,
    provider: `provider-${id}`,
    variantGroupId: 'response-prompt-1',
    variantIndex: index,
    isActive,
  };
}

describe('message display projection', () => {
  it('preserves provider identity and authoritative branch metadata', () => {
    const projection = parseMessageDisplayProjection({
      messages: [variant('v0', 0), { ...variant('v1', 1), isActiveBranch: true }],
      activeMessageId: 'v1',
      conversationRevision: 7,
      providerConversationRevision: 3,
    });

    expect(projection.boundary).toEqual({
      activeMessageId: 'v1',
      conversationRevision: 7,
      providerConversationRevision: 3,
      authoritative: true,
    });
    expect(projection.messages[1]).toMatchObject({
      id: 'v1',
      provider: 'provider-v1',
      model: 'model-v1',
      isActive: true,
    });
  });

  it('keeps legacy arrays readable without manufacturing CAS authority', () => {
    const projection = parseMessageDisplayProjection([variant('v0', 0), variant('v2', 2)]);
    expect(projection.messages.map((message) => message.id)).toEqual(['v0', 'v2']);
    expect(projection.boundary.authoritative).toBe(false);
    expect(projection.boundary.activeMessageId).toBeNull();
  });
});

describe('variant authority', () => {
  const boundary = {
    activeMessageId: 'later-follow-up',
    conversationRevision: 8,
    providerConversationRevision: 4,
    authoritative: true,
  } as const;

  it('renders the active-lineage sibling instead of index zero or the newest sibling', () => {
    const choice = chooseVariantRepresentative(
      [variant('v2', 2), variant('v0', 0), variant('v1', 1, true)],
      boundary,
    );
    expect(choice.variants.map((message) => message.id)).toEqual(['v0', 'v1', 'v2']);
    expect(choice.representative.id).toBe('v1');
    expect(choice.activeVariantId).toBe('v1');
    expect(choice.authoritative).toBe(true);
  });

  it('uses a stable display fallback but disables activation when lineage identity is absent', () => {
    const choice = chooseVariantRepresentative(
      [variant('v2', 2), variant('v0', 0), variant('v1', 1)],
      boundary,
    );
    expect(choice.representative.id).toBe('v0');
    expect(choice.activeVariantId).toBeNull();
    expect(choice.authoritative).toBe(false);
  });

  it('keeps provider and model together for selected-variant regeneration', () => {
    expect(exactModelSelection('openrouter', 'anthropic/claude-sonnet')).toBe(
      'openrouter:anthropic/claude-sonnet',
    );
    expect(exactModelSelection('openrouter', 'openrouter:anthropic/claude-sonnet')).toBe(
      'openrouter:anthropic/claude-sonnet',
    );
  });
});

describe('regeneration run observation', () => {
  it('ignores another run and completes only the returned runId', () => {
    expect(observedRunOutcome({ runId: 'old', phase: 'done' }, 'regen')).toEqual({
      kind: 'pending',
    });
    expect(observedRunOutcome({ runId: 'regen', phase: 'done' }, 'regen')).toEqual({
      kind: 'complete',
    });
  });

  it('surfaces authoritative failure and cancellation immediately', () => {
    expect(
      observedRunOutcome(
        { runId: 'regen', phase: 'error', terminalReason: 'provider_failed' },
        'regen',
      ),
    ).toEqual({ kind: 'failed', reason: 'provider_failed' });
    expect(
      observedRunOutcome(
        { runId: 'regen', phase: 'cancelled', terminalReason: 'cancelled_by_user' },
        'regen',
      ),
    ).toEqual({ kind: 'cancelled', reason: 'cancelled_by_user' });
  });
});
