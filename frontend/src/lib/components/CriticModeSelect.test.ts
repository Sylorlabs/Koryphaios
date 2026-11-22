import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import CriticModeSelect from './CriticModeSelect.svelte';

afterEach(cleanup);

it('labels the control as Critic and supports choosing a mode', async () => {
  const onchange = vi.fn();
  const view = render(CriticModeSelect, { value: 'auto', compact: true, onchange });
  expect(screen.getByRole('combobox', { name: /Critic mode/ })).toBeVisible();
  await fireEvent.click(screen.getByRole('combobox', { name: /Critic mode/ }));
  await fireEvent.click(screen.getByRole('option', { name: /Critic: Always/ }));
  expect(onchange).toHaveBeenCalledWith('always');
  await view.rerender({ value: 'always', compact: true, onchange });
  expect(screen.getByRole('combobox', { name: /Critic mode/ })).toBeVisible();
});


it('keeps Off, Auto, Always in order without descriptions for every selection', async () => {
  const onchange = vi.fn();
  const view = render(CriticModeSelect, { value: 'off', compact: true, onchange });
  for (const value of ['off', 'auto', 'always'] as const) {
    await view.rerender({ value, compact: true, onchange });
    await fireEvent.click(screen.getByRole('combobox', { name: /Critic mode/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim()))
      .toEqual(['Critic: Off', 'Critic: Auto', 'Critic: Always']);
    await fireEvent.keyDown(screen.getByRole('combobox', { name: /Critic mode/ }), { key: 'Escape' });
  }
});

it('shows short words on the composer trigger only when shortLabels is set', async () => {
  const view = render(CriticModeSelect, { value: 'always', compact: true, shortLabels: true, onchange: vi.fn() });
  const trigger = screen.getByRole('combobox', { name: /Critic mode/ });
  expect(trigger.closest('[data-testid="composer-critic-control"]')).not.toBeNull();
  expect(trigger.querySelector('.kory-select-label-short')?.textContent).toBe('On');
  expect(trigger.getAttribute('title')).toBe('Critic: Always');
  await view.rerender({ value: 'auto', compact: true, shortLabels: true, onchange: vi.fn() });
  expect(trigger.querySelector('.kory-select-label-short')?.textContent).toBe('Auto');
  await view.rerender({ value: 'off', compact: true, shortLabels: true, onchange: vi.fn() });
  expect(trigger.querySelector('.kory-select-label-short')?.textContent).toBe('Off');
});

it('leaves the trigger unchanged when shortLabels is not set', () => {
  const { container } = render(CriticModeSelect, { value: 'always', compact: true, onchange: vi.fn() });
  expect(container.querySelector('.kory-select-label-short')).toBeNull();
  expect(container.querySelector('[data-testid="composer-critic-control"]')).toBeNull();
});
