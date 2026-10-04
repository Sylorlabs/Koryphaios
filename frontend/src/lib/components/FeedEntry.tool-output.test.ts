import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedEntryLocal } from '$lib/types';

const mocks = vi.hoisted(() => ({ copyText: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/utils/clipboard', () => ({
  copyText: (...args: unknown[]) => mocks.copyText(...args),
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    activeSessionId: 'session-1',
    sessions: [
      { id: 'session-1', workingDirectory: '/source', gitWorkspace: { path: '/checkout' } },
    ],
    fetchMessages: vi.fn(),
  },
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    loadSessionMessages: vi.fn(),
    setEntryVisibility: vi.fn(),
    rewind: vi.fn(),
    rewindPreviewLoadingHash: '',
  },
}));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: { currentPath: '/tmp/project' },
}));
vi.mock('$lib/stores/auth.svelte', () => ({ authStore: { token: undefined } }));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { settings: { reasoningExpandedByDefault: false } },
}));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import FeedEntry from './FeedEntry.svelte';
import { apiFetch } from '$lib/api.svelte';
import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';

const OUTPUT = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n+++ b/x.ts';

function toolResultEntry(overrides: Partial<FeedEntryLocal['metadata']> = {}): FeedEntryLocal {
  return {
    id: 'tool-1',
    timestamp: 100,
    type: 'tool_result',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text: 'Tool result: bash',
    metadata: {
      toolCall: { name: 'bash', input: { command: 'git diff' } },
      toolResult: { name: 'bash', output: OUTPUT, isError: false },
      ...overrides,
    },
  } as FeedEntryLocal;
}

function renderEntry(entry: FeedEntryLocal) {
  return render(FeedEntry, {
    props: {
      entry,
      isSelected: false,
      isExpanded: false,
      onSelect: vi.fn(),
      onToggleGroup: vi.fn(),
      onDelete: vi.fn(),
    },
  });
}

describe('FeedEntry tool output panel', () => {
  beforeEach(() => {
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(undefined);
  });

  it('routes relative images through the session checkout without using the source path', async () => {
    const { container } = renderEntry({
      ...toolResultEntry(),
      type: 'content',
      text: '![Preview](images/result.png)',
      metadata: {},
    });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const image = container.querySelector('img');
    const url = new URL(image!.getAttribute('src')!, 'http://localhost');
    expect(url.searchParams.get('path')).toBe('images/result.png');
    expect(url.searchParams.get('sessionId')).toBe('session-1');
    expect(url.searchParams.get('project')).toBe('/source');
  });

  it('renders uploaded and generated media in the conversation', async () => {
    const createObjectURL = vi.fn(() => 'blob:media-fixture');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    try {
      const user = renderEntry({
        ...toolResultEntry(), type: 'user_message', text: 'Describe these files',
        metadata: { attachments: [
          { type: 'file', name: 'clip.mp4', mimeType: 'video/mp4', data: 'Y2xpcA==' },
          { type: 'file', name: 'speech.mp3', mimeType: 'audio/mpeg', data: 'c3BlZWNo' },
        ] },
      });
      await waitFor(() => expect(user.container.querySelector('video')).toBeTruthy());
      expect(user.container.querySelector('audio')).toBeTruthy();
      user.unmount();

      vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true, data: {
        videoBase64: 'Y2xpcA==', mimeType: 'video/mp4', prompt: 'A cat surfing',
      } }));
      const generated = renderEntry(toolResultEntry({ toolResult: {
        name: 'generate_video', output: JSON.stringify({ historyId: 'clip-1' }), isError: false,
      } }));
      await waitFor(() => expect(generated.container.querySelector('video')).toBeTruthy());
      expect(screen.getByText('A cat surfing')).toBeTruthy();
      generated.unmount();
      expect(revokeObjectURL).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it('opens flat details with the command, line count, and copy action', async () => {
    const { container } = renderEntry(toolResultEntry());

    const onAnchor = vi.fn();
    container.addEventListener(EXPAND_ANCHOR_EVENT, onAnchor);
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(toggle);

    const details = screen.getByRole('region', { name: 'Tool details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', details.id);
    expect(container.querySelector('pre.tool-output-pre')).toHaveClass('max-h-80', 'overflow-auto');
    expect(container.querySelector('pre.tool-output-pre')).toHaveAttribute('tabindex', '0');
    expect(onAnchor).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Terminal Output')).toBeTruthy();
    expect(screen.getAllByText('bash').length).toBeGreaterThan(0);
    expect(screen.getByText('git diff')).toBeTruthy();
    expect(screen.getByText('3 lines')).toBeTruthy();
    expect(container.querySelector('pre.tool-output-pre')?.textContent).toBe(OUTPUT);

    await fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(mocks.copyText).toHaveBeenCalledWith(OUTPUT);

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse details' }));
    expect(screen.queryByText('Terminal Output')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    expect(onAnchor).toHaveBeenCalledTimes(2);
  });

  it('keeps long tool logs clipped and bounded', async () => {
    const output = 'x'.repeat(8_000);
    const { container } = renderEntry(
      toolResultEntry({
        toolResult: { name: 'bash', output, isError: false },
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const log = container.querySelector('pre.tool-output-pre');
    expect(log?.textContent).toBe(`${output.slice(0, 4_000)}\n\n…output clipped`);
    expect(log).toHaveClass('max-h-80', 'overflow-auto');
  });

  it('does not treat nested action keys as row selection', async () => {
    const onSelect = vi.fn();
    render(FeedEntry, {
      props: {
        entry: toolResultEntry(),
        isSelected: false,
        isExpanded: false,
        onSelect,
        onToggleGroup: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Details' }), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    await fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state and omits copy when nothing was reported', async () => {
    renderEntry(
      toolResultEntry({
        toolCall: { name: 'kory_lookup', input: {} },
        toolResult: { name: 'kory_lookup', output: '', isError: false },
      }),
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('Tool Output')).toBeTruthy();
    expect(screen.getByText('No output was reported.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy output' })).toBeNull();
  });
});
