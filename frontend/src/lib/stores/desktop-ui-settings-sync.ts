import type { DesktopUiSettings } from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { onboardingStore } from './onboarding.svelte';
import { shortcutStore } from './shortcuts.svelte';
import { welcomePreferencesStore } from './welcome-preferences.svelte';

export function applyDesktopUiSettings(
  settings: DesktopUiSettings,
  replayWalkthrough = false,
): void {
  welcomePreferencesStore.applyRemote(settings.welcome);
  shortcutStore.applyRemote(settings.shortcuts);
  onboardingStore.applyRemoteReplay(settings.onboardingReplayRevision, replayWalkthrough);
}

export async function hydrateDesktopUiSettings(): Promise<void> {
  try {
    const response = await apiFetch(apiUrl('/api/desktop-ui'));
    if (!response.ok) return;
    const payload = (await response.json()) as { ok?: boolean; data?: DesktopUiSettings };
    if (!payload.ok || !payload.data) return;
    if (!payload.data.updatedAt) {
      const welcomeResponse = await apiFetch(apiUrl('/api/desktop-ui/welcome'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(welcomePreferencesStore.preferences),
      });
      if (!welcomeResponse.ok) return;
      await apiFetch(apiUrl('/api/desktop-ui/shortcuts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shortcutStore.list),
      });
      return;
    }
    applyDesktopUiSettings(payload.data);
  } catch {}
}
