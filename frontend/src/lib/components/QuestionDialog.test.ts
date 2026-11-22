import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionStore: {
    activeSessionId: 'session-1' as string | null,
    sessions: [{ id: 'session-1', title: 'Test chat' }],
  },
  pendingQuestion: null as {
    question: string;
    options: string[];
    allowOther: boolean;
    allowKeepChatting?: boolean;
    questionId?: string;
  } | null,
  sendUserInput: vi.fn(),
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    get pendingQuestion() {
      return mocks.pendingQuestion;
    },
    sendUserInput: mocks.sendUserInput,
  },
}));

import QuestionDialog from './QuestionDialog.svelte';

describe('QuestionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionStore.activeSessionId = 'session-1';
    mocks.pendingQuestion = null;
  });

  it('submits a real option containing "another" instead of opening the text box', async () => {
    mocks.pendingQuestion = {
      question: 'Which approach?',
      options: ['Use SQLite (Recommended)', 'Use another library'],
      allowOther: true,
    };
    render(QuestionDialog);

    await fireEvent.click(screen.getByRole('button', { name: 'Use another library' }));
    expect(mocks.sendUserInput).toHaveBeenCalledWith('session-1', 'Use another library');
    expect(screen.queryByPlaceholderText('Type your own answer...')).toBeNull();
  });

  it('opens the free-text box only for an "Other" style option', async () => {
    mocks.pendingQuestion = {
      question: 'Which approach?',
      options: ['Use SQLite (Recommended)', 'Other'],
      allowOther: true,
    };
    render(QuestionDialog);

    expect(screen.queryByPlaceholderText('Type your own answer...')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Other' }));

    const input = await screen.findByPlaceholderText('Type your own answer...');
    await fireEvent.input(input, { target: { value: 'Use an embedded store' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mocks.sendUserInput).toHaveBeenCalledWith('session-1', 'Use an embedded store');
  });

  it('renders the text input for a question with no options', async () => {
    mocks.pendingQuestion = {
      question: 'What should I do next?',
      options: [],
      allowOther: true,
    };
    render(QuestionDialog);

    await screen.findByPlaceholderText('Type your own answer...');
  });
});
