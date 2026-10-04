import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModelSelectionDialog from './ModelSelectionDialog.svelte';

const models = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];

describe('shared model configuration', () => {
  it('preserves an empty share selection and saves explicit choices after searching', async () => {
    const onSave = vi.fn();
    render(ModelSelectionDialog, { props: {
      providerName: 'Test', availableModels: models, selectedModels: [], mode: 'sharing',
      onSave, onClose: vi.fn(),
    } });
    const alpha = await screen.findByRole('checkbox', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('switch')).toBeNull();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'beta' } });
    expect(screen.queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith(['beta'], false);
  });

  it('supports all/none and cancel without committing draft selections', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(ModelSelectionDialog, { props: {
      providerName: 'Test', availableModels: models, selectedModels: ['alpha'], mode: 'sharing',
      onSave, onClose,
    } });
    await fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByRole('checkbox', { name: 'Beta' }).getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(screen.getByRole('button', { name: 'Select None' }));
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('scopes Select All/None to the active search results', async () => {
    const onSave = vi.fn();
    render(ModelSelectionDialog, { props: {
      providerName: 'Test', availableModels: models, selectedModels: ['alpha'], mode: 'sharing',
      onSave, onClose: vi.fn(),
    } });
    const search = screen.getByRole('textbox', { name: 'Search models' });
    await fireEvent.input(search, { target: { value: 'beta' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith(['alpha', 'beta'], false);

    onSave.mockClear();
    render(ModelSelectionDialog, { props: {
      providerName: 'Test', availableModels: models, selectedModels: ['alpha', 'beta'], mode: 'sharing',
      onSave, onClose: vi.fn(),
    } });
    await fireEvent.input(screen.getAllByRole('textbox', { name: 'Search models' })[1], { target: { value: 'beta' } });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Select None' })[1]);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[1]);
    expect(onSave).toHaveBeenCalledWith(['alpha'], false);
  });

  it('allows saving no shared models and closes with Escape', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(ModelSelectionDialog, { props: {
      providerName: 'Test', availableModels: models, selectedModels: [], mode: 'sharing',
      onSave, onClose,
    } });
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith([], false);
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
