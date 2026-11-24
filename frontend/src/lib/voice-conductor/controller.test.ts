import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_WINDOW_MS,
  appendToNoteContent,
  createConductorController,
  describeStatus,
  findChat,
  resolveWorker,
  type ConductorActions,
  type ConductorAgent,
  type ConductorNote,
  type ConductorState,
} from './controller';

const WORKERS: ConductorAgent[] = [
  { id: 'w-ada', name: 'Ada', role: 'coder', status: 'tool_calling', task: 'Write the parser' },
  { id: 'w-bo', name: 'Bo', role: 'critic', status: 'thinking' },
  { id: 'w-cy', name: 'Cy', role: 'reviewer', status: 'done' },
];

function fakeActions(overrides: Partial<ConductorActions> = {}) {
  let active = 'chat-a';
  let note: ConductorNote | null = null;
  const actions = {
    activeSessionId: vi.fn(() => active),
    listWorkers: vi.fn((sessionId: string) => (sessionId === 'chat-a' ? WORKERS : [])),
    managerStatus: vi.fn(() => 'thinking'),
    isRunning: vi.fn(() => true),
    cancelSession: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {}),
    steerManager: vi.fn(async () => true),
    messageAgent: vi.fn(async () => true),
    listChats: vi.fn(() => [
      { id: 'chat-a', title: 'Parser work' },
      { id: 'chat-b', title: 'Billing refactor' },
    ]),
    createChat: vi.fn(async () => 'chat-new'),
    renameChat: vi.fn(async () => true),
    selectChat: vi.fn((id: string) => {
      active = id;
    }),
    archiveChat: vi.fn(async () => true),
    deleteChat: vi.fn(async () => true),
    openPanel: vi.fn(() => true),
    notesEnabled: vi.fn(() => true),
    currentNote: vi.fn(() => note),
    updateNoteContent: vi.fn(async () => true),
    createNote: vi.fn(async () => 'note-1'),
    trashNote: vi.fn(async () => true),
    lastReply: vi.fn(() => ({ id: 'reply-1', text: 'All tests pass.' })),
    speak: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    spokenRepliesEnabled: vi.fn(async () => false),
    ...overrides,
  } satisfies ConductorActions;
  return {
    actions,
    setActive: (id: string) => {
      active = id;
    },
    setNote: (next: ConductorNote | null) => {
      note = next;
    },
  };
}

let states: ConductorState[];

