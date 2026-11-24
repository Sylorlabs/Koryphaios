// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadComposerPreference } from '$lib/stores/composer-preferences';
import type { FusionCatalog, FusionSelection } from '@koryphaios/shared';

// A small real-shaped catalog built from actual `devin models` slugs. The
// coupling mirrors the live rows: fast Fable pairs only with GPT sidekicks,
// Sonnet has no fast pairings and no Sonnet sidekick.
const { catalog, fusionDef } = vi.hoisted(() => {
  const LEAD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const cell = (lead: string, fast: boolean, sk: string, skEffort: string | null) =>
    Object.fromEntries(
      LEAD_EFFORTS.map((e) => [
        e,
        `fusion-${lead}-${e}${fast ? '-fast' : ''}-sidekick-${sk}${skEffort ? `-${skEffort}` : ''}${
          fast && sk.startsWith('gpt-') ? '-priority' : ''
        }`,
      ]),
    );
  const pairings: FusionCatalog['pairings'] = {};
  const add = (lead: string, fast: boolean, sk: string, skEff: string | null) => {
    pairings[`${lead}|${fast ? 'fast' : 'std'}|${sk}|${skEff ?? ''}`] = cell(lead, fast, sk, skEff);
  };
  for (const sk of ['swe-2', 'gpt-6-luna', 'glm-5-2', 'claude-sonnet-5-5']) {
    const eff =
      sk === 'swe-2' ? 'medium' : sk === 'gpt-6-luna' ? 'high' : sk === 'glm-5-2' ? null : 'medium';
    add('claude-opus-5-5', false, sk, eff);
    add('claude-fable-5-2', false, sk, eff);
    if (sk !== 'claude-sonnet-5-5') add('claude-sonnet-5-5', false, sk, eff);
  }
  add('claude-opus-5-5', false, 'swe-2', 'high');
  add('claude-fable-5-2', false, 'swe-2', 'high');
  add('claude-sonnet-5-5', false, 'swe-2', 'high');
  add('claude-opus-5-5', true, 'swe-2', 'medium');
  add('claude-opus-5-5', true, 'gpt-6-luna', 'high');
  add('claude-fable-5-2', true, 'gpt-6-luna', 'high');

  const efforts = (list: string[]) => list;
  const cat: FusionCatalog = {
    leads: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        efforts: efforts(LEAD_EFFORTS),
        defaultEffort: 'medium',
      },
      {
        id: 'claude-fable-5-2',
        name: 'Claude Fable 5.2',
        efforts: efforts(LEAD_EFFORTS),
        defaultEffort: 'medium',
      },
      {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        efforts: efforts(LEAD_EFFORTS),
        defaultEffort: 'medium',
      },
    ],
    sidekicks: [
      { id: 'swe-2', name: 'SWE-2', efforts: ['medium', 'high'], defaultEffort: 'medium' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['high'], defaultEffort: 'high' },
      { id: 'glm-5-2', name: 'GLM-5.2', efforts: [], defaultEffort: null },
      {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        efforts: ['medium'],
        defaultEffort: 'medium',
      },
    ],
    pairings,
    meta: Object.fromEntries(
      Object.keys(pairings).map((k) => [
        k,
        { contextWindow: 1_000_000, costPerMInputTokens: 4, costPerMOutputTokens: 20 },
      ]),
    ),
    defaultSelection: {
      lead: 'claude-opus-5-5',
      leadEffort: 'medium',
      leadFast: false,
      sidekick: 'swe-2',
      sidekickEffort: 'medium',
    },
  };
  const def = {
    id: 'fusion',
    name: 'Fusion',
    canReason: false,
    // Prove the fusion view hides the normal chips even if they would exist.
    reasoningLevels: ['low', 'medium', 'high', 'auto'],
    speedTiers: [{ id: 'fast', label: 'Fast', description: 'faster' }],
    parameters: [
      { key: 'temperature', label: 'Temperature', kind: 'float', min: 0, max: 2, description: 't' },
    ],
    fusion: cat,
    aliases: [
      'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
      'fusion-claude-opus-5-5-high-sidekick-swe-2-medium',
      'fusion-claude-opus-5-5-sidekick-swe-2-medium',
      'fusion-claude-opus-5-5-fast-sidekick-swe-2-medium',
    ],
  };
  return { catalog: cat, fusionDef: def };
});

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
          name: 'devin',
          enabled: true,
          authenticated: true,
          models: ['fusion'],
          allAvailableModels: [fusionDef],
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

function composer(selectedModel: string = 'devin:fusion') {
  const onSend = vi.fn((..._args: unknown[]) => true);
  const result = render(CommandInput, {
    onSend,
    selectedModel,
    disableModelPreviewRequests: true,
    draftKey: `fusion-test-${Math.random().toString(36).slice(2)}`,
  });
  return { ...result, onSend, input: result.container.querySelector('textarea')! };
}

async function openSlot(n: 1 | 2) {
  await fireEvent.click(screen.getByTestId(`fusion-slot-${n}`).querySelector('button')!);
  await screen.findByRole('dialog');
}

