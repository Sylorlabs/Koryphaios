import { describe, expect, test } from 'bun:test';
import {
  isRemoteOperationRetryable,
  isRemoteOperationTerminal,
  REMOTE_PROTOCOL_VERSION,
} from './remote-protocol';

describe('remote protocol v2', () => {
  test('distinguishes terminal and uncertain outcomes', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(2);
    expect(isRemoteOperationTerminal('completed')).toBe(true);
    expect(isRemoteOperationTerminal('outcome_uncertain')).toBe(false);
    expect(isRemoteOperationRetryable('outcome_uncertain')).toBe(true);
    expect(isRemoteOperationRetryable('failed')).toBe(false);
  });
});
