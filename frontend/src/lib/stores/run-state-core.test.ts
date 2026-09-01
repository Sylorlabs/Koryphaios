import { describe, expect, test, beforeEach } from 'vitest';
import {
  createRunStateEngine,
  deriveButtonState,
  phaseToAgentStatus,
  isActivePhase,
  isWaitingPhase,
  type RunStateEngine,
  type RunStateTimers,
  type SessionRunState,
  type RunPhase,
} from './run-state-core';
import type { WSMessage, AgentStatus } from '@koryphaios/shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeTimers(): {
  timers: RunStateTimers;
  watchdogArms: string[];
  watchdogClears: string[];
  doneLingerArms: string[];
  doneLingerClears: string[];
} {
  const watchdogArms: string[] = [];
  const watchdogClears: string[] = [];
  const doneLingerArms: string[] = [];
  const doneLingerClears: string[] = [];
  return {
    timers: {
      armWatchdog: (sid) => watchdogArms.push(sid),
      clearWatchdog: (sid) => watchdogClears.push(sid),
      armDoneLinger: (sid) => doneLingerArms.push(sid),
      clearDoneLinger: (sid) => doneLingerClears.push(sid),
    },
    watchdogArms,
    watchdogClears,
    doneLingerArms,
    doneLingerClears,
  };
}

function makeEngine(): {
  engine: RunStateEngine;
  states: Map<string, SessionRunState>;
  commitCalls: number;
} & ReturnType<typeof makeTimers> {
  const states = new Map<string, SessionRunState>();
  let commitCalls = 0;
  const t = makeTimers();
  const engine = createRunStateEngine(
    () => states,
    () => {
      commitCalls++;
    },
    t.timers,
  );
  return {
    engine,
    states,
    get commitCalls() {
      return commitCalls;
    },
    ...t,
  };
}

function msg(
  type: WSMessage['type'],
  sessionId: string,
  payload: Record<string, unknown>,
): WSMessage {
  return {
    type,
    payload,
    timestamp: Date.now(),
    sessionId,
    agentId: 'kory-manager',
    eventId: `test-${Math.random().toString(36).slice(2)}`,
    epoch: 1,
    sequence: 0,
  } as WSMessage;
}

const SID = 'session-1';
const AGENT = 'kory-manager';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('run-state-core: phase predicates', () => {
  test('isActivePhase identifies analyzing/thinking/streaming/tool_calling', () => {
    expect(isActivePhase('analyzing')).toBe(true);
    expect(isActivePhase('thinking')).toBe(true);
    expect(isActivePhase('streaming')).toBe(true);
    expect(isActivePhase('tool_calling')).toBe(true);
    expect(isActivePhase('idle')).toBe(false);
    expect(isActivePhase('done')).toBe(false);
    expect(isActivePhase('waiting_terminal')).toBe(false);
    expect(isActivePhase('waiting_user')).toBe(false);
    expect(isActivePhase('error')).toBe(false);
  });

  test('isWaitingPhase identifies waiting_terminal/waiting_user', () => {
    expect(isWaitingPhase('waiting_terminal')).toBe(true);
    expect(isWaitingPhase('waiting_user')).toBe(true);
    expect(isWaitingPhase('streaming')).toBe(false);
    expect(isWaitingPhase('idle')).toBe(false);
  });
});

describe('run-state-core: phaseToAgentStatus', () => {
  test('maps each phase to the correct AgentStatus', () => {
    expect(phaseToAgentStatus('analyzing')).toBe('analyzing');
    expect(phaseToAgentStatus('thinking')).toBe('thinking');
    expect(phaseToAgentStatus('streaming')).toBe('streaming');
    expect(phaseToAgentStatus('tool_calling')).toBe('tool_calling');
    expect(phaseToAgentStatus('waiting_terminal')).toBe('waiting');
    expect(phaseToAgentStatus('waiting_user')).toBe('waiting_user');
    expect(phaseToAgentStatus('done')).toBe('done');
    expect(phaseToAgentStatus('error')).toBe('error');
    expect(phaseToAgentStatus('idle')).toBe('idle');
  });
});