describe('composer Fusion slots', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('shows two slot chips and hides the reasoning/fast/settings chips', async () => {
    composer();
    await screen.findByTestId('fusion-slot-1');
    await screen.findByTestId('fusion-slot-2');
    expect(screen.getByTestId('fusion-slot-1').textContent).toContain('Claude Opus 5.5');
    expect(screen.getByTestId('fusion-slot-2').textContent).toContain('SWE-2');
    expect(screen.queryByTestId('composer-fast-control')).toBeNull();
    expect(screen.queryByTestId('composer-model-params-control')).toBeNull();
    expect(screen.queryByTestId('composer-reasoning-control')).toBeNull();
  });

  it('slot 1 panel lists leads, an effort radiogroup, and the Fast toggle', async () => {
    composer();
    await screen.findByTestId('fusion-slot-1');
    await openSlot(1);
    expect(screen.getByText('Fusion 1 · Lead')).toBeTruthy();
    expect(screen.getByText('Claude Fable 5.2')).toBeTruthy();
    const reasoning = screen.getByRole('radiogroup', { name: 'Fusion 1 reasoning' });
    expect(reasoning.querySelectorAll('[role="radio"]').length).toBe(5);
    const fast = screen.getByRole('radiogroup', { name: 'Fusion 1 Fast' });
    expect(fast.textContent).toContain('On');
    expect(screen.getByText(/1M context · \$4 in \/ \$20 out/)).toBeTruthy();
  });

  it('slot 2 panel renders segmented efforts and read-only states', async () => {
    composer();
    await screen.findByTestId('fusion-slot-2');
    await openSlot(2);
    const reasoning = screen.getByRole('radiogroup', { name: 'Fusion 2 reasoning' });
    expect(reasoning.textContent).toContain('Medium');
    expect(reasoning.textContent).toContain('High');
    // GLM has no effort token: pick it and the tier reads as absent.
    await fireEvent.click(screen.getByText('GLM-5.2'));
    await waitFor(() => expect(screen.getByText('No reasoning tier')).toBeTruthy());
  });

  it('dims unavailable slot-2 options and auto-adjusts with a note when Fast blocks SWE-2', async () => {
    composer();
    await screen.findByTestId('fusion-slot-1');
    await openSlot(1);
    await fireEvent.click(screen.getByText('Claude Fable 5.2'));
    const fast = screen.getByRole('radiogroup', { name: 'Fusion 1 Fast' });
    await fireEvent.click(
      [...fast.querySelectorAll('button')].find((b) => b.textContent === 'On')!,
    );
    // Fast Fable pairs only with GPT sidekicks → SWE-2 repaired away, note shown.
    await waitFor(() =>
      expect(
        screen.getByText(/isn't offered with Fast Claude Fable 5\.2.*GPT-6 Luna/),
      ).toBeTruthy(),
    );
    await openSlot(2);
    const swe2 = screen.getByText('SWE-2').closest('button')!;
    expect(swe2.style.opacity).toBe('0.55');
    expect(screen.getAllByText(/Not offered with Fast Claude Fable 5\.2/).length).toBeGreaterThan(
      0,
    );
  });

  it('keeps the Fast radiogroup in sync with the chip after the sidekick auto-adjusts', async () => {
    composer();
    const slot1 = await screen.findByTestId('fusion-slot-1');
    await openSlot(1);
    await fireEvent.click(screen.getByText('Claude Fable 5.2'));
    const fast = () => screen.getByRole('radiogroup', { name: 'Fusion 1 Fast' });
    const radio = (label: string) =>
      [...fast().querySelectorAll('button[role="radio"]')].find((b) => b.textContent === label)!;
    await fireEvent.click(radio('On'));
    // Fast Fable pairs only with GPT sidekicks: SWE-2 is repaired away and the
    // Fast control must read On in the same render, not lag a frame behind.
    await waitFor(() => {
      expect(radio('On').getAttribute('aria-checked')).toBe('true');
      expect(radio('Off').getAttribute('aria-checked')).toBe('false');
    });
    expect(slot1.querySelector('button')!.getAttribute('title')).toContain(
      'Fusion 1: Claude Fable 5.2 · Medium · Fast',
    );
    expect(screen.getByTestId('fusion-slot-2').textContent).toContain('GPT-6 Luna');
    // The state survives closing and reopening the panel.
    await fireEvent.click(slot1.querySelector('button')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openSlot(1);
    expect(radio('On').getAttribute('aria-checked')).toBe('true');
    expect(radio('Off').getAttribute('aria-checked')).toBe('false');
  });

  it('disables the slot-1 Fast control when the lead has no fast pairing', async () => {
    composer();
    await screen.findByTestId('fusion-slot-1');
    await openSlot(1);
    await fireEvent.click(screen.getByText('Claude Sonnet 5.5'));
    await waitFor(() => expect(screen.getByText('No fast pairing for this lead.')).toBeTruthy());
    expect(screen.queryByRole('radiogroup', { name: 'Fusion 1 Fast' })).toBeNull();
  });

  it('persists the selection per devin:fusion', async () => {
    composer();
    await screen.findByTestId('fusion-slot-1');
    await openSlot(1);
    await fireEvent.click(screen.getByText('Claude Fable 5.2'));
    await waitFor(() => {
      const saved = loadComposerPreference('devin:fusion');
      expect(saved.fusion?.lead).toBe('claude-fable-5-2');
      expect(saved.fusion?.sidekick).toBe('swe-2');
    });
  });

  it('restores a legacy fusion slug onto the single model with its pairing prefilled', async () => {
    composer('devin:fusion-claude-opus-5-5-high-sidekick-swe-2-medium');
    const slot1 = await screen.findByTestId('fusion-slot-1');
    expect(slot1.textContent).toContain('Claude Opus 5.5');
    expect(slot1.textContent).toContain('High');
  });

  it('sends the fusion selection and nothing for other models', async () => {
    const { input, onSend } = composer();
    await screen.findByTestId('fusion-slot-1');
    await fireEvent.input(input, { target: { value: 'hello' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const args = onSend.mock.calls[0]!;
    const fusion = args[7] as FusionSelection | undefined;
    expect(fusion?.lead).toBe('claude-opus-5-5');
    expect(fusion?.sidekick).toBe('swe-2');
  });
});
