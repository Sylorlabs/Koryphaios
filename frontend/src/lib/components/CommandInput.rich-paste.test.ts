// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadComposerDraft } from '$lib/stores/composer-drafts';

vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
// The icon's SvelteKit asset base is unrelated to composer behavior.
vi.mock('./icons/ProviderIcon.svelte', async () => ({
  default: (await import('lucide-svelte/icons/circle')).default,
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    providers: [{ name: 'openai', enabled: true, authenticated: true, models: ['test-model'] }],
    feed: [],
    setYoloMode: vi.fn(),
    contextUsage: null,
  },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: null } }));
vi.mock('$lib/stores/project.svelte', () => ({ projectStore: { currentPath: null } }));
vi.mock('$lib/stores/goals.svelte', () => ({
  goalStore: { goals: [], loaded: true, refresh: vi.fn(), selectedGoalId: '' },
}));
vi.mock('$lib/stores/goal-display.svelte', () => ({
  goalDisplayStore: { composer: false, update: vi.fn() },
}));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useNow: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
  useSecondClock: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
}));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { settings: {}, loadSettings: vi.fn() },
}));

import CommandInput from './CommandInput.svelte';

function composer() {
  const onSend = vi.fn();
  const result = render(CommandInput, {
    onSend,
    selectedModel: 'openai:test-model',
    disableModelPreviewRequests: true,
    draftKey: 'rich-paste-test',
  });
  return { ...result, onSend, input: result.container.querySelector('textarea')! };
}

function paste(input: HTMLTextAreaElement, html: string, plain = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/html' ? html : plain),
      items: [],
      files: [],
    },
  });
  input.dispatchEvent(event);
  return event;
}

function expectNoPreview() {
  expect(screen.queryByText('Markdown and LaTeX supported')).toBeNull();
  expect(screen.queryByText(/Rich paste (preserved|converted)/)).toBeNull();
  expect(screen.queryByRole('button', { name: /preview.*format|format.*preview/i })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Formatting preview' })).toBeNull();
}

describe('composer rich paste without a separate preview', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    // jsdom has no native undo stack; exercise the explicit insertion fallback.
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
  });

  it('replaces selection with editable Markdown and recovers the persisted draft without preview UI', async () => {
    const { input, unmount } = composer();
    expectNoPreview();
    await fireEvent.input(input, { target: { value: 'before SELECT after' } });
    input.focus();
    input.setSelectionRange(7, 13);
    expect(paste(input, '<strong>Neptune</strong>').defaultPrevented).toBe(true);
    await waitFor(() => expect(input.value).toBe('before **Neptune** after'));
    expect(input.selectionStart).toBe(18);
    expect(document.activeElement).toBe(input);
    expectNoPreview();
    await waitFor(() => expect(loadComposerDraft('rich-paste-test').text).toBe(input.value));
    unmount();
    const recovered = composer();
    expect(recovered.input.value).toBe('before **Neptune** after');
    expectNoPreview();
  });

  it('keeps math editable and leaves ordinary paste to the browser', async () => {
    const { input } = composer();
    expect(paste(input, '', 'plain text').defaultPrevented).toBe(false);
    const source = String.raw`$$ T=\sqrt{a^3} $$ $$ T=0.24078\text{ years} $$`;
    await fireEvent.input(input, { target: { value: source } });
    expectNoPreview();
    expect(input.value).toBe(source);
    await fireEvent.input(input, { target: { value: '' } });
    expectNoPreview();
  });

  it('pastes and sends consecutive math sources unchanged with Enter', async () => {
    const { input, onSend } = composer();
    const html = ['x^2', 'y^3']
      .map(
        (tex) =>
          `<div class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span></div>`,
      )
      .join('');
    input.focus();
    expect(paste(input, html).defaultPrevented).toBe(true);
    // Each recovered display block contributes its own surrounding spacing.
    await waitFor(() => expect(input.value).toBe('$$\nx^2\n$$\n\n\n\n$$\ny^3\n$$'));
    const source = input.value;
    expectNoPreview();
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe(source);
    await waitFor(() => expect(input.value).toBe(''));
    expectNoPreview();
  });

  it('retains editable math when a send is not accepted', async () => {
    const { input, onSend } = composer();
    onSend.mockReturnValue(false);
    const source = String.raw`$$x^2$$ $$y^3$$`;
    await fireEvent.input(input, { target: { value: source } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(input.value).toBe(source);
    await waitFor(() => expect(loadComposerDraft('rich-paste-test').text).toBe(source));
    expectNoPreview();
  });
});