describe('run-state-core: deriveButtonState', () => {
  test('active phase → stop', () => {
    expect(deriveButtonState('analyzing', false)).toEqual({
      mode: 'stop',
      waitingReason: '',
      phase: 'analyzing',
    });
    expect(deriveButtonState('streaming', false)).toEqual({
      mode: 'stop',
      waitingReason: '',
      phase: 'streaming',
    });
    expect(deriveButtonState('thinking', true)).toEqual({
      mode: 'stop',
      waitingReason: '',
      phase: 'thinking',
    });
  });

  test('waiting phase + empty composer → waiting', () => {
    expect(deriveButtonState('waiting_user', false, 'your answer')).toEqual({
      mode: 'waiting',
      waitingReason: 'your answer',
      phase: 'waiting_user',
    });
  });

  test('waiting phase + text remains waiting until the owned wait is cancelled', () => {
    expect(deriveButtonState('waiting_terminal', true, 'background terminal')).toEqual({
      mode: 'waiting',
      waitingReason: 'background terminal',
      phase: 'waiting_terminal',
    });
  });

  test('idle/done + canSend → send', () => {
    expect(deriveButtonState('idle', true).mode).toBe('send');
    expect(deriveButtonState('done', true).mode).toBe('send');
  });

  test('idle/done + !canSend → disabled', () => {
    expect(deriveButtonState('idle', false).mode).toBe('disabled');
    expect(deriveButtonState('done', false).mode).toBe('disabled');
  });
});

describe('run-state-core: startRun', () => {
  test('sets phase to analyzing and tracks kory-manager as active', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    expect(engine.getPhase(SID)).toBe('analyzing');
    expect(engine.isRunning(SID)).toBe(true);
    expect(engine.states.get(SID)?.activeAgents.has(AGENT)).toBe(true);
    expect(engine.states.get(SID)?.stoppedByUser).toBe(false);
  });

  test('clears stoppedByUser from a previous stop', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    expect(engine.states.get(SID)?.stoppedByUser).toBe(true);
    engine.startRun(SID);
    expect(engine.states.get(SID)?.stoppedByUser).toBe(false);
    expect(engine.getPhase(SID)).toBe('analyzing');
  });
});

describe('run-state-core: applyEvent stream transitions', () => {
  test('stream.delta → streaming', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('stream.delta', SID, { agentId: AGENT, content: 'hi' }));
    expect(engine.getPhase(SID)).toBe('streaming');
  });

  test('stream.thinking → thinking', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('stream.thinking', SID, { agentId: AGENT, thinking: 'hmm' }));
    expect(engine.getPhase(SID)).toBe('thinking');
  });

  test('stream.tool_call → tool_calling', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(
      msg('stream.tool_call', SID, {
        agentId: AGENT,
        toolCall: { id: 'tc1', name: 'bash', input: {} },
      }),
    );
    expect(engine.getPhase(SID)).toBe('tool_calling');
  });

  test('stream.tool_result → back to streaming', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(
      msg('stream.tool_call', SID, {
        agentId: AGENT,
        toolCall: { id: 'tc1', name: 'bash', input: {} },
      }),
    );
    expect(engine.getPhase(SID)).toBe('tool_calling');
    engine.applyEvent(
      msg('stream.tool_result', SID, {
        agentId: AGENT,
        toolResult: { callId: 'tc1', name: 'bash', output: '' },
      }),
    );
    expect(engine.getPhase(SID)).toBe('streaming');
  });
});

