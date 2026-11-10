<script lang="ts">
  import { onMount } from 'svelte';
  import Check from 'lucide-svelte/icons/check';
  import Download from 'lucide-svelte/icons/download';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import Mic from 'lucide-svelte/icons/mic';
  import Play from 'lucide-svelte/icons/play';
  import Square from 'lucide-svelte/icons/square';
  import Volume2 from 'lucide-svelte/icons/volume-2';
  import type { VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { playVoiceResponse, stopVoicePlayback } from '$lib/utils/voice-playback';
  import KorySelect from './KorySelect.svelte';
  import KorySlider from './KorySlider.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';

  interface Props {
    attention?: boolean;
  }

  type LocalVoiceModelStatus = {
    installed: boolean;
    modelId: string;
    name: string;
    /** ggml, Onnx, Torch, or Unknown. */
    format: string;
    /** The attached model's own file name, so an attached model is never
     *  mistaken for the bundled one. */
    fileName?: string;
    formatLabel?: string;
    sizeBytes?: number | null;
    estimatedDownloadBytes: number;
    /** Set when a model is present but this machine cannot run it. */
    unsupportedReason?: string | null;
  };

  type LocalVoiceDownloadProgress = {
    downloadedBytes: number;
    totalBytes: number;
    percent: number;
  };

  const KORY_LOCAL_PROVIDER = 'kory-local';
  const KORY_LOCAL_MODEL = 'kory-local-voice';
  let { attention = false }: Props = $props();

  const DEFAULT_SETTINGS: VoiceSettings = {
    input: { provider: KORY_LOCAL_PROVIDER, modelId: KORY_LOCAL_MODEL, language: 'en' },
    output: {
      provider: 'system',
      modelId: 'web-speech-synthesis',
      voiceId: 'system-default',
      speed: 1,
    },
    autoReadFinalReplies: false,
    voiceModeEnabled: true,
    localVoiceSetupVersion: 1,
  };
  let settings = $state<VoiceSettings>($state.snapshot(DEFAULT_SETTINGS));
  // Voice settings apply as soon as they change — there is no "apply" step to
  // forget. Edits are persisted on a short debounce so dragging the speed
  // slider is one request rather than one per pixel.
  const AUTO_SAVE_DELAY_MS = 400;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let autoSaveArmed = false;
  let lastSavedSignature = $state('');
  let settingsSignature = $derived(JSON.stringify(settings));
  let providers = $state<VoiceProviderDescriptor[]>([]);
  let systemVoices = $state<Array<{ value: string; label: string }>>([]);
  let loading = $state(true);
  let previewing = $state(false);
  let systemSpeechSupported = $state(false);
  let systemRecognitionSupported = $state(false);
  let localDesktopRuntime = $state(false);
  let localModelStatus = $state<LocalVoiceModelStatus | null>(null);
  let localModelBusy = $state(false);
  let localModelProgress = $state(0);
  let localModelError = $state('');
  let inputProvider = $derived(
    providers.find((provider) => provider.id === settings.input.provider),
  );
  let inputOptions = $derived(
    providers
      .filter((provider) => provider.capabilities.includes('stt'))
      .filter((provider) =>
        provider.id === KORY_LOCAL_PROVIDER
          ? localDesktopRuntime
          : provider.id === 'system'
            ? systemRecognitionSupported
            : provider.configured,
      )
      .map((provider) => ({
        value: provider.id,
        label: provider.name,
        description:
          provider.id === KORY_LOCAL_PROVIDER
            ? 'Runs offline with the model installed in Koryphaios'
            : provider.id === 'system'
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

  const FORMAT_LABELS: Record<string, string> = {
    ggml: 'ggml',
    Onnx: 'ONNX',
    Torch: 'PyTorch',
    Unknown: 'unknown format',
  };

  function formatBytes(bytes?: number | null): string {
    if (!bytes || bytes <= 0) return 'an unknown size';
    const mb = bytes / (1024 * 1024);
    return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + ' MB';
  }

  async function refreshLocalModelStatus() {
    if (!localDesktopRuntime) return;
    try {
      const status = await invoke<LocalVoiceModelStatus>('local_voice_model_status');
      localModelStatus = { ...status, formatLabel: FORMAT_LABELS[status.format] ?? status.format };
      localModelError = '';
    } catch (error) {
      localModelStatus = null;
      localModelError =
        error instanceof Error ? error.message : 'Could not check the local voice model';
    }
  }

  async function activateLocalModel() {
    settings.input.provider = KORY_LOCAL_PROVIDER;
    settings.input.modelId = KORY_LOCAL_MODEL;
    settings.localVoiceSetupVersion = 1;
    await save(false);
  }

  async function downloadLocalModel() {
    if (!localDesktopRuntime || localModelBusy) return;
    localModelBusy = true;
    localModelProgress = 0;
    localModelError = '';
    try {
      const status = await invoke<LocalVoiceModelStatus>('download_local_voice_model');
      localModelStatus = { ...status, formatLabel: FORMAT_LABELS[status.format] ?? status.format };
      await activateLocalModel();
      toastStore.success('Kory Voice is ready');
    } catch (error) {
      localModelError = error instanceof Error ? error.message : String(error);
      toastStore.error(localModelError || 'Voice model download failed');
    } finally {
      localModelBusy = false;
    }
  }

  async function deleteLocalModel() {
    if (!localDesktopRuntime || localModelBusy) return;
    localModelBusy = true;
    localModelError = '';
    try {
      const status = await invoke<LocalVoiceModelStatus>('delete_local_voice_model');
      localModelStatus = { ...status, formatLabel: FORMAT_LABELS[status.format] ?? status.format };
      toastStore.success('Voice model deleted');
    } catch (error) {
      localModelError = error instanceof Error ? error.message : String(error);
      toastStore.error(localModelError || 'Could not delete the voice model');
    } finally {
      localModelBusy = false;
    }
  }

  async function attachLocalModel() {
    if (!localDesktopRuntime || localModelBusy) return;
    try {
      const selected = await invoke<string | null>('select_voice_model_dialog');
      if (!selected) return;
      localModelBusy = true;
      localModelError = '';
      const status = await invoke<LocalVoiceModelStatus>('attach_local_voice_model', {
        sourcePath: selected,
      });
      localModelStatus = { ...status, formatLabel: FORMAT_LABELS[status.format] ?? status.format };
      await activateLocalModel();
      toastStore.success(`${status.name || 'Voice model'} attached`);
    } catch (error) {
      localModelError = error instanceof Error ? error.message : String(error);
      toastStore.error(localModelError || 'Could not attach the voice model');
    } finally {
      localModelBusy = false;
    }
  }

  function scheduleAutoSave(): void {
    if (!autoSaveArmed || loading) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (settingsSignature === lastSavedSignature) return;
      void save(false);
    }, AUTO_SAVE_DELAY_MS);
  }

  // Any edit that lands in `settings` is applied. `lastSavedSignature` keeps
  // the load response and our own save response from triggering another round
  // trip.
  $effect(() => {
    void settingsSignature;
    if (!autoSaveArmed || loading) return;
    if (settingsSignature === lastSavedSignature) return;
    scheduleAutoSave();
  });

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
    // The values just loaded are what the server already has; arm auto-apply
    // only afterwards so hydration never writes back.
    lastSavedSignature = JSON.stringify(settings);
    autoSaveArmed = true;
  }

  async function save(showConfirmation = true): Promise<boolean> {
    // Snapshot what is being written: an edit that lands while this request is
    // in flight must not be overwritten by the response to the older one.
    const requestSignature = JSON.stringify(settings);
    try {
      const response = await apiFetch(apiUrl('/api/voice/settings'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Save failed');
      if (JSON.stringify(settings) === requestSignature) settings = result.data;
      lastSavedSignature = JSON.stringify(result.data);
      window.dispatchEvent(
        new CustomEvent('koryphaios:voice-settings-changed', { detail: settings }),
      );
      if (showConfirmation) toastStore.success('Voice settings saved');
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not save voice settings');
      return false;
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
    localDesktopRuntime = '__TAURI_INTERNALS__' in window;
    systemSpeechSupported =
      'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    systemRecognitionSupported =
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    refreshSystemVoices();
    if (systemSpeechSupported)
      speechSynthesis.addEventListener('voiceschanged', refreshSystemVoices);
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    if (localDesktopRuntime) {
      void refreshLocalModelStatus();
      void listen<LocalVoiceDownloadProgress>(
        'koryphaios:voice-model-download-progress',
        (event) => {
          localModelProgress = Math.max(0, Math.min(100, event.payload.percent));
        },
      ).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenProgress = unlisten;
      });
    }
    void load();
    return () => {
      disposed = true;
      unlistenProgress?.();
      // Leaving the panel with an edit still inside the debounce window must
      // still apply it, otherwise closing the drawer silently discards it.
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        void save(false);
      }
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
  {#if localDesktopRuntime || attention}
    <section
      class="settings-panel space-y-3 rounded-2xl border bg-[var(--color-surface-2)] p-5 {attention &&
      !localModelStatus?.installed
        ? 'border-[var(--color-accent)]'
        : 'border-[var(--color-border)]'}"
      aria-live="polite"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h4 class="font-medium text-[var(--color-text-primary)]">Local voice transcription</h4>
          {#if localModelStatus?.installed}
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {#if localModelStatus.name}
                {localModelStatus.name} is installed and ready
              {:else}
                The local voice model is installed and ready
              {/if}
              {#if localModelStatus.formatLabel}
                · {localModelStatus.formatLabel}
              {/if}. Microphone audio is transcribed on this device.
            </p>
          {:else if localModelStatus?.unsupportedReason}
            <p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-text-muted)]">
              {localModelStatus.unsupportedReason}
            </p>
          {:else}
            <p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-text-muted)]">
              Voice needs a local voice model. Download Kory Voice or attach a voice model you
              already have — ggml, ONNX, and PyTorch models are all supported. The built in download
              is about {formatBytes(localModelStatus?.estimatedDownloadBytes)}.
            </p>
          {/if}
        </div>
        {#if localModelStatus?.installed}
          <span class="inline-flex items-center gap-1 text-xs text-[var(--color-success)]">
            <Check size={13} /> Ready
          </span>
        {/if}
      </div>
      {#if localDesktopRuntime}
        <div class="flex flex-wrap items-center gap-2">
          {#if localModelStatus?.installed}
            <button
              class="btn btn-error"
              type="button"
              disabled={localModelBusy}
              onclick={() => void deleteLocalModel()}
            >
              <Trash2 size={14} />
              Delete it
            </button>
          {:else}
            <button
              class="btn btn-primary"
              type="button"
              disabled={localModelBusy}
              onclick={() => void downloadLocalModel()}
            >
              <Download size={14} />
              {#if localModelBusy && localModelProgress > 0}
                Downloading {Math.round(localModelProgress)}%
              {:else}
                Download Kory Voice
              {/if}
            </button>
          {/if}
          <span class="text-[10px] text-[var(--color-text-muted)]">
            {#if localModelStatus?.installed && localModelStatus.sizeBytes}
              {localModelStatus.name || 'Voice model'} ·
              {formatBytes(localModelStatus.sizeBytes)}
            {:else}
              Download about {formatBytes(localModelStatus?.estimatedDownloadBytes)}
            {/if}
          </span>
        </div>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]">
          Local voice models are available in the Koryphaios desktop app.
        </p>
      {/if}
      {#if localModelError}
        <p class="text-xs text-[var(--color-error)]">{localModelError}</p>
      {/if}
    </section>
  {/if}
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Checking voice capabilities…</p>
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      <section
        class="settings-panel space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
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
          allowCustom={settings.input.provider !== 'system' &&
            settings.input.provider !== KORY_LOCAL_PROVIDER}
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
        class="settings-panel space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
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
      class="settings-panel space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
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
      class="settings-panel rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
    >
      <h4 class="font-medium text-[var(--color-text-primary)]">Use another local speech server</h4>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        You can also serve a speech model with an OpenAI compatible local runtime such as LocalAI,
        speaches, LM Studio, or llama.cpp. Configure its endpoint under Providers &amp; models, then
        select that provider above.
      </p>
      {#if localDesktopRuntime}
        <div class="space-y-2 pt-1">
          <button
            class="btn"
            type="button"
            disabled={localModelBusy}
            onclick={() => void attachLocalModel()}
          >
            <FolderOpen size={14} /> Attach a voice model
          </button>
          <p class="text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            Attaching an ONNX export? Select the encoder file and Koryphaios picks up the decoder and
            tokenizer beside it.
          </p>
        </div>
      {/if}
    </section>
  {/if}
</div>
