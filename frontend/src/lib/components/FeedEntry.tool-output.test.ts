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
import { EXPAND_ANCHOR_EVENT, READER_RESIZE_EVENT } from '$lib/utils/expand-anchor';
import { agentStore } from '$lib/stores/agents.svelte';
import AgentToolFeedHarness from './__fixtures__/AgentToolFeedHarness.svelte';

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
        ...toolResultEntry(),
        type: 'user_message',
        text: 'Describe these files',
        metadata: {
          attachments: [
            { type: 'file', name: 'clip.mp4', mimeType: 'video/mp4', data: 'Y2xpcA==' },
            { type: 'file', name: 'speech.mp3', mimeType: 'audio/mpeg', data: 'c3BlZWNo' },
          ],
        },
      });
      await waitFor(() => expect(user.container.querySelector('video')).toBeTruthy());
      expect(user.container.querySelector('audio')).toBeTruthy();
      user.unmount();

      vi.mocked(apiFetch).mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            videoBase64: 'Y2xpcA==',
            mimeType: 'video/mp4',
            prompt: 'A cat surfing',
          },
        }),
      );
      const generated = renderEntry(
        toolResultEntry({
          toolResult: {
            name: 'generate_video',
            output: JSON.stringify({ historyId: 'clip-1' }),
            isError: false,
          },
        }),
      );
      await waitFor(() => expect(generated.container.querySelector('video')).toBeTruthy());
      expect(screen.getByText('A cat surfing')).toBeTruthy();
      generated.unmount();
      expect(revokeObjectURL).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens details from the highlighted command and returns focus on collapse', async () => {
    const { container } = renderEntry(toolResultEntry());

    const onAnchor = vi.fn();
    const onReaderResize = vi.fn();
    container.addEventListener(EXPAND_ANCHOR_EVENT, onAnchor);
    container.addEventListener(READER_RESIZE_EVENT, onReaderResize);
    const toggle = screen.getByRole('button', { name: 'Ran git diff' });
    expect(toggle.querySelector('.tool-name')?.textContent).toBe('bash');
    expect(toggle).toHaveAccessibleDescription('bash');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Tool details' })).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    await fireEvent.click(toggle);

    const details = screen.getByRole('region', { name: 'Tool details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', details.id);
    expect(container.querySelector('pre.tool-output-pre')).toHaveClass('max-h-80', 'overflow-auto');
    expect(container.querySelector('pre.tool-output-pre')).toHaveAttribute('tabindex', '0');
    expect(onAnchor).not.toHaveBeenCalled();
    expect(onReaderResize).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Command input' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Command output' })).toBeTruthy();
    expect(screen.getByText('Input', { exact: true })).toBeTruthy();
    expect(screen.getByText('Output', { exact: true })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Command' }).textContent).toBe('$ git diff');
    expect(container.querySelector('pre.tool-output-pre')?.textContent).toBe(OUTPUT);

    // The summary stays in place while the details grow below it, so the same
    // pointer target can close the panel without moving back to its header.
    await fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Tool details' })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(onAnchor).not.toHaveBeenCalled();
    expect(onReaderResize).toHaveBeenCalledTimes(2);

    await fireEvent.click(toggle);

    await fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(mocks.copyText).toHaveBeenCalledWith(OUTPUT);
    await fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(mocks.copyText).toHaveBeenLastCalledWith('git diff');

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse details' }));
    expect(screen.queryByRole('region', { name: 'Tool details' })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('keeps long tool logs clipped and bounded', async () => {
    const output = 'x'.repeat(8_000);
    const { container } = renderEntry(
      toolResultEntry({
        toolResult: { name: 'bash', output, isError: false },
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Ran git diff' }));
    const log = container.querySelector('pre.tool-output-pre');
    expect(log?.textContent).toBe(`${output.slice(0, 4_000)}\n\n…output clipped`);
    expect(log).toHaveClass('max-h-80', 'overflow-auto');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(mocks.copyText).toHaveBeenCalledWith(output);
  });

  it('keeps the action name stable while exposing live and completed durations as descriptions', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const completed = toolResultEntry({
        toolResult: { name: 'bash', output: OUTPUT, isError: false, durationMs: 1200 },
      });
      const { rerender, unmount } = renderEntry({
        ...completed,
        type: 'tool_call',
        timestamp: Date.now() - 1000,
        metadata: { toolCall: completed.metadata?.toolCall },
      });
      const toggle = screen.getByRole('button', { name: 'Running git diff' });
      expect(toggle).toHaveTextContent('1.0 s');
      expect(toggle).toHaveAccessibleDescription('bash 1.0 s');

      await vi.advanceTimersByTimeAsync(1000);
      expect(screen.getByRole('button', { name: 'Running git diff' })).toBe(toggle);
      expect(toggle).toHaveTextContent('2.0 s');
      expect(toggle).toHaveAccessibleDescription('bash 2.0 s');

      await rerender({ entry: completed });
      expect(screen.getByRole('button', { name: 'Ran git diff' })).toBe(toggle);
      expect(toggle).toHaveTextContent('1.2 s');
      expect(toggle).toHaveAccessibleDescription('bash 1.2 s');
      await vi.advanceTimersByTimeAsync(1000);
      expect(toggle).toHaveAccessibleDescription('bash 1.2 s');
      unmount();
    } finally {
      vi.useRealTimers();
    }
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
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Ran git diff' }), { key: 'Enter' });
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

    await fireEvent.click(screen.getByRole('button', { name: 'Used kory_lookup' }));

    expect(screen.getByText('Output')).toBeTruthy();
    expect(screen.getByText('No output was reported.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy output' })).toBeNull();
  });

  it('keeps a completed edit visible and reveals the actual change from the filename', async () => {
    const { container } = renderEntry(
      toolResultEntry({
        toolCall: {
          name: 'edit_file',
          input: {
            path: 'src/theme.ts',
            old_string: 'compact: false',
            new_string: 'compact: true',
          },
        },
        toolResult: { name: 'edit_file', output: 'File updated successfully', isError: false },
      }),
    );
    const toggle = screen.getByRole('button', { name: 'Edited theme.ts' });
    expect(screen.queryByText('compact: true')).toBeNull();
    await fireEvent.click(toggle);
    expect(screen.getByText('Changes')).toBeTruthy();
    expect(screen.getByText('src/theme.ts')).toBeTruthy();
    expect(container.querySelector('.file-paths')).toHaveStyle({
      flexDirection: 'column',
    });
    expect(container.querySelector('.removed')?.textContent).toContain('compact: false');
    expect(container.querySelector('.added')?.textContent).toContain('compact: true');
    expect(container.querySelector('.raw-output')).not.toHaveAttribute('open');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(mocks.copyText).toHaveBeenCalledWith('- compact: false\n+ compact: true');
  });

  it('opens grouped operations individually instead of expanding every output', async () => {
    renderEntry({
      ...toolResultEntry(),
      type: 'tool_group',
      metadata: {},
      entries: [
        {
          ...toolResultEntry(),
          id: 'read-1',
          metadata: {
            toolCall: { name: 'read_file', input: { path: 'src/theme.ts' } },
            toolResult: {
              name: 'read_file',
              output: 'export const theme = {};',
              isError: false,
              durationMs: 10,
            },
          },
        },
        {
          ...toolResultEntry(),
          id: 'search-1',
          metadata: {
            toolCall: { name: 'grep', input: { pattern: 'surface' } },
            toolResult: {
              name: 'grep',
              output: 'theme.ts:12: surface',
              isError: false,
              durationMs: 20,
            },
          },
        },
      ],
    } as FeedEntryLocal);
    const group = screen.getByRole('button', { name: 'Read theme.ts → searched “surface”' });
    expect(group).toHaveTextContent('30 ms');
    expect(group).toHaveAccessibleDescription('30 ms');
    await fireEvent.click(group);
    expect(screen.queryByText('export const theme = {};')).toBeNull();
    expect(screen.queryByText('theme.ts:12: surface')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Read theme.ts' }));
    expect(screen.getByText('export const theme = {};')).toBeTruthy();
    expect(screen.queryByText('theme.ts:12: surface')).toBeNull();
  });

  it('shows failure in the summary and reveals diagnostics instead of a successful diff', async () => {
    const { container } = renderEntry(
      toolResultEntry({
        toolCall: {
          name: 'edit_file',
          input: { path: 'src/theme.ts', old_string: 'old', new_string: 'new' },
        },
        toolResult: { name: 'edit_file', output: 'Original text not found', isError: true },
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'edit_file failed theme.ts' }));
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('Original text not found')).toBeTruthy();
    expect(container.querySelector('.added')).toBeNull();
  });

  it('names a legacy failed MCP grep in the summary and preserves its diagnostic', async () => {
    const output =
      "Input validation error: Invalid arguments for tool kory__grep: data must have required property 'pattern'";
    renderEntry(
      toolResultEntry({
        toolCall: { name: 'call_mcp_tool', input: {} },
        toolResult: { name: 'call_mcp_tool', output, isError: true },
      }),
    );
    const toggle = screen.getByRole('button', { name: 'grep failed' });
    expect(toggle).not.toHaveTextContent('call_mcp_tool');
    await fireEvent.click(toggle);
    expect(screen.getByText(output)).toBeTruthy();
  });

  it('identifies a successful CLI MCP call by server and destination rather than the dispatcher', async () => {
    renderEntry(
      toolResultEntry({
        toolCall: {
          name: 'call_mcp_tool',
          input: {
            server_name: 'github',
            tool_name: 'list_issues',
            arguments: { repo: 'app' },
          },
        },
        toolResult: { name: 'call_mcp_tool', output: 'Open issues: 3', isError: false },
      }),
    );
    const toggle = screen.getByRole('button', { name: 'Used github MCP · list_issues' });
    expect(toggle).not.toHaveTextContent('call_mcp_tool');
    await fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Tool details' })).toHaveTextContent(
      'github MCP · list_issues',
    );
    expect(screen.getByText('Open issues: 3')).toBeTruthy();
  });

  it.each(['mcp__kory__kory__read_file', 'kory__read_file'])(
    'presents restored %s as a native file action',
    async (name) => {
      renderEntry(
        toolResultEntry({
          toolCall: { name, input: { path: 'README.md' } },
          toolResult: { name, output: 'Readme', isError: false },
        }),
      );
      const toggle = screen.getByRole('button', { name: 'Read README.md' });
      expect(toggle).toHaveTextContent('Read README.md');
      expect(toggle).not.toHaveTextContent(/MCP|kory__/);
      expect(toggle).not.toHaveAttribute('aria-describedby');
      await fireEvent.click(toggle);
      expect(screen.getByRole('region', { name: 'Tool details' })).not.toHaveTextContent(
        /MCP|kory__/,
      );
      expect(screen.getByLabelText('Tool output')).toHaveTextContent('Readme');
    },
  );

  it.each([
    'rename_session',
    'kory__rename_session',
    'mcp__kory__kory__rename_session',
    'call_mcp_tool',
  ])('shows %s as a session rename through running, completed, and failed states', async (name) => {
    const input =
      name === 'call_mcp_tool'
        ? {
            server_name: 'kory',
            tool_name: 'kory__rename_session',
            arguments: { title: 'Tool Animation Fix' },
          }
        : { title: 'Tool Animation Fix' };
    const pending: FeedEntryLocal = {
      ...toolResultEntry(),
      type: 'tool_call',
      metadata: { toolCall: { name, input } },
    };
    const { container, rerender } = renderEntry(pending);
    const toggle = screen.getByRole('button', { name: 'Renaming session Tool Animation Fix' });
    expect(toggle).not.toHaveTextContent(/MCP|call_mcp_tool/);
    expect(container.querySelector('[data-tool-icon="session"]')).toBeTruthy();
    await fireEvent.click(toggle);
    await rerender({
      entry: {
        ...pending,
        type: 'tool_result',
        metadata: {
          ...pending.metadata,
          toolResult: { name, output: 'Session renamed to: Tool Animation Fix', isError: false },
        },
      },
    });
    expect(screen.getByRole('button', { name: 'Renamed session Tool Animation Fix' })).toBe(toggle);
    expect(screen.getByRole('region', { name: 'Tool details' })).not.toHaveTextContent('MCP');
    await rerender({
      entry: {
        ...pending,
        type: 'tool_result',
        metadata: {
          ...pending.metadata,
          toolResult: { name, output: 'Error: Session unavailable', isError: true },
        },
      },
    });
    expect(screen.getByRole('button', { name: 'Rename session failed Tool Animation Fix' })).toBe(
      toggle,
    );
    expect(screen.getByText('Error: Session unavailable')).toBeTruthy();
  });

  it('shows a live Antigravity edit, completion and failure without bridge labels', async () => {
    const input = {
      ServerName: 'kory',
      ToolName: 'kory__edit_file',
      Arguments: { path: 'src/theme.ts', old_str: 'before', new_str: 'after' },
    };
    const pending: FeedEntryLocal = {
      ...toolResultEntry(),
      type: 'tool_call',
      metadata: {
        toolCall: { name: 'call_mcp_tool', input },
        toolInputPreview: JSON.stringify(input),
      },
    };
    const { rerender } = renderEntry(pending);
    const toggle = screen.getByRole('button', { name: 'Editing theme.ts' });
    expect(toggle).not.toHaveTextContent(/MCP|kory__|call_mcp_tool/);
    expect(toggle.getAttribute('title')).not.toMatch(/MCP|kory__|call_mcp_tool/);
    await fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Tool details' })).not.toHaveTextContent(
      /MCP|kory__|call_mcp_tool/,
    );
    expect(screen.getByLabelText('File changes')).toHaveTextContent('- before');
    expect(screen.getByLabelText('File changes')).toHaveTextContent('+ after');

    const completed: FeedEntryLocal = {
      ...pending,
      type: 'tool_result',
      metadata: {
        ...pending.metadata,
        toolResult: { name: 'call_mcp_tool', output: 'Updated', isError: false },
      },
    };
    await rerender({ entry: completed });
    expect(screen.getByRole('button', { name: 'Edited theme.ts' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await rerender({
      entry: {
        ...completed,
        metadata: {
          ...completed.metadata,
          toolResult: { name: 'call_mcp_tool', output: 'Original text not found', isError: true },
        },
      },
    });
    expect(screen.getByRole('button', { name: 'edit file failed theme.ts' })).not.toHaveTextContent(
      /MCP|kory__/,
    );
    expect(screen.getByLabelText('Tool output')).toHaveTextContent('Original text not found');
  });

  it('hides dispatcher plumbing in an Antigravity command card but keeps command and output', async () => {
    const input = {
      ServerName: 'kory',
      ToolName: 'kory__bash',
      Arguments: { command: 'git status' },
    };
    renderEntry(
      toolResultEntry({
        toolCall: { name: 'call_mcp_tool', input },
        toolInputPreview: JSON.stringify(input),
        toolResult: { name: 'call_mcp_tool', output: 'Working tree clean', isError: false },
      }),
    );
    const toggle = screen.getByRole('button', { name: 'Ran git status' });
    expect(toggle).not.toHaveTextContent(/MCP|kory__|call_mcp_tool/);
    await fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Tool details' })).not.toHaveTextContent(
      /MCP|kory__|call_mcp_tool|ServerName/,
    );
    expect(screen.getByRole('region', { name: 'Command' })).toHaveTextContent('git status');
    expect(screen.getByLabelText('Tool output')).toHaveTextContent('Working tree clean');
  });

  it('preserves open details when a running file edit completes', async () => {
    const completed = toolResultEntry({
      toolCall: {
        name: 'edit_file',
        input: { path: 'src/theme.ts', old_str: 'before', new_str: 'after' },
      },
      toolResult: { name: 'edit_file', output: 'Updated', isError: false },
    });
    const { rerender } = renderEntry({
      ...completed,
      type: 'tool_call',
      metadata: { toolCall: completed.metadata?.toolCall },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Editing theme.ts' }));
    await rerender({ entry: completed });
    expect(screen.getByRole('button', { name: 'Edited theme.ts' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Tool details' })).toBeTruthy();
  });

  it('summarizes long commands and shows their output beneath the command', async () => {
    const command =
      'set -e; TESTDIR="/tmp/kory-safe-destructive-test-$${RANDOM}"; mkdir -p "$TESTDIR"; echo "Created TESTDIR=$TESTDIR"; echo "hello world" > "$TESTDIR/file1.txt"; ls -R "$TESTDIR"; rm -rf "$TESTDIR"';
    renderEntry(
      toolResultEntry({
        toolCall: { name: 'bash', input: { command } },
        toolResult: {
          name: 'bash',
          output: 'Created TESTDIR=/tmp/kory-safe-destructive-test-123\nfile1.txt',
          isError: false,
        },
      }),
    );

    const toggle = screen.getByRole('button', { name: 'Command executed' });
    expect(toggle).not.toHaveTextContent(command);
    await fireEvent.click(toggle);
    expect(screen.getByText('Input', { exact: true })).toBeTruthy();
    expect(screen.getByText('Output', { exact: true })).toBeTruthy();
    expect(screen.getByLabelText('Tool output')).toHaveTextContent(
      /Created TESTDIR=.*123\s+file1\.txt/,
    );
    expect(screen.getByRole('region', { name: 'Command' }).textContent).toContain(command);
  });

  it('replaces executing command with command executed when the result arrives', async () => {
    const command =
      'set -e; TESTDIR="/tmp/kory-long-command-state-transition"; mkdir -p "$TESTDIR"; echo done';
    const pending = {
      ...toolResultEntry(),
      type: 'tool_call' as const,
      metadata: { toolCall: { name: 'bash', input: { command } } },
    };
    const completed = toolResultEntry({
      toolCall: { name: 'bash', input: { command } },
      toolResult: { name: 'bash', output: 'done', isError: false },
    });
    const { rerender } = renderEntry(pending);
    const toggle = screen.getByRole('button', { name: 'Executing command' });
    await fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Command input' })).toHaveTextContent(command);
    expect(screen.getByRole('region', { name: 'Command output' })).toHaveTextContent(
      'Waiting for output…',
    );
    await rerender({ entry: completed });
    expect(screen.getByRole('button', { name: 'Command executed' })).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: 'Executing command' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Command input' })).toHaveTextContent(command);
    expect(screen.getByRole('region', { name: 'Command output' })).toHaveTextContent('done');
  });

  it('keeps failed command input separate from diagnostics', async () => {
    renderEntry(
      toolResultEntry({
        toolCall: {
          name: 'bash',
          input: { command: 'bun run missing-script', workdir: '/workspace/app' },
        },
        toolResult: { name: 'bash', output: 'Script not found', isError: true, durationMs: 12 },
      }),
    );
    const toggle = screen.getByRole('button', { name: 'bash failed bun run missing-script' });
    expect(toggle).toHaveAccessibleDescription('12 ms');
    await fireEvent.click(toggle);
    const input = screen.getByRole('region', { name: 'Command input' });
    const output = screen.getByRole('region', { name: 'Command output' });
    expect(input).toHaveTextContent('bun run missing-script');
    expect(input).toHaveTextContent('/workspace/app');
    expect(input).not.toHaveTextContent('Script not found');
    expect(output).toHaveTextContent('Script not found');
    expect(output).toHaveTextContent('Failed · 12 ms');
    expect(output).not.toHaveTextContent('bun run missing-script');
  });

  it.each([
    [
      'read_note',
      { title: 'Research' },
      'Reading note Research',
      'Read note Research',
      'note',
      'read',
    ],
    [
      'create_note',
      { title: 'Research', content: 'New findings' },
      'Creating note Research',
      'Created note Research',
      'note',
      'create',
    ],
    [
      'update_note',
      { title: 'Research', content: 'Updated findings' },
      'Editing note Research',
      'Edited note Research',
      'note',
      'edit',
    ],
    ['read_note_base', { baseId: 'b1' }, 'Reading Base b1', 'Read Base b1', 'base', 'read'],
    [
      'create_note_base',
      { name: 'Projects' },
      'Creating Base Projects',
      'Created Base Projects',
      'base',
      'create',
    ],
    [
      'update_note_base',
      { baseId: 'b1', name: 'Projects' },
      'Editing Base Projects',
      'Edited Base Projects',
      'base',
      'edit',
    ],
    ['get_note_graph_summary', {}, 'Reading note network', 'Read note network', 'network', 'read'],
    [
      'link_notes',
      { fromTitle: 'Research', toTitle: 'Findings' },
      'Linking notes · Research → Findings',
      'Linked notes · Research → Findings',
      'network',
      'link',
    ],
    [
      'create_note_canvas',
      { document: { name: 'Sprint' } },
      'Creating canvas Sprint',
      'Created canvas Sprint',
      'canvas',
      'create',
    ],
    [
      'patch_note_canvas',
      { name: 'Sprint', noteId: 'n1' },
      'Editing canvas Sprint',
      'Edited canvas Sprint',
      'canvas',
      'edit',
    ],
  ] as const)(
    'preserves %s details and its own icon when it completes',
    async (name, input, running, complete, icon, intent) => {
      const pending: FeedEntryLocal = {
        ...toolResultEntry(),
        type: 'tool_call',
        metadata: { toolCall: { id: 'call-1', name: `kory__${name}`, input } },
      };
      const { container, rerender } = renderEntry(pending);
      const marker = container.querySelector('.activity-icon');
      expect(marker).toHaveAttribute('data-tool-icon', icon);
      expect(marker).toHaveAttribute('data-tool-intent', intent);
      expect(marker).toHaveAttribute('data-tool-state', 'running');
      const toggle = screen.getByRole('button', { name: running });
      await fireEvent.click(toggle);
      expect(screen.getByRole('region', { name: 'Tool input' })).toBeTruthy();
      await rerender({
        entry: {
          ...pending,
          type: 'tool_result',
          metadata: {
            ...pending.metadata,
            toolResult: {
              callId: 'call-1',
              name: `kory__${name}`,
              output: '{"status":"saved"}',
              isError: false,
            },
          },
        },
      });
      expect(screen.getByRole('button', { name: complete })).toBe(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('button', { name: running })).toBeNull();
      expect(container.querySelector('.activity-icon')).toBe(marker);
      expect(marker).toHaveAttribute('data-tool-state', 'completed');
      expect(marker).toHaveAttribute('data-tool-icon', icon);
      expect(screen.getByRole('region', { name: 'Tool response' })).toHaveTextContent('saved');
    },
  );

  it('keeps note input separate from the real output and shows action icons inside groups', async () => {
    const created = toolResultEntry({
      toolCall: { name: 'create_note', input: { title: 'Research', content: 'New findings' } },
      toolResult: { name: 'create_note', output: '{"id":"n1","title":"Research"}', isError: false },
    });
    const { container } = renderEntry({
      ...created,
      type: 'tool_group',
      metadata: {},
      entries: [created],
    });
    await fireEvent.click(container.querySelector('.tool-summary') as HTMLElement);
    expect(container.querySelector('[data-tool-icon="note"]')).toHaveAttribute(
      'data-tool-intent',
      'create',
    );
    // A one-step group narrates the same words as its step; open the step itself.
    await fireEvent.click(screen.getAllByRole('button', { name: 'Created note Research' }).at(-1)!);
    expect(screen.getByRole('region', { name: 'Tool input' })).toHaveTextContent('New findings');
    expect(screen.getByRole('region', { name: 'Tool response' })).toHaveTextContent('n1');
    expect(screen.getByRole('region', { name: 'Tool response' })).not.toHaveTextContent(
      'New findings',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Copy input' }));
    expect(mocks.copyText).toHaveBeenLastCalledWith(
      JSON.stringify({ title: 'Research', content: 'New findings' }, null, 2),
    );
  });

  it('updates the actual agent drilldown while keeping the same open tool row', async () => {
    const sessionId = 'agent-tool-render';
    const agentId = 'canvas-worker';
    agentStore.upsertAgentThreadEntry(sessionId, agentId, {
      timestamp: 100,
      type: 'tool_call',
      agentId,
      agentName: 'Worker',
      glowClass: '',
      text: '',
      metadata: { toolCall: { id: 'canvas-call', name: 'patch_note_canvas', input: {} } },
    });
    render(AgentToolFeedHarness, { sessionId, agentId });
    const toggle = screen.getByRole('button', { name: 'Editing canvas' });
    await fireEvent.click(toggle);
    agentStore.upsertAgentThreadEntry(sessionId, agentId, {
      timestamp: 150,
      type: 'tool_call',
      agentId,
      agentName: 'Worker',
      glowClass: '',
      text: '',
      metadata: {
        toolCall: {
          id: 'canvas-call',
          name: 'patch_note_canvas',
          input: { name: 'Sprint', noteId: 'n1' },
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Editing canvas Sprint' })).toBe(toggle),
    );
    agentStore.completeAgentThreadEntry(
      sessionId,
      agentId,
      'canvas-call',
      'Updated canvas',
      {
        callId: 'canvas-call',
        name: 'patch_note_canvas',
        output: '{"revision":2}',
        isError: false,
      },
      200,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edited canvas Sprint' })).toBe(toggle),
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Tool response' })).toHaveTextContent('2');
  });
});