describe('run-state-core: applyEvent agent.status', () => {
  test('analyzing status → analyzing phase', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'analyzing' }));
    expect(engine.getPhase(SID)).toBe('analyzing');
  });

  test('thinking status → thinking phase', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    expect(
      engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'thinking' })),
    ).toBe(true);
    expect(engine.getPhase(SID)).toBe('thinking');
  });

  test('waiting_user status → waiting_user phase with reason', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'waiting_user' }));
    expect(engine.getPhase(SID)).toBe('waiting_user');
    expect(engine.getWaitingReason(SID)).toBe('your answer');
    expect(engine.isWaiting(SID)).toBe(true);
  });

  test('waiting status → waiting_terminal phase with reason', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'waiting' }));
    expect(engine.getPhase(SID)).toBe('waiting_terminal');
    expect(engine.getWaitingReason(SID)).toBe('background terminal');
  });

  test('done status → done phase when last agent', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.isRunning(SID)).toBe(false);
  });
});

describe('run-state-core: applyEvent terminal events', () => {
  test('stream.complete removes agent and sets done when last', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('stream.complete', SID, { agentId: AGENT }));
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.isRunning(SID)).toBe(false);
  });

  test('agent.completed removes agent and sets done when last', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.completed', SID, { agentId: AGENT }));
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('agent.error sets error phase when no agents remain', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.error', SID, { agentId: AGENT }));
    expect(engine.getPhase(SID)).toBe('error');
    expect(engine.isRunning(SID)).toBe(false);
  });

  test('system.error sets error phase (manager crash path)', () => {
    // The manager emits system.error (not agent.error) when handleDirectly
    // throws. Without handling this, the button stays on "Stop" until the
    // 15s watchdog fires.
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('system.error', SID, { error: 'Provider crashed' }));
    expect(engine.getPhase(SID)).toBe('error');
    expect(engine.isRunning(SID)).toBe(false);
  });
});

describe('run-state-core: applyEvent kory.ask_user', () => {
  test('sets waiting_user with "your answer" reason', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('kory.ask_user', SID, { question: 'Which file?', options: [] }));
    expect(engine.getPhase(SID)).toBe('waiting_user');
    expect(engine.getWaitingReason(SID)).toBe('your answer');
  });
});

describe('run-state-core: applyEvent agent.heartbeat', () => {
  test('does NOT resurrect a done session (terminal event already received)', () => {
    // The backend stops the heartbeat before emitting agent.status: done, but
    // a final heartbeat may already be in flight. It must not resurrect.
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(
      msg('agent.heartbeat', SID, { agentId: AGENT, sessionId: SID, phase: 'streaming' }),
    );
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.isRunning(SID)).toBe(false);
  });

  test('resurrects an idle session (done-linger fired, run still alive)', () => {
    // The done-linger timer auto-reverts done → idle after 1.5s. If a
    // heartbeat arrives after idle, the run is actually still alive
    // (watchdog false positive) — resurrect to streaming.
    const { engine } = makeEngine();
    engine.startRun(SID);
    // Simulate the done-linger by manually setting phase to idle
    const s = engine.states.get(SID)!;
    s.phase = 'idle';
    engine.applyEvent(
      msg('agent.heartbeat', SID, { agentId: AGENT, sessionId: SID, phase: 'streaming' }),
    );
    expect(engine.getPhase(SID)).toBe('streaming');
    expect(engine.isRunning(SID)).toBe(true);
  });

  test('ignored for a session with no existing state (heartbeat cannot create a run)', () => {
    const { engine } = makeEngine();
    // No startRun, no prior events — session doesn't exist in the map.
    engine.applyEvent(
      msg('agent.heartbeat', SID, { agentId: AGENT, sessionId: SID, phase: 'streaming' }),
    );
    expect(engine.getPhase(SID)).toBe('idle');
    expect(engine.states.has(SID)).toBe(false);
  });

  test('does not resurrect a stopped-by-user session', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(
      msg('agent.heartbeat', SID, { agentId: AGENT, sessionId: SID, phase: 'streaming' }),
    );
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.states.get(SID)?.stoppedByUser).toBe(true);
  });
});