function setup(overrides: Partial<ConductorActions> = {}) {
  const fake = fakeActions(overrides);
  states = [];
  const controller = createConductorController(fake.actions, (s) => states.push(s));
  return { ...fake, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('helpers', () => {
  it('resolves workers by ordinal, role and name', () => {
    expect(resolveWorker(WORKERS, { kind: 'ordinal', index: 2 })).toMatchObject({ id: 'w-bo' });
    expect(resolveWorker(WORKERS, { kind: 'role', role: 'critic' })).toMatchObject({ id: 'w-bo' });
    expect(resolveWorker(WORKERS, { kind: 'name', name: 'ada' })).toMatchObject({ id: 'w-ada' });
    expect(resolveWorker(WORKERS, { kind: 'ordinal', index: 5 })).toEqual({
      error: 'There is no fifth worker; this chat has 3.',
    });
    expect(resolveWorker([], { kind: 'ordinal', index: 1 })).toEqual({
      error: 'No workers are in this chat yet.',
    });
  });

  it('describes status for the whole chat and for one worker', () => {
    expect(describeStatus('thinking', WORKERS)).toBe(
      'Kory is thinking. 2 workers are active: worker 1 (Ada) is using tools; worker 2 (Bo) is thinking. 1 finished.',
    );
    expect(describeStatus('idle', [])).toBe('Kory is idle. No workers have started in this chat.');
    expect(describeStatus('idle', WORKERS, { kind: 'ordinal', index: 1 })).toBe(
      'Worker 1 (Ada) is using tools on “Write the parser”.',
    );
    expect(describeStatus('streaming', WORKERS, { kind: 'manager' })).toBe(
      'Kory is writing a reply.',
    );
  });

  it('matches chat titles loosely', () => {
    const chats = [
      { id: '1', title: 'Billing refactor' },
      { id: '2', title: 'Login page bug' },
    ];
    expect(findChat(chats, 'billing')?.id).toBe('1');
    expect(findChat(chats, 'the login bug')?.id).toBe('2');
    expect(findChat(chats, 'Billing Refactor')?.id).toBe('1');
    expect(findChat(chats, 'kubernetes')).toBeNull();
  });

  it('appends to markdown and html notes', () => {
    expect(appendToNoteContent({ id: 'n', title: 't', content: 'One\n' }, 'Two')).toBe(
      'One\n\nTwo',
    );
    expect(appendToNoteContent({ id: 'n', title: 't', content: '' }, 'Two')).toBe('Two');
    expect(
      appendToNoteContent({ id: 'n', title: 't', content: '<p>One</p>', format: 'html' }, 'a<b'),
    ).toBe('<p>One</p><p>a&#60;b</p>');
  });
});

describe('non-destructive commands run immediately', () => {
  it('answers status as text and does not speak when spoken replies are off', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('what are the agents doing');
    expect(controller.state.hud).toMatchObject({ tone: 'info', title: 'Status' });
    expect(controller.state.hud?.detail).toContain('worker 1 (Ada) is using tools');
    await vi.runAllTicks();
    await Promise.resolve();
    expect(actions.speak).not.toHaveBeenCalled();
  });

  it('speaks the status answer when spoken replies are on', async () => {
    const { controller, actions } = setup({ spokenRepliesEnabled: vi.fn(async () => true) });
    await controller.handleUtterance('status');
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.speak).toHaveBeenCalledWith(
      expect.stringMatching(/^conductor-/),
      expect.stringContaining('Kory is thinking'),
    );
    // Shown as text too.
    expect(controller.state.hud?.detail).toContain('Kory is thinking');
  });

  it('steers the manager with the captured session first', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('tell the manager to run the tests');
    expect(actions.steerManager).toHaveBeenCalledWith('chat-a', 'Run the tests');
    expect(controller.state.hud?.title).toBe('Sent to the manager');
  });

  it('messages a worker by ordinal', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('tell worker 2 to check edge cases');
    expect(actions.messageAgent).toHaveBeenCalledWith('chat-a', 'w-bo', 'Check edge cases');
  });

  it('opens panels and reports when nothing can show one', async () => {
    const { controller, actions } = setup({ openPanel: vi.fn((p) => p !== 'terminal') });
    await controller.handleUtterance('open notes');
    expect(actions.openPanel).toHaveBeenCalledWith('notes');
    expect(controller.state.hud?.title).toBe('Opened Notes');
    await controller.handleUtterance('open the terminal');
    expect(controller.state.hud).toMatchObject({
      tone: 'warning',
      title: 'Terminal is not available here',
    });
  });

  it('reads the last reply aloud', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('read the last reply');
    expect(actions.speak).toHaveBeenCalledWith('reply-1', 'All tests pass.');
  });

  it('reports a worker that does not exist without acting', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('tell worker nine to stop');
    expect(actions.messageAgent).not.toHaveBeenCalled();
    expect(controller.state.hud?.tone).toBe('warning');
  });

  it('needs a chat for chat-bound commands', async () => {
    const { controller, setActive } = setup();
    setActive('');
    await controller.handleUtterance('status');
    expect(controller.state.hud).toMatchObject({ tone: 'warning', title: 'Open a chat first.' });
  });
});

