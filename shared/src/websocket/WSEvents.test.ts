import { describe, expect, test } from 'bun:test';
import {
  SESSION_SCOPED_EVENT_TYPES,
  hasRequiredSessionIdentity,
  isSessionScopedEventType,
  type WSEventType,
  type WSMessage,
} from './WSEvents';

const message = (type: WSEventType, sessionId?: string): WSMessage => ({
  type,
  payload: {},
  timestamp: 1,
  ...(sessionId === undefined ? {} : { sessionId }),
});

describe('session-scoped event types', () => {
  test('covers transcript, agent, run, compaction and kory events', () => {
    for (const type of [
      'agent.spawned',
      'agent.heartbeat',
      'stream.delta',
      'stream.file_complete',
      'context.detected',
      'session.changes',
      'session.timeline_rewritten',
      'run.state',
      'turn.provider_completed',
      'run.settled',
      'compaction.progress',
      'kory.ask_user_resolved',
    ] as WSEventType[]) {
      expect(isSessionScopedEventType(type)).toBe(true);
    }
  });

  test('does not scope global or lifecycle events', () => {
    for (const type of [
      'session.actionable_waits',
      'session.actionable_waits.request',
      'session.created',
      'session.deleted',
      'provider.status',
      'system.notification',
      'workspace.updated',
    ] as WSEventType[]) {
      expect(isSessionScopedEventType(type)).toBe(false);
    }
  });

  test('every scoped member is a known event type prefix family', () => {
    const prefixes = ['agent.', 'stream.', 'context.', 'session.', 'run.', 'turn.', 'compaction.', 'kory.', 'permission.'];
    for (const type of SESSION_SCOPED_EVENT_TYPES) {
      expect(prefixes.some((prefix) => type.startsWith(prefix))).toBe(true);
    }
  });

  test('excludes the global actionable-waits response', () => {
    expect(SESSION_SCOPED_EVENT_TYPES.has('session.actionable_waits')).toBe(false);
  });
});

describe('hasRequiredSessionIdentity', () => {
  test('accepts a scoped message with a non-empty sessionId', () => {
    expect(hasRequiredSessionIdentity(message('stream.delta', 'session-1'))).toBe(true);
  });

  test('rejects a scoped message without a sessionId', () => {
    expect(hasRequiredSessionIdentity(message('stream.delta'))).toBe(false);
    expect(hasRequiredSessionIdentity(message('kory.thought', ''))).toBe(false);
    expect(hasRequiredSessionIdentity(message('agent.status', '   '))).toBe(false);
  });

  test('accepts non-scoped messages with or without a sessionId', () => {
    expect(hasRequiredSessionIdentity(message('provider.status'))).toBe(true);
    expect(hasRequiredSessionIdentity(message('system.notification', 'session-1'))).toBe(true);
    expect(hasRequiredSessionIdentity(message('session.actionable_waits'))).toBe(true);
  });
});
