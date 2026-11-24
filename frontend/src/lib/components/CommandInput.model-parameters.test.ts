// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadComposerPreference } from '$lib/stores/composer-preferences';
import type { ModelParameterDef } from '@koryphaios/shared';

const TEMPERATURE: ModelParameterDef = {
  key: 'temperature',
  label: 'Temperature',
  kind: 'float',
  min: 0,
  max: 2,
  step: 0.01,
  default: 1,
  defaultSource: 'documented',
  description: 'Test temperature.',
};
const SEED: ModelParameterDef = {
  key: 'seed',
  label: 'Seed',
  kind: 'integer',
  step: 1,
  description: 'Test seed.',
};
const MAX_TOKENS: ModelParameterDef = {
  key: 'max_tokens',
  label: 'Max output tokens',
  kind: 'integer',
  min: 1,
  max: 128_000,
  step: 1,
  description: 'Test max output tokens.',
};
const VERBOSITY: ModelParameterDef = {
  key: 'verbosity',
  label: 'Verbosity',
  kind: 'enum',
  options: ['low', 'medium', 'high'],
  description: 'Test verbosity.',
};

const { catalog } = vi.hoisted(() => ({
  catalog: {
    name: 'openrouter',
    id: 'test/model',
    parameters: undefined as ModelParameterDef[] | undefined,
  },
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./icons/ProviderIcon.svelte', async () => ({
  default: (await import('lucide-svelte/icons/circle')).default,
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    get providers() {
      return [
        {
          name: catalog.name,
          enabled: true,
          authenticated: true,
          models: [catalog.id],
          allAvailableModels: [
            { id: catalog.id, name: catalog.id, parameters: catalog.parameters },
          ],
        },
      ];
    },
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

const model = 'openrouter:test/model';
function composer(selectedModel: string = model) {
  const onSend = vi.fn((..._args: unknown[]) => true);
  const result = render(CommandInput, {
    onSend,
    selectedModel,
    disableModelPreviewRequests: true,
    draftKey: 'model-params-test',
  });
  return { ...result, onSend, input: result.container.querySelector('textarea')! };
}

/** Drive the first parameter's slider to its max via the keyboard. */
async function setFirstParameter() {
  const slider = screen.getByRole('slider', { name: 'Temperature' });
  await fireEvent.keyDown(slider, { key: 'End' });
}

describe('composer model-settings control', () => {
  beforeEach(() => {
    localStorage.clear();
    catalog.parameters = [TEMPERATURE, SEED];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('shows the chip for a model with parameters and hides after switching to one without', async () => {
    const { rerender } = composer();
    await screen.findByTestId('composer-model-params-control');
    await rerender({ selectedModel: 'openrouter:other/model' });
    await waitFor(() => expect(screen.queryByTestId('composer-model-params-control')).toBeNull());
  });

  it('opens the panel, lists each parameter, and a change persists per provider:model', async () => {
    composer();
    await screen.findByLabelText('Model settings');
    await fireEvent.click(screen.getByLabelText('Model settings'));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Temperature');
    expect(panel.textContent).toContain('Test temperature.');
    // No "Default" annotation anywhere — the slider sits at the default and
    // shows its value; the source is self-explanatory.
    expect(panel.textContent).not.toContain('Default');
    // One control per row: a slider for bounded temperature, a stepper for the
    // unbounded seed — and no stepper hiding inside the slider row.
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    // Adjust temperature via its slider → override persisted for this model.
    await setFirstParameter();
    await waitFor(() =>
      expect(loadComposerPreference(model).modelParameters).toEqual({ temperature: 2 }),
    );
    // The launcher always keeps its name after a parameter is overridden.
    const launcher = screen.getByRole('button', { name: 'Model settings' });
    expect(launcher.querySelector('.composer-control-label')?.textContent).toBe('Model settings');
    expect(launcher.querySelector('.rounded-full')).toBeNull();
  });

  it('reset clears the override and the panel footer resets all', async () => {
    composer();
    await screen.findByLabelText('Model settings');
    await fireEvent.click(screen.getByLabelText('Model settings'));
    await setFirstParameter();
    await waitFor(() =>
      expect(loadComposerPreference(model).modelParameters).toEqual({ temperature: 2 }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    await waitFor(() => expect(loadComposerPreference(model).modelParameters ?? {}).toEqual({}));
  });

  it('shows ∞ for max output tokens until Force max is on, then reveals the limit slider', async () => {
    catalog.parameters = [MAX_TOKENS];
    composer();
    await screen.findByLabelText('Model settings');
    await fireEvent.click(screen.getByLabelText('Model settings'));
    const panel = await screen.findByRole('dialog');

    // Off by default: no override, no slider, and the real default is ∞ rather
    // than a misleading "1".
    expect(panel.textContent).toContain('∞');
    expect(screen.queryByRole('slider')).toBeNull();
    const toggle = screen.getByRole('switch', { name: 'Force max' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await fireEvent.click(toggle);
    await waitFor(() =>
      expect(loadComposerPreference(model).modelParameters).toEqual({ max_tokens: 128_000 }),
    );
    expect(screen.getByRole('slider')).not.toBeNull();
    expect(panel.textContent).not.toContain('∞');

    await fireEvent.click(screen.getByRole('switch', { name: 'Force max' }));
    await waitFor(() => expect(loadComposerPreference(model).modelParameters ?? {}).toEqual({}));
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Force max' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('renders the enum as a segmented control that sets and clears values', async () => {
    catalog.parameters = [VERBOSITY];
    composer();
    await screen.findByLabelText('Model settings');
    await fireEvent.click(screen.getByLabelText('Model settings'));
    const group = await screen.findByRole('radiogroup', { name: 'Verbosity' });
    const radios = [...group.querySelectorAll('button[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(['low', 'medium', 'high']);
    // Unset: nothing highlighted, the provider default applies.
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    await fireEvent.click(radios[2]!);
    await waitFor(() =>
      expect(loadComposerPreference(model).modelParameters).toEqual({
        verbosity: 'high',
      }),
    );
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
    // Clicking the active segment clears the override.
    await fireEvent.click(radios[2]!);
    await waitFor(() => expect(loadComposerPreference(model).modelParameters ?? {}).toEqual({}));
    expect(radios[2]!.getAttribute('aria-checked')).toBe('false');
  });

  it('sends only sanitized overrides through onSend', async () => {
    const { onSend, input } = composer();
    await screen.findByLabelText('Model settings');
    await fireEvent.click(screen.getByLabelText('Model settings'));
    await setFirstParameter();
    // Type and send.
    await fireEvent.input(input, { target: { value: 'hello' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const args = onSend.mock.calls.at(-1)!;
    expect(args[6]).toEqual({ temperature: 2 });
  });

  it('sends no modelParameters argument when nothing is overridden', async () => {
    const { onSend, input } = composer();
    await screen.findByLabelText('Model settings');
    await fireEvent.input(input, { target: { value: 'hello' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls.at(-1)![6]).toBeUndefined();
  });
});
