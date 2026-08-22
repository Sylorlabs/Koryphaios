import { fireEvent, render, screen } from '@testing-library/svelte';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import KorySelect from './KorySelect.svelte';
import KorySlider from './KorySlider.svelte';
import KoryColorField from './KoryColorField.svelte';
import NumberStepper from './NumberStepper.svelte';
import SettingsToggle from './SettingsToggle.svelte';

function listSvelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSvelteFiles(path);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [path] : [];
  });
}

describe('Koryphaios settings controls', () => {
  it('keeps Settings implementations free of browser-native range inputs', () => {
    for (const relativePath of [
      'src/lib/components/SettingsDrawer.svelte',
      'src/lib/components/VoiceSettings.svelte',
    ]) {
      expect(readFileSync(join(process.cwd(), relativePath), 'utf8')).not.toMatch(
        /type\s*=\s*['"]range['"]/,
      );
    }
  });

  it('renders auth-token inputs when provider capabilities advertise them', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/SettingsDrawer.svelte'),
      'utf8',
    );
    expect(source).toMatch(/function showTokenInput[\s\S]*?return caps\.supportsAuthToken;/);
    expect(source).not.toMatch(/function showTokenInput[^}]+return false;/);
  });

  it('keeps product controls on the shared Kory contracts', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const sources = listSvelteFiles(sourceRoot).map((path) => ({
      path: relative(sourceRoot, path).replaceAll('\\', '/'),
      source: readFileSync(path, 'utf8'),
    }));
    const forbiddenNativeControl =
      /<select\b|<input\b[^>]*\btype\s*=\s*['"](?:checkbox|number|range)['"]/;

    expect(
      sources.filter(({ source }) => forbiddenNativeControl.test(source)).map(({ path }) => path),
    ).toEqual([]);
    expect(
      sources
        .filter(({ source }) => /role\s*=\s*['"]switch['"]/.test(source))
        .map(({ path }) => path)
        .sort(),
    ).toEqual(['lib/components/SettingsSwitch.svelte', 'lib/components/SettingsToggle.svelte']);

    for (const component of ['SettingsSwitch.svelte', 'SettingsToggle.svelte']) {
      const source = readFileSync(join(process.cwd(), 'src/lib/components', component), 'utf8');
      expect(source).toContain('var(--color-switch-thumb)');
      expect(source).not.toMatch(/\bbg-white\b/);
    }
    expect(readFileSync(join(process.cwd(), 'src/app.css'), 'utf8')).toContain(
      '--color-switch-thumb: var(--color-surface-0)',
    );

    const modelSharingSource = readFileSync(
      join(process.cwd(), 'src/lib/components/ModelSharingPanel.svelte'),
      'utf8',
    );
    const sandboxToggleBlock = modelSharingSource.slice(
      modelSharingSource.indexOf('{#each SANDBOX_TOGGLES'),
      modelSharingSource.indexOf('{/each}', modelSharingSource.indexOf('{#each SANDBOX_TOGGLES')),
    );
    expect(sandboxToggleBlock).toContain('<SettingsSwitch');
    expect(sandboxToggleBlock).not.toContain('<button');
    expect(sandboxToggleBlock).not.toMatch(/\bbg-white\b/);
  });

  it('operates the native stepper by keyboard and accepts an exact typed value', async () => {
    const onchange = vi.fn();
    render(NumberStepper, {
      props: {
        value: 10,
        min: 0,
        max: 20,
        step: 2,
        label: 'Worker limit',
        valueText: '10 workers',
        onchange,
      },
    });

    const input = screen.getByRole('spinbutton', { name: 'Worker limit' });
    expect(input.getAttribute('aria-valuetext')).toBe('10 workers');
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onchange).toHaveBeenLastCalledWith(12);

    await fireEvent.input(input, { target: { value: '17' } });
    await fireEvent.blur(input);
    expect(onchange).toHaveBeenLastCalledWith(17);
    expect(input.getAttribute('type')).toBe('text');
  });

  it('navigates a KorySelect listbox without a browser-native select', async () => {
    const onchange = vi.fn();
    render(KorySelect, {
      props: {
        value: 'safe',
        label: 'Execution policy',
        options: [
          { value: 'safe', label: 'Safe' },
          { value: 'fast', label: 'Fast' },
        ],
        onchange,
      },
    });

    const trigger = screen.getByRole('combobox', { name: 'Execution policy' });
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const listboxId = trigger.getAttribute('aria-controls');
    expect(listboxId).toBeTruthy();
    expect(document.getElementById(listboxId!)).toBeTruthy();
    const escapedAtWindow = vi.fn();
    window.addEventListener('keydown', escapedAtWindow);
    await fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(escapedAtWindow).not.toHaveBeenCalled();
    window.removeEventListener('keydown', escapedAtWindow);

    await fireEvent.keyDown(trigger, { key: 'Enter' });
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onchange).toHaveBeenCalledWith('fast');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });

  it('uses an accessible tokenized slider without a native range input', async () => {
    const onchange = vi.fn();
    const { container } = render(KorySlider, {
      props: {
        id: 'graph-gravity',
        label: 'Graph gravity',
        value: -200,
        min: -500,
        max: 0,
        step: 10,
        valueText: 'negative 200 gravity strength',
        onchange,
      },
    });

    const slider = screen.getByRole('slider', { name: 'Graph gravity' });
    expect(slider.getAttribute('aria-valuemin')).toBe('-500');
    expect(slider.getAttribute('aria-valuemax')).toBe('0');
    expect(slider.getAttribute('aria-valuenow')).toBe('-200');
    expect(slider.getAttribute('aria-valuetext')).toBe('negative 200 gravity strength');
    expect(container.querySelector('input[type="range"]')).toBeNull();

    slider.focus();
    await fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onchange).toHaveBeenLastCalledWith(-190);
    await fireEvent.keyDown(slider, { key: 'Home' });
    expect(onchange).toHaveBeenLastCalledWith(-500);
    await fireEvent.keyDown(slider, { key: 'End' });
    expect(onchange).toHaveBeenLastCalledWith(0);
  });

  it('exposes a real switch contract without a hidden checkbox', async () => {
    const onchange = vi.fn();
    const { container } = render(SettingsToggle, {
      props: { checked: false, onchange, id: 'test-switch', label: 'Test setting' },
    });

    const toggle = screen.getByRole('switch');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await fireEvent.click(toggle);
    expect(onchange).toHaveBeenCalledOnce();
  });

  it('moves focus into the color picker and returns it on Escape', async () => {
    render(KoryColorField, {
      props: { value: '#D5B261', label: 'Profile color', onchange: vi.fn() },
    });

    const trigger = screen.getByRole('button', { name: 'Profile color' });
    await fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Profile color picker' });
    expect(document.activeElement).toBe(dialog);

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Profile color picker' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