describe('confirmation flow', () => {
  it('does not stop anything until confirmed by tap', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('stop worker two');
    expect(actions.cancelAgent).not.toHaveBeenCalled();
    expect(controller.awaitingConfirmation).toBe(true);
    expect(controller.state.hud).toMatchObject({
      tone: 'confirm',
      title: 'Stop worker 2 (Bo)',
      confirm: { label: 'Confirm', destructive: true },
    });
    await controller.confirm();
    expect(actions.cancelAgent).toHaveBeenCalledWith('chat-a', 'w-bo');
    expect(controller.awaitingConfirmation).toBe(false);
    expect(controller.state.hud?.title).toBe('Stopped worker 2 (Bo)');
  });

  it('accepts a spoken "yes" within the window', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('cancel all');
    vi.advanceTimersByTime(CONFIRM_WINDOW_MS - 100);
    await controller.handleUtterance('yes');
    expect(actions.cancelSession).toHaveBeenCalledWith('chat-a');
  });

  it('expires after five seconds and then ignores a late yes', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('stop');
    vi.advanceTimersByTime(CONFIRM_WINDOW_MS + 1);
    expect(controller.awaitingConfirmation).toBe(false);
    expect(controller.state.hud?.title).toBe('Not confirmed — nothing changed');
    await controller.handleUtterance('yes');
    expect(actions.cancelSession).not.toHaveBeenCalled();
    expect(controller.state.hud?.title).toBe('Nothing is waiting for confirmation');
  });

  it('a spoken "no" or a dismiss cancels', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('stop the critic');
    await controller.handleUtterance('no');
    expect(controller.awaitingConfirmation).toBe(false);
    await controller.handleUtterance('delete this chat');
    controller.dismiss();
    expect(actions.cancelAgent).not.toHaveBeenCalled();
    expect(actions.deleteChat).not.toHaveBeenCalled();
    expect(controller.state.hud?.title).toBe('Cancelled — nothing changed');
  });

  it('acts on the chat the command was spoken in, even after switching', async () => {
    const { controller, actions, setActive } = setup();
    await controller.handleUtterance('stop everything');
    setActive('chat-b');
    await controller.confirm();
    expect(actions.cancelSession).toHaveBeenCalledWith('chat-a');
  });

  it('a new command replaces a pending question', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('stop');
    await controller.handleUtterance('open notes');
    expect(controller.awaitingConfirmation).toBe(false);
    await controller.confirm();
    expect(actions.cancelSession).not.toHaveBeenCalled();
  });

  it('unrecognised speech is only sent to the manager after the chip is confirmed', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('refactor the parser into a state machine');
    expect(actions.steerManager).not.toHaveBeenCalled();
    expect(controller.state.hud).toMatchObject({
      tone: 'fallback',
      title: 'Send to the manager as steering?',
      detail: 'refactor the parser into a state machine',
      confirm: { label: 'Send', destructive: false },
    });
    await controller.handleUtterance('send it');
    expect(actions.steerManager).toHaveBeenCalledWith(
      'chat-a',
      'refactor the parser into a state machine',
    );
  });

  it('a dismissed fallback chip sends nothing', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('refactor the parser');
    controller.dismiss();
    vi.runAllTimers();
    expect(actions.steerManager).not.toHaveBeenCalled();
  });
});

describe('undo', () => {
  it('undoes a new chat by returning to the previous one and archiving the new one', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('new chat about the billing bug');
    expect(actions.createChat).toHaveBeenCalled();
    expect(actions.renameChat).toHaveBeenCalledWith('chat-new', 'The billing bug');
    expect(controller.state.hud?.canUndo).toBe(true);
    await controller.undo();
    expect(actions.selectChat).toHaveBeenCalledWith('chat-a');
    expect(actions.archiveChat).toHaveBeenCalledWith('chat-new');
    expect(actions.deleteChat).not.toHaveBeenCalled();
  });

  it('undoes a chat switch by going back', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('open chat billing');
    expect(actions.selectChat).toHaveBeenLastCalledWith('chat-b');
    await controller.handleUtterance('undo');
    expect(actions.selectChat).toHaveBeenLastCalledWith('chat-a');
  });

  it('undoes an appended note by restoring the previous content', async () => {
    const { controller, actions, setNote } = setup();
    setNote({ id: 'n1', title: 'Ideas', content: 'First idea' });
    await controller.handleUtterance('note that caching helps');
    expect(actions.updateNoteContent).toHaveBeenCalledWith('n1', 'First idea\n\nCaching helps');
    await controller.undo();
    expect(actions.updateNoteContent).toHaveBeenLastCalledWith('n1', 'First idea');
  });

  it('undoes a created note by moving it to the trash', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('take a note: ship on Friday');
    expect(actions.createNote).toHaveBeenCalledWith('Ship on Friday', 'Ship on Friday');
    await controller.undo();
    expect(actions.trashNote).toHaveBeenCalledWith('note-1');
  });

  it('offers no undo for irreversible actions and says so', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('tell the manager to add tests');
    expect(controller.state.hud?.canUndo).toBe(false);
    await controller.undo();
    expect(controller.state.hud?.title).toBe('Nothing to undo');
    await controller.handleUtterance('stop');
    await controller.confirm();
    expect(controller.state.hud?.canUndo).toBe(false);
    expect(actions.cancelSession).toHaveBeenCalledTimes(1);
  });

  it('undo runs once and expires', async () => {
    const { controller, actions } = setup();
    await controller.handleUtterance('open chat billing');
    vi.advanceTimersByTime(31_000);
    await controller.undo();
    expect(controller.state.hud?.title).toBe('Nothing to undo');
    expect(actions.selectChat).toHaveBeenCalledTimes(1);
  });
});
