import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelSelectionDialog from './ModelSelectionDialog.svelte';

const models = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
];

describe('shared model configuration', () => {
  it('portals the picker outside the settings drawer stacking context', () => {
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: [],
        onSave: vi.fn(),
        onClose: vi.fn(),
      },
    });

    expect(screen.getByRole('presentation').parentElement).toBe(document.body);
  });

  it('shows provider-reported facts so two same-named entries are distinguishable', () => {
    render(ModelSelectionDialog, {
      props: {
        providerName: 'CodeBuddy',
        availableModels: [
          {
            id: 'codebuddy-deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash (free)',
            apiModelId: 'deepseek-v4.1-flash',
            contextWindow: 1_000_000,
            contextVerified: true,
            maxOutputTokens: 128_000,
            vision: true,
            canReason: true,
            creditsLabel: 'free',
          },
          {
            id: 'codebuddy-deepseek-v4.1-flash-sg',
            name: 'Deepseek-V4.1-Flash (x0.03 credits)',
            apiModelId: 'deepseek-v4.1-flash-sg',
            contextWindow: 1_000_000,
            contextVerified: true,
            creditsLabel: 'x0.03 credits',
          },
        ],
        selectedModels: [],
        onSave: vi.fn(),
        onClose: vi.fn(),
      },
    });

    expect(
      screen.getByText(
        'deepseek-v4.1-flash · 1M context · 128K output · vision · reasoning · free',
      ),
    ).toBeTruthy();
    expect(screen.getByText('deepseek-v4.1-flash-sg · 1M context · x0.03 credits')).toBeTruthy();
    // The accessible name stays the model name, so existing selection tests
    // and assistive-tech labels remain stable.
    expect(screen.getByRole('checkbox', { name: 'Deepseek-V4.1-Flash (free)' })).toBeTruthy();
  });

  it('shows the provider’s real context tiers and its smaller CLI default', () => {
    render(ModelSelectionDialog, {
      props: {
        providerName: 'WorkBuddy Desktop',
        availableModels: [
          {
            id: 'workbuddy-desktop-deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash',
            apiModelId: 'deepseek-v4.1-flash',
            contextWindow: 1_000_000,
            contextVerified: true,
            contextWindowOptions: [300_000, 1_000_000],
            contextWindowVendorDefault: 300_000,
          },
        ],
        selectedModels: [],
        onSave: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(
      screen.getByText(
        'deepseek-v4.1-flash · 1M context · tiers 300K/1M · CLI default 300K',
      ),
    ).toBeTruthy();
  });

  it('does not present an unverified context window as a real limit', () => {
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: [
          { id: 'guess', name: 'Guess', apiModelId: 'guess', contextWindow: 999999 },
        ],
        selectedModels: [],
        onSave: vi.fn(),
        onClose: vi.fn(),
      },
    });
    expect(screen.getByText('guess')).toBeTruthy();
    expect(screen.queryByText(/context/)).toBeNull();
  });

  it('disables elastic overscroll on the model list', () => {
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: [],
        onSave: vi.fn(),
        onClose: vi.fn(),
      },
    });

    const list = screen.getByTestId('model-selection-list');
    expect(getComputedStyle(list).overscrollBehavior).toBe('none');
  });

  it('preserves an empty share selection and saves explicit choices after searching', async () => {
    const onSave = vi.fn();
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: [],
        mode: 'sharing',
        onSave,
        onClose: vi.fn(),
      },
    });
    const alpha = await screen.findByRole('checkbox', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('switch')).toBeNull();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Search models' }), {
      target: { value: 'beta' },
    });
    expect(screen.queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith(['beta'], false);
  });

  it('supports all/none and cancel without committing draft selections', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: ['alpha'],
        mode: 'sharing',
        onSave,
        onClose,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByRole('checkbox', { name: 'Beta' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Select None' }));
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('scopes Select All/None to the active search results', async () => {
    const onSave = vi.fn();
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: ['alpha'],
        mode: 'sharing',
        onSave,
        onClose: vi.fn(),
      },
    });
    const search = screen.getByRole('textbox', { name: 'Search models' });
    await fireEvent.input(search, { target: { value: 'beta' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith(['alpha', 'beta'], false);

    onSave.mockClear();
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: ['alpha', 'beta'],
        mode: 'sharing',
        onSave,
        onClose: vi.fn(),
      },
    });
    await fireEvent.input(screen.getAllByRole('textbox', { name: 'Search models' })[1], {
      target: { value: 'beta' },
    });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Select None' })[1]);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[1]);
    expect(onSave).toHaveBeenCalledWith(['alpha'], false);
  });

  it('allows saving no shared models and closes with Escape', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: [],
        mode: 'sharing',
        onSave,
        onClose,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith([], false);
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps Done actionable when a provider selection is empty', async () => {
    const onSave = vi.fn();
    render(ModelSelectionDialog, {
      props: {
        providerName: 'Test',
        availableModels: models,
        selectedModels: ['alpha'],
        onSave,
        onClose: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    const done = screen.getByRole('button', { name: 'Done' });
    expect((done as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(done);

    // The provider API treats an empty selection as "all available models".
    expect(onSave).toHaveBeenCalledWith(['alpha', 'beta'], false);
  });
});
