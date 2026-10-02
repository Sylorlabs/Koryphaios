import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onboardingStore, ONBOARDING_VERSION } from './onboarding.svelte';

const STORAGE_KEY = 'koryphaios-onboarding-v1';

describe('onboardingStore', () => {
  beforeEach(() => {
    localStorage.clear();
    onboardingStore.reset();
  });

  it('shows on first launch and never again after completing', () => {
    expect(onboardingStore.isFirstLaunch).toBe(true);
    expect(onboardingStore.shouldShow).toBe(true);

    onboardingStore.complete();

    expect(onboardingStore.isFirstLaunch).toBe(false);
    expect(onboardingStore.shouldShow).toBe(false);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.outcome).toBe('completed');
    expect(stored.version).toBe(ONBOARDING_VERSION);
  });

  it('treats skipping as finished so the walkthrough stays out of the way', () => {
    onboardingStore.skip();

    expect(onboardingStore.shouldShow).toBe(false);
    expect(onboardingStore.record?.outcome).toBe('skipped');
  });

  it('replays on demand without erasing the original completion record', () => {
    onboardingStore.complete();
    const finishedAt = onboardingStore.record?.finishedAt;

    onboardingStore.replay();
    expect(onboardingStore.shouldShow).toBe(true);
    expect(onboardingStore.isFirstLaunch).toBe(false);

    onboardingStore.dismissReplay();
    expect(onboardingStore.shouldShow).toBe(false);
    expect(onboardingStore.record?.finishedAt).toBe(finishedAt);
  });

  it('treats corrupt or stale records as a first launch when re-read', async () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    vi.resetModules();
    let fresh = await import('./onboarding.svelte');
    expect(fresh.onboardingStore.isFirstLaunch).toBe(true);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ outcome: 'completed', finishedAt: 1, version: ONBOARDING_VERSION - 1 }),
    );
    vi.resetModules();
    fresh = await import('./onboarding.svelte');
    expect(fresh.onboardingStore.isFirstLaunch).toBe(true);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ outcome: 'completed', finishedAt: 1, version: ONBOARDING_VERSION }),
    );
    vi.resetModules();
    fresh = await import('./onboarding.svelte');
    expect(fresh.onboardingStore.isFirstLaunch).toBe(false);
  });
});