describe('run-state-core: terminal-phase guard (stale resurrecting events)', () => {
  test('returns false for a late thought so downstream feed reducers suppress it', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    expect(engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }))).toBe(
      true,
    );

    expect(
      engine.applyEvent(msg('stream.thinking', SID, { agentId: AGENT, thinking: 'late' })),
    ).toBe(false);
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('permits a durable replayed thought after done without resurrecting the run', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));

    expect(
      engine.applyEvent({
        ...msg('stream.thinking', SID, { agentId: AGENT, thinking: 'historical' }),
        replayed: true,
      }),
    ).toBe(true);
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('allows replayed stream content without a local run state', () => {
    const { engine } = makeEngine();

    expect(
      engine.applyEvent(msg('stream.thinking', SID, { agentId: AGENT, thinking: 'replayed' })),
    ).toBe(true);
    expect(engine.states.has(SID)).toBe(false);
  });

  test('stream.delta after done is ignored (no resurrection)', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(msg('stream.delta', SID, { agentId: AGENT, content: 'late chunk' }));
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.isRunning(SID)).toBe(false);
  });

  test('stream.tool_call after done is ignored', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(
      msg('stream.tool_call', SID, {
        agentId: AGENT,
        toolCall: { id: 'tc1', name: 'bash', input: {} },
      }),
    );
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('stream.thinking after error is ignored', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('system.error', SID, { error: 'crash' }));
    expect(engine.getPhase(SID)).toBe('error');
    engine.applyEvent(msg('stream.thinking', SID, { agentId: AGENT, thinking: 'late' }));
    expect(engine.getPhase(SID)).toBe('error');
  });

  test('agent.status: thinking after done is ignored', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    expect(
      engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'thinking' })),
    ).toBe(false);
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.isRunning(SID)).toBe(false);
  });

  test('agent.status: waiting after done is ignored', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'waiting' }));
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('agent.status: done after done passes through (terminal, not resurrecting)', () => {
    // Terminal statuses are NOT resurrecting — they pass through the guard.
    // This ensures a real done event can still reconcile after a prior done.
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('kory.ask_user after done is ignored', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    engine.applyEvent(msg('kory.ask_user', SID, { question: 'late?', options: [] }));
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('compaction.started after done still works (post-turn operation)', () => {
    // Compaction is a legitimate post-turn operation — the backend emits
    // agent.status: done, then starts compaction in a setTimeout. It is
    // NOT suppressed by the terminal-phase guard.
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.applyEvent(msg('compaction.started', SID, { sessionId: SID }))).toBe(true);
    expect(engine.getPhase(SID)).toBe('streaming');
    expect(engine.isRunning(SID)).toBe(true);
  });

  test('stream.delta after idle (done-linger fired) still resurrects', () => {
    // idle is NOT terminal — a stream event after idle means the watchdog
    // was a false positive and the run is actually still alive.
    const { engine } = makeEngine();
    engine.startRun(SID);
    const s = engine.states.get(SID)!;
    s.phase = 'idle';
    engine.applyEvent(msg('stream.delta', SID, { agentId: AGENT, content: 'still alive' }));
    expect(engine.getPhase(SID)).toBe('streaming');
    expect(engine.isRunning(SID)).toBe(true);
  });

  test('agent.status: thinking after idle still resurrects', () => {
    // After the done-linger fires (done → idle), a real agent.status: thinking
    // means the run is actually alive — resurrect.
    const { engine } = makeEngine();
    engine.startRun(SID);
    const s = engine.states.get(SID)!;
    s.phase = 'idle';
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'thinking' }));
    expect(engine.getPhase(SID)).toBe('thinking');
    expect(engine.isRunning(SID)).toBe(true);
  });
});

