import { describe, expect, test } from 'vitest';
import type { SessionRunSnapshot, WSMessage } from '@koryphaios/shared';
import { isImmediateOrderedErrorDuplicate, sequencedTerminalRunFailure } from './run-failure-feed';

const SESSION_ID = 'run-failure-feed-test';
const ERROR_TEXT = 'backend_restarted_during_active_run';

function failedRunMessage(overrides: Partial<WSMessage> = {}): WSMessage {
  const snapshot: SessionRunSnapshot = {
    sessionId: SESSION_ID,
    runId: 'run-1',
    revision: 4,
    phase: 'error',
    status: 'terminal',
    waitingReason: '',
    continuationId: null,
    activeAgentIds: [],
    startedAt: 100,
    updatedAt: 1_000,
    finishedAt: 1_000,
    terminalReason: ERROR_TEXT,
  };
  return {
    type: 'run.state',
    sessionId: SESSION_ID,
    eventId: 'run-failed-1',
    epoch: 1,
    sequence: 1,
    timestamp: 1_000,
    payload: { snapshot, transition: null },
    ...overrides,
  };
}

describe('durable run failure feed projection', () => {
  test('accepts only a sequenced terminal error for the active session', () => {
    expect(sequencedTerminalRunFailure(failedRunMessage(), SESSION_ID)).toMatchObject({
      reason: ERROR_TEXT,
      snapshot: { runId: 'run-1', revision: 4 },
    });
    expect(sequencedTerminalRunFailure(failedRunMessage({ sequence: undefined }), SESSION_ID)).toBe(
      null,
    );
    expect(sequencedTerminalRunFailure(failedRunMessage(), 'another-session')).toBe(null);
    expect(
      sequencedTerminalRunFailure(
        failedRunMessage({
          payload: {
            snapshot: {
              ...(failedRunMessage().payload as { snapshot: SessionRunSnapshot }).snapshot,
              terminalReason: '   ',
            },
            transition: null,
          },
        }),
        SESSION_ID,
      ),
    ).toBe(null);
  });

  test('dedupes an adjacent ordered system.error independent of wall-clock time', () => {
    const followingError = {
      type: 'system.error',
      sessionId: SESSION_ID,
      epoch: 1,
      sequence: 2,
      timestamp: 10_000,
      payload: { error: ERROR_TEXT },
    } satisfies WSMessage;
    const projectedCard = {
      type: 'error',
      text: ERROR_TEXT,
      metadata: { eventEpoch: 1, sequenceStart: 1, sequenceEnd: 1 },
    };

    expect(isImmediateOrderedErrorDuplicate(projectedCard, followingError, ERROR_TEXT)).toBe(true);
    expect(
      isImmediateOrderedErrorDuplicate(
        projectedCard,
        { ...followingError, sequence: 3 },
        ERROR_TEXT,
      ),
    ).toBe(false);
  });

  test('dedupes only proven human-error then technical-run-failure pairs', () => {
    const humanErrorCard = {
      type: 'error',
      text: 'No configured provider can run the selected model.',
      metadata: {
        sourceEvent: 'system.error',
        eventEpoch: 3,
        sequenceStart: 40,
        sequenceEnd: 40,
      },
    };
    const providerFailure = failedRunMessage({
      epoch: 3,
      sequence: 41,
      payload: {
        snapshot: {
          ...(failedRunMessage().payload as { snapshot: SessionRunSnapshot }).snapshot,
          terminalReason: 'provider_unavailable',
        },
        transition: null,
      },
    });
    const spendFailure = failedRunMessage({
      epoch: 3,
      sequence: 41,
      payload: {
        snapshot: {
          ...(failedRunMessage().payload as { snapshot: SessionRunSnapshot }).snapshot,
          terminalReason: 'spend_policy_blocked',
        },
        transition: null,
      },
    });

    expect(
      isImmediateOrderedErrorDuplicate(humanErrorCard, providerFailure, 'provider_unavailable'),
    ).toBe(true);
    expect(
      isImmediateOrderedErrorDuplicate(humanErrorCard, spendFailure, 'spend_policy_blocked'),
    ).toBe(true);
    expect(
      isImmediateOrderedErrorDuplicate(
        humanErrorCard,
        { ...providerFailure, sequence: 42 },
        'provider_unavailable',
      ),
    ).toBe(false);
    expect(
      isImmediateOrderedErrorDuplicate(humanErrorCard, providerFailure, 'database_write_failed'),
    ).toBe(false);
    expect(
      isImmediateOrderedErrorDuplicate(
        {
          ...humanErrorCard,
          metadata: { ...humanErrorCard.metadata, sourceEvent: 'agent.error' },
        },
        providerFailure,
        'provider_unavailable',
      ),
    ).toBe(false);
  });
});
