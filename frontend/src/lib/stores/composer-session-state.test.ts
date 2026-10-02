import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearComposerSessionState,
  loadComposerSessionState,
  saveComposerSessionState,
} from './composer-session-state';

describe('per-chat composer control state', () => {
  beforeEach(() => localStorage.clear());

  test('keeps model, reasoning, and fast mode scoped per chat', () => {
    saveComposerSessionState('session-a', {
      model: 'codex:gpt-5.6-sol',
      reasoningLevel: 'high',
      fastMode: true,
    });
    saveComposerSessionState('session-b', {
      model: 'codex:gpt-5.6-luna',
      reasoningLevel: 'low',
      fastMode: false,
    });

    expect(loadComposerSessionState('session-a')).toEqual({
      model: 'codex:gpt-5.6-sol',
      reasoningLevel: 'high',
      fastMode: true,
    });
    expect(loadComposerSessionState('session-b')).toEqual({
      model: 'codex:gpt-5.6-luna',
      reasoningLevel: 'low',
      fastMode: false,
    });
    expect(loadComposerSessionState('session-c')).toEqual({});
  });

  test('treats a missing scope like the welcome composer', () => {
    saveComposerSessionState(undefined, { model: 'codex:gpt-5.6-terra' });
    expect(loadComposerSessionState('welcome')).toEqual({ model: 'codex:gpt-5.6-terra' });
    expect(loadComposerSessionState('  ')).toEqual({ model: 'codex:gpt-5.6-terra' });
  });

  test('an empty save clears the stored controls for that chat only', () => {
    saveComposerSessionState('session-a', { model: 'codex:gpt-5.6-sol' });
    saveComposerSessionState('session-b', { model: 'codex:gpt-5.6-sol' });
    saveComposerSessionState('session-a', {});

    expect(loadComposerSessionState('session-a')).toEqual({});
    expect(loadComposerSessionState('session-b')).toEqual({ model: 'codex:gpt-5.6-sol' });
  });

  test('drops values of the wrong type instead of storing them', () => {
    localStorage.setItem(
      'koryphaios-composer-session-state-v1',
      JSON.stringify({
        'session-a': { model: 42, reasoningLevel: true, fastMode: 'yes' },
        'session-b': { model: 'codex:gpt-5.6-sol', extra: 'ignored' },
      }),
    );

    expect(loadComposerSessionState('session-a')).toEqual({});
    expect(loadComposerSessionState('session-b')).toEqual({ model: 'codex:gpt-5.6-sol' });
  });

  test('corrupt storage reads as empty and recoverable', () => {
    localStorage.setItem('koryphaios-composer-session-state-v1', '{not json');
    expect(loadComposerSessionState('session-a')).toEqual({});

    saveComposerSessionState('session-a', { model: 'codex:gpt-5.6-sol' });
    expect(loadComposerSessionState('session-a')).toEqual({ model: 'codex:gpt-5.6-sol' });
  });

  test('clearComposerSessionState removes only the requested scope', () => {
    saveComposerSessionState('session-a', { model: 'codex:gpt-5.6-sol', fastMode: true });
    saveComposerSessionState('session-b', { model: 'codex:gpt-5.6-luna' });

    clearComposerSessionState('session-a');

    expect(loadComposerSessionState('session-a')).toEqual({});
    expect(loadComposerSessionState('session-b')).toEqual({ model: 'codex:gpt-5.6-luna' });
  });

  test('keeps the approval posture, agent mode, and critic toggle per chat', () => {
    saveComposerSessionState('session-a', {
      permissionMode: 'yolo',
      agentExecutionMode: 'multi',
      criticGateEnabled: false,
    });
    saveComposerSessionState('session-b', {
      permissionMode: 'guarded',
      agentExecutionMode: 'single',
      criticGateEnabled: true,
    });

    expect(loadComposerSessionState('session-a')).toEqual({
      permissionMode: 'yolo',
      agentExecutionMode: 'multi',
      criticGateEnabled: false,
    });
    expect(loadComposerSessionState('session-b')).toEqual({
      permissionMode: 'guarded',
      agentExecutionMode: 'single',
      criticGateEnabled: true,
    });
    // A chat that never touched these controls reads as "no override", so the
    // workspace default still applies to it.
    expect(loadComposerSessionState('session-c')).toEqual({});
  });

  test('drops unrecognized approval values instead of storing them', () => {
    localStorage.setItem(
      'koryphaios-composer-session-state-v1',
      JSON.stringify({
        'session-a': {
          permissionMode: 'everything-goes',
          agentExecutionMode: 'swarm',
          criticGateEnabled: 'yes',
        },
        'session-b': { permissionMode: 'ask', agentExecutionMode: 'auto' },
      }),
    );

    expect(loadComposerSessionState('session-a')).toEqual({});
    expect(loadComposerSessionState('session-b')).toEqual({
      permissionMode: 'ask',
      agentExecutionMode: 'auto',
    });
  });
});
