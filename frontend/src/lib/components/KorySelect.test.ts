import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import KorySelect from './KorySelect.svelte';

afterEach(cleanup);

const plainOptions = [
  { value: 'off', label: 'Critic: Off' },
  { value: 'always', label: 'Critic: Always' },
];

const shortOptions = [
  { value: 'off', label: 'Critic: Off', shortLabel: 'Off' },
  { value: 'always', label: 'Critic: Always', shortLabel: 'On' },
];

it('renders the trigger label without a short span when no option has shortLabel', () => {
  const { container } = render(KorySelect, {
    label: 'Critic mode',
    value: 'always',
    options: plainOptions,
    onchange: vi.fn(),
  });
  const trigger = screen.getByRole('combobox', { name: 'Critic mode' });
  expect(trigger.textContent?.trim()).toBe('Critic: Always');
  expect(container.querySelector('.kory-select-label-short')).toBeNull();
  expect(container.querySelector('.kory-select-label-full')).toBeNull();
  expect(trigger.getAttribute('title')).toBeNull();
  expect(container.querySelector('.kory-select-chevron')).not.toBeNull();
});

it('renders the selected shortLabel in its own span and keeps the full label as title', () => {
  const { container } = render(KorySelect, {
    label: 'Critic mode',
    value: 'always',
    options: shortOptions,
    onchange: vi.fn(),
  });
  const trigger = screen.getByRole('combobox', { name: 'Critic mode' });
  expect(container.querySelector('.kory-select-label-short')?.textContent).toBe('On');
  expect(container.querySelector('.kory-select-label-full')?.textContent).toBe('Critic: Always');
  expect(trigger.getAttribute('title')).toBe('Critic: Always');
});

it('keeps the full option labels in the open menu and still chooses by value', async () => {
  const onchange = vi.fn();
  render(KorySelect, { label: 'Critic mode', value: 'off', options: shortOptions, onchange });
  await fireEvent.click(screen.getByRole('combobox', { name: 'Critic mode' }));
  expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual([
    'Critic: Off',
    'Critic: Always',
  ]);
  await fireEvent.click(screen.getByRole('option', { name: 'Critic: Always' }));
  expect(onchange).toHaveBeenCalledWith('always');
});
