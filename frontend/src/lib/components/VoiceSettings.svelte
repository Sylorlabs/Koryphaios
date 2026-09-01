<script lang="ts">
  import { onMount } from 'svelte';
  import Check from 'lucide-svelte/icons/check';
  import Mic from 'lucide-svelte/icons/mic';
  import Play from 'lucide-svelte/icons/play';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Square from 'lucide-svelte/icons/square';
  import Volume2 from 'lucide-svelte/icons/volume-2';
  import type { VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { playVoiceResponse, stopVoicePlayback } from '$lib/utils/voice-playback';
  import KorySelect from './KorySelect.svelte';
  import KorySlider from './KorySlider.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';

  const DEFAULT_SETTINGS: VoiceSettings = {
    input: { provider: 'system', modelId: 'web-speech-recognition', language: 'en' },
    output: {
      provider: 'system',
      modelId: 'web-speech-synthesis',
      voiceId: 'system-default',
      speed: 1,
    },
    autoReadFinalReplies: false,
    voiceModeEnabled: true,
  };
  let settings = $state<VoiceSettings>(structuredClone(DEFAULT_SETTINGS));
  let providers = $state<VoiceProviderDescriptor[]>([]);
  let systemVoices = $state<Array<{ value: string; label: string }>>([]);
  let loading = $state(true);
  let saving = $state(false);
  let previewing = $state(false);
  let systemSpeechSupported = $state(false);
  let systemRecognitionSupported = $state(false);
  let inputProvider = $derived(
    providers.find((provider) => provider.id === settings.input.provider),
  );
  let inputOptions = $derived(
    providers
      .filter((provider) => provider.capabilities.includes('stt'))
      .filter((provider) =>
        provider.id === 'system' ? systemRecognitionSupported : provider.configured,
      )
      .map((provider) => ({
        value: provider.id,
        label: provider.name,
        description:
          provider.id === 'system'
            ? 'Uses speech recognition available on this device'
            : provider.local
              ? 'Uses a model loaded in your local endpoint'
              : 'API provider is connected',
      })),
  );
  let inputModelOptions = $derived(
    (inputProvider?.models ?? [])
      .filter((model) => model.capability !== 'tts')
      .map((model) => ({ value: model.id, label: model.name })),
  );
  let outputProvider = $derived(
    providers.find((provider) => provider.id === settings.output.provider),
  );
  let outputOptions = $derived([
    ...(systemSpeechSupported
      ? [
          {
            value: 'system',
            label: 'Operating system',
            description: 'Uses voices installed on this device',
          },
        ]
      : []),
    ...providers
      .filter(
        (provider) =>
          provider.id !== 'system' && provider.capabilities.includes('tts') && provider.configured,
      )
      .map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.local
          ? 'Uses a speech model loaded in your endpoint'
          : 'Cloud speech is ready',
      })),
  ]);
  let outputModelOptions = $derived(
    (outputProvider?.models ?? [])
      .filter((model) => model.capability !== 'stt')
      .map((model) => ({ value: model.id, label: model.name })),
  );
  let voiceOptions = $derived(
    settings.output.provider === 'system'
      ? [{ value: 'system-default', label: 'System default' }, ...systemVoices]
      : (outputProvider?.voices ?? []).length > 0
        ? (outputProvider?.voices ?? []).map((voice) => ({ value: voice.id, label: voice.name }))
        : [{ value: 'default', label: 'Provider default' }],
  );

  function refreshSystemVoices() {
    if (!systemSpeechSupported) return;
    systemVoices = speechSynthesis
      .getVoices()
      .map((voice) => ({ value: voice.voiceURI, label: `${voice.name} · ${voice.lang}` }));
  }

  async function load() {
    loading = true;
    const [settingsResult, providerResult] = await Promise.allSettled([
      apiFetch(apiUrl('/api/voice/settings')).then((response) => response.json()),
      apiFetch(apiUrl('/api/voice/providers')).then((response) => response.json()),
    ]);
    if (settingsResult.status === 'fulfilled' && settingsResult.value.data)
      settings = settingsResult.value.data;
    if (providerResult.status === 'fulfilled' && Array.isArray(providerResult.value.data))
      providers = providerResult.value.data;
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
      window.dispatchEvent(
        new CustomEvent('koryphaios:voice-settings-changed', { detail: settings }),
      );
      if (showConfirmation) toastStore.success('Voice settings saved');
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not save voice settings');
      return false;
    } finally {
      saving = false;
    }
  }

  function selectInput(provider: string) {
    const descriptor = providers.find((candidate) => candidate.id === provider);
    settings.input.provider = provider;
    settings.input.modelId = descriptor?.models?.[0]?.id ?? 'whisper-1';
  }

  function selectOutput(provider: string) {
    const descriptor = providers.find((candidate) => candidate.id === provider);
    settings.output.provider = provider;
    if (provider === 'system') {
      settings.output.modelId = 'web-speech-synthesis';
      settings.output.voiceId = 'system-default';
      return;
    }
    const ttsModels = (descriptor?.models ?? []).filter((model) => model.capability !== 'stt');
    settings.output.modelId = ttsModels[0]?.id ?? 'tts-1';
    const voices = descriptor?.voices ?? [];
    settings.output.voiceId = voices[0]?.id ?? 'default';
  }

  async function previewVoice() {
    if (previewing || !(await save(false))) return;
    previewing = true;
    try {
      await playVoiceResponse(
        'voice-settings-preview',
        'Koryphaios voice input and speech playback are ready.',
      );
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Speech preview failed');
    } finally {
      previewing = false;
    }
  }

  $effect(() => {
    if (loading || !providers.length) return;
    if (
      inputOptions.length &&
      !inputOptions.some((option) => option.value === settings.input.provider)
    ) {
      selectInput(inputOptions[0].value);
    }
    if (
      outputOptions.length &&
      !outputOptions.some((option) => option.value === settings.output.provider)
    ) {
      selectOutput(outputOptions[0].value);
    }
  });

  onMount(() => {
    systemSpeechSupported =
      'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    systemRecognitionSupported =
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    refreshSystemVoices();
    if (systemSpeechSupported)
      speechSynthesis.addEventListener('voiceschanged', refreshSystemVoices);
    void load();
    return () => {
      stopVoicePlayback();
      if (systemSpeechSupported)
        speechSynthesis.removeEventListener('voiceschanged', refreshSystemVoices);
    };
  });