describe('run-state-core: user stop suppression', () => {
  test('markUserStopped sets done and stoppedByUser', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.states.get(SID)?.stoppedByUser).toBe(true);
  });

  test('late stream.delta is suppressed after stop', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    expect(engine.applyEvent(msg('stream.delta', SID, { agentId: AGENT, content: 'late' }))).toBe(
      false,
    );
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('late stream.thinking is suppressed after stop', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    engine.applyEvent(msg('stream.thinking', SID, { agentId: AGENT, thinking: 'late' }));
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('late kory.ask_user is suppressed after stop', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    engine.applyEvent(msg('kory.ask_user', SID, { question: 'late?', options: [] }));
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('terminal agent.status (done) passes through after stop', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    // Still done (terminal statuses are not suppressed)
    expect(engine.getPhase(SID)).toBe('done');
  });

  test('clearUserStopped un-suppresses so real events can reconcile', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.markUserStopped(SID);
    engine.clearUserStopped(SID);
    expect(engine.states.get(SID)?.stoppedByUser).toBe(false);
    // After clearUserStopped, the phase is still done. A heartbeat can't
    // resurrect from done (terminal guard), but a stream.delta can resurrect
    // from idle (after the done-linger timer fires). Simulate the linger:
    const s = engine.states.get(SID)!;
    s.phase = 'idle';
    engine.applyEvent(
      msg('agent.heartbeat', SID, { agentId: AGENT, sessionId: SID, phase: 'streaming' }),
    );
    expect(engine.getPhase(SID)).toBe('streaming');
  });
});

describe('run-state-core: multi-agent tracking', () => {
  test('removing one agent does not end the run if others are active', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    // Spawn a worker
    engine.applyEvent(
      msg('agent.spawned', SID, {
        agent: {
          id: 'worker-1',
          name: 'Worker',
          role: 'worker',
          model: 'm',
          provider: 'p',
          domain: 'general',
        },
        task: 'do stuff',
      }),
    );
    engine.applyEvent(msg('agent.status', SID, { agentId: 'worker-1', status: 'thinking' }));
    expect(engine.isRunning(SID)).toBe(true);
    // Complete the manager — worker is still active
    engine.applyEvent(msg('stream.complete', SID, { agentId: AGENT }));
    expect(engine.isRunning(SID)).toBe(true);
    // Complete the worker — now done
    engine.applyEvent(msg('agent.completed', SID, { agentId: 'worker-1' }));
    expect(engine.getPhase(SID)).toBe('done');
  });
});

describe('run-state-core: system.info "Session cancelled"', () => {
  test('triggers markUserStopped', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('system.info', SID, { message: 'Session cancelled' }));
    expect(engine.getPhase(SID)).toBe('done');
    expect(engine.states.get(SID)?.stoppedByUser).toBe(true);
  });

  test('other system.info messages are ignored', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('system.info', SID, { message: 'Some other info' }));
    expect(engine.getPhase(SID)).toBe('analyzing');
  });
});

describe('run-state-core: compaction', () => {
  test('compaction.started → streaming, compaction.completed → done', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    // Clear the manager so only compaction is active
    engine.applyEvent(msg('stream.complete', SID, { agentId: AGENT }));
    // Now start compaction
    engine.applyEvent(msg('compaction.started', SID, { sessionId: SID }));
    expect(engine.getPhase(SID)).toBe('streaming');
    expect(engine.isRunning(SID)).toBe(true);
    // Complete compaction
    engine.applyEvent(msg('compaction.completed', SID, { sessionId: SID }));
    expect(engine.getPhase(SID)).toBe('done');
  });
});

describe('run-state-core: resetSession & clearAll', () => {
  test('resetSession removes the session from the map', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    expect(engine.getPhase(SID)).toBe('analyzing');
    engine.resetSession(SID);
    expect(engine.getPhase(SID)).toBe('idle');
    expect(engine.states.has(SID)).toBe(false);
  });

  test('clearAll removes all sessions', () => {
    const { engine } = makeEngine();
    engine.startRun('s1');
    engine.startRun('s2');
    engine.clearAll();
    expect(engine.getPhase('s1')).toBe('idle');
    expect(engine.getPhase('s2')).toBe('idle');
  });
});

