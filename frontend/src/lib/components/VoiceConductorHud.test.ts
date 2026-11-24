// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VoiceConductorHud from './VoiceConductorHud.svelte';
import { voiceConductor } from '$lib/voice-conductor/conductor.svelte';
import { conductorSettings } from '$lib/voice-conductor/settings.svelte';
import type { ConductorActions } from '$lib/voice-conductor/controller';

function actions(): ConductorActions {
  return {
    activeSessionId: () => 'chat-a',
    listWorkers: () => [
      { id: 'w1', name: 'Ada', role: 'coder', status: 'thinking' },
      { id: 'w2', name: 'Bo', role: 'critic', status: 'tool_calling' },
    ],
    managerStatus: () => 'thinking',
    isRunning: () => true,
    cancelSession: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {}),
    steerManager: vi.fn(async () => true),
    messageAgent: vi.fn(async () => true),
    listChats: () => [{ id: 'chat-a', title: 'Parser' }],
    createChat: vi.fn(async () => 'chat-new'),
    renameChat: vi.fn(async () => true),
    selectChat: vi.fn(),
    archiveChat: vi.fn(async () => true),
    deleteChat: vi.fn(async () => true),
    openPanel: () => true,
    notesEnabled: () => true,
    currentNote: () => null,
    updateNoteContent: vi.fn(async () => true),
    createNote: vi.fn(async () => 'n1'),
    trashNote: vi.fn(async () => true),
    lastReply: () => null,
    speak: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    spokenRepliesEnabled: async () => false,
  };
}

describe('VoiceConductorHud', () => {
  let fake: ConductorActions;

  beforeEach(() => {
    localStorage.clear();
    conductorSettings.reload();
    fake = actions();
    voiceConductor.resetForTesting(fake);
  });

  afterEach(() => {
    voiceConductor.resetForTesting(null);
  });

  it('asks before stopping and stops on the confirm tap', async () => {
    render(VoiceConductorHud);
    await voiceConductor.handleUtterance('stop worker two');
    const hud = await screen.findByTestId('voice-conductor-hud');
    expect(hud.getAttribute('role')).toBe('alertdialog');
    expect(screen.getByTestId('voice-conductor-title')).toHaveTextContent('Stop worker 2 (Bo)');
    expect(fake.cancelAgent).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId('voice-conductor-confirm'));
    await vi.waitFor(() => expect(fake.cancelAgent).toHaveBeenCalledWith('chat-a', 'w2'));
    expect(await screen.findByText('Stopped worker 2 (Bo)')).toBeTruthy();
  });

  it('cancel leaves the agents running', async () => {
    render(VoiceConductorHud);
    await voiceConductor.handleUtterance('stop');
    await fireEvent.click(await screen.findByTestId('voice-conductor-cancel'));
    expect(fake.cancelSession).not.toHaveBeenCalled();
    expect(await screen.findByText('Cancelled — nothing changed')).toBeTruthy();
  });

  it('shows status as text in a polite live region', async () => {
    render(VoiceConductorHud);
    await voiceConductor.handleUtterance('status');
    const hud = await screen.findByTestId('voice-conductor-hud');
    expect(hud.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('voice-conductor-detail')).toHaveTextContent(
      'Kory is thinking. 2 workers are active',
    );
  });

  it('offers Undo for a reversible action', async () => {
    render(VoiceConductorHud);
    await voiceConductor.handleUtterance('new chat about release notes');
    await fireEvent.click(await screen.findByTestId('voice-conductor-undo'));
    await vi.waitFor(() => expect(fake.archiveChat).toHaveBeenCalledWith('chat-new'));
    expect(fake.selectChat).toHaveBeenCalledWith('chat-a');
  });

  it('shows the fallback chip and sends only after Send', async () => {
    render(VoiceConductorHud);
    await voiceConductor.handleUtterance('rewrite the parser with a state machine');
    expect(await screen.findByText('Send to the manager as steering?')).toBeTruthy();
    expect(fake.steerManager).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId('voice-conductor-confirm'));
    await vi.waitFor(() =>
      expect(fake.steerManager).toHaveBeenCalledWith(
        'chat-a',
        'rewrite the parser with a state machine',
      ),
    );
  });

  it('does nothing while the conductor is turned off', async () => {
    conductorSettings.update({ enabled: false });
    render(VoiceConductorHud);
    await voiceConductor.handleUtterance('stop');
    expect(screen.queryByTestId('voice-conductor-hud')).toBeNull();
  });
});
