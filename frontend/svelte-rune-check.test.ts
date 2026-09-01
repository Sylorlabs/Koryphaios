import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
describe('svelte rune check', () => {
  it('imports a svelte.ts store', async () => {
    const mod = await import('./src/lib/stores/toast.svelte');
    expect(typeof mod.toastStore).toBe('object');
  });
});