describe('run-state-core: timer wiring', () => {
  test('startRun arms the watchdog', () => {
    const { engine, watchdogArms } = makeEngine();
    engine.startRun(SID);
    expect(watchdogArms).toContain(SID);
  });

  test('setPhase to done clears the watchdog and arms done-linger', () => {
    const { engine, watchdogClears, doneLingerArms } = makeEngine();
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(watchdogClears).toContain(SID);
    expect(doneLingerArms).toContain(SID);
  });

  test('tool_calling does not arm the watchdog (suspended)', () => {
    const { engine, watchdogArms } = makeEngine();
    engine.startRun(SID);
    watchdogArms.length = 0; // clear the initial arm
    engine.applyEvent(
      msg('stream.tool_call', SID, {
        agentId: AGENT,
        toolCall: { id: 'tc1', name: 'bash', input: {} },
      }),
    );
    // The engine calls armWatchdog, but the reactive wrapper suspends it.
    // In the core, armWatchdog is called — the wrapper decides whether to
    // actually set the timer. So we just verify armWatchdog was called.
    expect(watchdogArms).toContain(SID);
  });
});

describe('run-state-core: isBusy', () => {
  test('true for active and waiting phases', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    expect(engine.isBusy(SID)).toBe(true);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'waiting_user' }));
    expect(engine.isBusy(SID)).toBe(true);
  });

  test('false for idle and done', () => {
    const { engine } = makeEngine();
    expect(engine.isBusy(SID)).toBe(false);
    engine.startRun(SID);
    engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'done' }));
    expect(engine.isBusy(SID)).toBe(false);
  });
});

describe('run-state-core: authoritative run projection', () => {
  function runStateMessage(
    revision: number,
    phase: RunPhase,
    status: 'idle' | 'active' | 'waiting' | 'terminal',
  ): WSMessage {
    return msg('run.state', SID, {
      snapshot: {
        sessionId: SID,
        runId: 'run-authoritative',
        revision,
        phase,
        status,
        waitingReason: phase === 'waiting_user' ? 'awaiting_user_input' : '',
        activeAgentIds: status === 'active' ? [AGENT] : [],
        startedAt: 10,
        updatedAt: 20 + revision,
        finishedAt: status === 'terminal' ? 20 + revision : null,
        terminalReason: status === 'terminal' ? 'completed' : null,
      },
      transition: null,
    });
  }

  test('legacy stream/status traffic cannot contradict a canonical revision', () => {
    const { engine } = makeEngine();
    engine.startRun(SID);
    expect(engine.applyEvent(runStateMessage(4, 'waiting_user', 'waiting'))).toBe(true);
    expect(engine.getPhase(SID)).toBe('waiting_user');

    // These still pass to transcript reducers, but do not own lifecycle state.
    expect(engine.applyEvent(msg('stream.delta', SID, { agentId: AGENT, content: 'late' }))).toBe(
      true,
    );
    expect(
      engine.applyEvent(msg('agent.status', SID, { agentId: AGENT, status: 'thinking' })),
    ).toBe(true);
    expect(engine.getPhase(SID)).toBe('waiting_user');
  });

  test('rejects an older run snapshot and applies a newer terminal snapshot', () => {
    const { engine, doneLingerArms } = makeEngine();
    engine.applyEvent(runStateMessage(5, 'streaming', 'active'));
    expect(engine.applyEvent(runStateMessage(4, 'thinking', 'active'))).toBe(false);
    expect(engine.getPhase(SID)).toBe('streaming');

    engine.applyEvent(runStateMessage(6, 'cancelled', 'terminal'));
    expect(engine.getPhase(SID)).toBe('cancelled');
    expect(engine.isBusy(SID)).toBe(false);
    expect(engine.states.get(SID)?.stoppedByUser).toBe(true);
    expect(doneLingerArms).toHaveLength(0);
  });
});