</script>

<div class="mx-auto w-full max-w-4xl space-y-6 p-6">
  <header>
    <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Voice</h3>
    <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
      Record prompts with system, local, or connected API transcription and hear replies through
      system or cloud voices.
    </p>
  </header>
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Checking voice capabilities…</p>
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      <section
        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
      >
        <div class="flex items-start gap-3">
          <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]">
            <Mic size={18} />
          </div>
          <div>
            <h4 class="font-medium text-[var(--color-text-primary)]">Speech to text</h4>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Choose this device, a local model server, or a connected speech API.
            </p>
          </div>
        </div>
        <KorySelect
          value={settings.input.provider}
          options={inputOptions}
          label="Transcription provider"
          placeholder={inputOptions.length ? 'Select…' : 'No connected providers'}
          disabled={inputOptions.length === 0}
          onchange={selectInput}
        />
        <KorySelect
          value={settings.input.modelId}
          options={inputModelOptions}
          label="Transcription model"
          allowCustom={settings.input.provider !== 'system'}
          customLabel="Use model ID"
          customPlaceholder="Model ID exposed by this endpoint"
          onchange={(value) => (settings.input.modelId = value)}
        />
        <KorySelect
          value={settings.input.language}
          options={[
            { value: 'en', label: 'English' },
            { value: 'es', label: 'Spanish' },
            { value: 'fr', label: 'French' },
            { value: 'de', label: 'German' },
            { value: 'ja', label: 'Japanese' },
            { value: 'zh', label: 'Chinese' },
          ]}
          label="Input language"
          onchange={(value) => (settings.input.language = value)}
        />
        {#if inputProvider?.configured}
          <div class="flex items-center gap-2 text-xs text-[var(--color-success)]">
            <Check size={13} /> Ready
          </div>
        {/if}
      </section>

      <section
        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
      >
        <div class="flex items-start gap-3">
          <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]">
            <Volume2 size={18} />
          </div>
          <div>
            <h4 class="font-medium text-[var(--color-text-primary)]">Text to speech</h4>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Choose this device's voices, a local endpoint, or a connected speech API.
            </p>
          </div>
        </div>
        <KorySelect
          value={settings.output.provider}
          options={outputOptions}
          label="Speech provider"
          placeholder={outputOptions.length ? 'Select…' : 'No connected providers'}
          disabled={outputOptions.length === 0}
          onchange={selectOutput}
        />
        {#if settings.output.provider !== 'system'}
          <KorySelect
            value={settings.output.modelId}
            options={outputModelOptions}
            label="Speech model"
            allowCustom
            customLabel="Use model ID"
            customPlaceholder="Model ID exposed by this endpoint"
            onchange={(value) => (settings.output.modelId = value)}
          />
        {/if}
        <KorySelect
          value={settings.output.voiceId}
          options={voiceOptions}
          label="Voice"
          allowCustom={settings.output.provider !== 'system'}
          customLabel="Use voice ID"
          customPlaceholder="Voice ID accepted by this provider"
          onchange={(value) => (settings.output.voiceId = value)}
        />
        <KorySlider
          id="voice-preview-speed"
          label="Speech speed"
          value={settings.output.speed}
          min={0.5}
          max={2}
          step={0.1}
          unit="×"
          displayValue={`${settings.output.speed.toFixed(1)}×`}
          valueText={`${settings.output.speed.toFixed(1)} times normal speed`}
          onchange={(value) => (settings.output.speed = value)}
        />
        {#if previewing}<button
            class="btn"
            type="button"
            onclick={() => {
              stopVoicePlayback();
              previewing = false;
            }}><Square size={13} /> Stop</button
          >
        {:else}<button
            class="btn"
            type="button"
            disabled={(settings.output.provider === 'system' && !systemSpeechSupported) ||
              (settings.output.provider !== 'system' && !outputProvider?.configured)}
            onclick={() => void previewVoice()}><Play size={13} /> Test voice</button
          >{/if}
      </section>
    </div>

    <section
      class="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
    >
      <SettingsSwitch
        checked={settings.voiceModeEnabled}
        label="Composer microphone"
        description="Show and enable audio recording in the message composer."
        onchange={() => {
          settings.voiceModeEnabled = !settings.voiceModeEnabled;
        }}
      />
      <SettingsSwitch
        checked={settings.autoReadFinalReplies}
        label="Read final replies aloud"
        description="Automatically play completed assistant replies with the selected voice."
        onchange={() => {
          settings.autoReadFinalReplies = !settings.autoReadFinalReplies;
        }}
      />
    </section>

    <section
      class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
    >
      <h4 class="font-medium text-[var(--color-text-primary)]">Run local speech models</h4>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Serve a speech model with any OpenAI-compatible local runtime (LocalAI, speaches, LM Studio,
        llama.cpp), configure its endpoint under Providers &amp; models, then select that provider
        and its model ID above. Audio stays on your machine — nothing is uploaded unless you pick a
        cloud provider.
      </p>
    </section>

    <div class="flex justify-end gap-2">
      <button class="btn" type="button" onclick={() => void load()}
        ><RefreshCw size={14} /> Reload</button
      ><button class="btn btn-primary" type="button" disabled={saving} onclick={() => void save()}
        >{saving ? 'Saving…' : 'Save voice settings'}</button
      >
    </div>
  {/if}
</div>
