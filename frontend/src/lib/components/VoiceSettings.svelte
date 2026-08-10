<script lang="ts">
  import { onMount } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Check from 'lucide-svelte/icons/check';
  import MicOff from 'lucide-svelte/icons/mic-off';
  import Play from 'lucide-svelte/icons/play';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Square from 'lucide-svelte/icons/square';
  import Volume2 from 'lucide-svelte/icons/volume-2';
  import type { VoicePackStatus, VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { playVoiceResponse, stopVoicePlayback } from '$lib/utils/voice-playback';
  import KorySlider from './KorySlider.svelte';

  const DEFAULT_SETTINGS: VoiceSettings = {
    input: { provider: 'system', modelId: 'stt-unavailable', language: 'en' },
    output: {
      provider: 'system',
      modelId: 'web-speech-synthesis',
      voiceId: 'system-default',
      speed: 1,
    },
    autoReadFinalReplies: false,
    voiceModeEnabled: false,
    liveTranscription: false,
  };
  const DEFAULT_PROVIDERS: VoiceProviderDescriptor[] = [
    {
      id: 'system',
      name: 'Operating system speech',
      capabilities: ['tts'],
      local: false,
      configured: true,
      supportsDiscovery: true,
    },
  ];

  let settings = $state<VoiceSettings>(structuredClone(DEFAULT_SETTINGS));
  let providers = $state<VoiceProviderDescriptor[]>(DEFAULT_PROVIDERS);
  let voicePacks = $state<VoicePackStatus[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let previewing = $state(false);
  let systemSpeechSupported = $state(false);
  let systemProvider = $derived(providers.find((provider) => provider.id === 'system'));
  let englishDictation = $derived(
    voicePacks.find((pack) => pack.manifest.id === 'moonshine-tiny-en-int8'),
  );

  async function load() {
    loading = true;
    const [settingsResult, providerResult, packResult] = await Promise.allSettled([
      apiFetch(apiUrl('/api/voice/settings')).then((response) => response.json()),
      apiFetch(apiUrl('/api/voice/providers')).then((response) => response.json()),
      apiFetch(apiUrl('/api/voice/packs')).then((response) => response.json()),
    ]);
    if (settingsResult.status === 'fulfilled' && settingsResult.value.data)
      settings = settingsResult.value.data;
    providers =
      providerResult.status === 'fulfilled' &&
      Array.isArray(providerResult.value.data) &&
      providerResult.value.data.length
        ? providerResult.value.data
        : DEFAULT_PROVIDERS;
    if (packResult.status === 'fulfilled' && Array.isArray(packResult.value.data))
      voicePacks = packResult.value.data;
    loading = false;
  }

  async function save(showConfirmation = true): Promise<boolean> {
    saving = true;
    try {
      const response = await apiFetch(apiUrl('/api/voice/settings'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Save failed');
      settings = result.data;
      if (showConfirmation) toastStore.success('System voice settings saved');
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not save voice settings');
      return false;
    } finally {
      saving = false;
    }
  }

  async function previewSystemVoice() {
    if (!systemSpeechSupported || previewing || !(await save(false))) return;
    previewing = true;
    try {
      await playVoiceResponse(
        'voice-settings-preview',
        'Koryphaios is using your operating system speech service.',
      );
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'System speech is unavailable');
    } finally {
      previewing = false;
    }
  }

  function stopPreview() {
    stopVoicePlayback();
    previewing = false;
  }
  onMount(() => {
    systemSpeechSupported =
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined';
    void load();
    return () => stopVoicePlayback();
  });
</script>

<div class="mx-auto w-full max-w-4xl space-y-6 p-6">
  <header>
    <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Voice</h3>
    <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
      This build exposes only the operating system's speech-synthesis service. Cloud adapters,
      dictation, and bundled local speech engines stay unavailable until their real runtimes and
      privacy boundaries are implemented.
    </p>
  </header>
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Checking voice capabilities…</p>
  {:else}
    <section
      class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
    >
      <div class="flex flex-wrap items-start gap-4">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]"
        >
          <Volume2 size={19} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="font-medium text-[var(--color-text-primary)]">
              {systemProvider?.name ?? 'Operating system speech'}
            </h4>
            {#if systemSpeechSupported}<span
                class="inline-flex items-center gap-1 rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-[10px] text-[var(--color-success)]"
                ><Check size={10} /> Runtime detected</span
              >{:else}<span
                class="inline-flex items-center gap-1 rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 text-[10px] text-[var(--color-warning)]"
                ><AlertTriangle size={10} /> Runtime unavailable</span
              >{/if}
          </div>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Uses the speech service exposed by this desktop webview. Availability, voices, and
            whether processing stays on-device are controlled by the operating system vendor;
            Koryphaios does not treat runtime detection as a privacy guarantee.
          </p>
        </div>
      </div>
      <div class="mt-5">
        <KorySlider
          id="voice-preview-speed"
          label="Preview speed"
          value={settings.output.speed}
          min={0.5}
          max={2}
          step={0.1}
          unit="×"
          displayValue={`${settings.output.speed.toFixed(1)}×`}
          valueText={`${settings.output.speed.toFixed(1)} times normal speed`}
          onchange={(value) => (settings.output.speed = value)}
        />
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        {#if previewing}<button class="btn" type="button" onclick={stopPreview}
            ><Square size={13} /> Stop preview</button
          >{:else}<button
            class="btn"
            type="button"
            disabled={!systemSpeechSupported || saving}
            onclick={() => void previewSystemVoice()}><Play size={13} /> Test system voice</button
          >{/if}
      </div>
    </section>
    <section
      class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
    >
      <div class="flex items-start gap-4">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
        >
          <MicOff size={19} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="font-medium text-[var(--color-text-primary)]">Speech input</h4>
            <span
              class="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 text-[10px] text-[var(--color-warning)]"
              >Unavailable in this build</span
            >
          </div>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            There is no active composer microphone, system transcription, or local inference
            runtime. Koryphaios will not upload audio to a cloud provider as a fallback.
          </p>
        </div>
      </div>
    </section>
    <section class="space-y-3">
      <div>
        <h4 class="font-medium text-[var(--color-text-primary)]">Local model assets</h4>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
          Existing downloads are preserved, but model files are not presented as a working voice
          engine without inference code.
        </p>
      </div>
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        <div class="flex flex-wrap items-center gap-2 font-medium text-[var(--color-text-primary)]">
          Moonshine English Dictation <span
            class="rounded-full bg-[var(--color-surface-3)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
            >Model files only</span
          >{#if englishDictation?.state === 'installed'}<span
              class="rounded-full bg-[var(--color-info-bg)] px-2 py-0.5 text-[10px] text-[var(--color-info)]"
              >Files installed</span
            >{/if}
        </div>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
          The verified pack inventory is retained. Transcription remains unavailable because this
          build has no Moonshine inference adapter.
        </p>
      </div>
      <p class="text-xs text-[var(--color-text-muted)]">
        KittenTTS and cloud voice providers are intentionally absent: their adapters are not
        implemented, so this screen does not accept credentials or label them as built in.
      </p>
    </section>
    <div class="flex justify-end gap-2">
      <button class="btn" type="button" onclick={() => void load()}
        ><RefreshCw size={14} /> Reload</button
      ><button class="btn btn-primary" type="button" disabled={saving} onclick={() => void save()}
        >{saving ? 'Saving…' : 'Save system voice'}</button
      >
    </div>
  {/if}
</div>
