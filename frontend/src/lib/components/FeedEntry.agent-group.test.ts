import { fireEvent, render, screen } from '@testing-library/svelte';
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
  sessionStore: { activeSessionId: 'session-1', fetchMessages: vi.fn() },
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

// A worker that pastes a full tool log into its reply. This is the shape that
// used to render as hundreds of wrapped lines inside the manager feed.
const RAW_LOG = Array.from(
  { length: 200 },
  (_, i) => `${i + 1} run_dynamic_abi_${i}.sh (non) ${i + 1} run_script_json_root.sh`,
).join('\n');

function subAgentEntry(text: string, isCollapsed = true): FeedEntryLocal {
  return {
    id: 'agent-group-1',
    timestamp: 100,
    type: 'agent_group',
    agentId: 'worker-1',
    agentName: 'Critic',
    glowClass: 'glow-claude',
    text: 'Critic — 1 step',
    entries: [
      {
        id: 'sub-1',
        timestamp: 100,
        type: 'content',
        agentId: 'worker-1',
        agentName: 'Critic',
        glowClass: 'glow-claude',
        text,
      } as FeedEntryLocal,
    ],
    isCollapsed,
    metadata: { domain: 'critic' },
  } as FeedEntryLocal;
}

function renderGroup(isExpanded: boolean, onToggleGroup = vi.fn()) {
  const result = render(FeedEntry, {
    props: {
      entry: subAgentEntry(RAW_LOG),
      isSelected: false,
      isExpanded,
      onSelect: vi.fn(),
      onToggleGroup,
      onDelete: vi.fn(),
    },
  });
  return {
    ...result,
    onToggleGroup,
    // The clamped summary row. Queried directly rather than via getByTitle,
    // which cannot match a multi-kilobyte multi-line attribute value.
    summary: () =>
      result.container.querySelector<HTMLElement>('.agent-group-scroll span[title]'),
  };
}

describe('sub-agent group rows never dump raw logs into the feed', () => {
  beforeEach(() => {
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(undefined);
  });

  it('ships collapsed by default so worker logs never flood the feed', () => {
    expect(subAgentEntry(RAW_LOG).isCollapsed).toBe(true);
  });

  it('clamps a verbose sub-agent step to a one-line summary', () => {
    const summary = renderGroup(true).summary();

    expect(summary).not.toBeNull();
    expect(summary!.textContent).not.toBe(RAW_LOG);
    expect(summary!.textContent!.length).toBeLessThanOrEqual(221);
    expect(summary!.textContent).toContain('run_dynamic_abi_0.sh');
    // Whitespace is collapsed so a log's newlines can't re-expand the row.
    expect(summary!.textContent).not.toContain('\n');
    expect(summary!.textContent!.endsWith('…')).toBe(true);
    // The unclamped text is still reachable.
    expect(summary!.getAttribute('title')).toBe(RAW_LOG);
    expect(summary!.className).toContain('truncate');
  });

  it('bounds the expanded group so it cannot fill the viewport', () => {
    const { container } = renderGroup(true);

    const scroller = container.querySelector('.agent-group-scroll');
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain('max-h-56');
    expect(scroller!.className).toContain('overflow-y-auto');
  });

  it('renders no sub-agent rows at all while collapsed, and toggles on click', async () => {
    const onToggleGroup = vi.fn();
    const { container } = render(FeedEntry, {
      props: {
        entry: subAgentEntry(RAW_LOG),
        isSelected: false,
        isExpanded: false,
        onSelect: vi.fn(),
        onToggleGroup,
        onDelete: vi.fn(),
      },
    });

    expect(container.querySelector('.agent-group-scroll')).toBeNull();
    expect(screen.getByText('Critic — 1 step')).toBeTruthy();

    await fireEvent.click(screen.getByRole('row'));
    expect(onToggleGroup).toHaveBeenCalled();
  });
});
