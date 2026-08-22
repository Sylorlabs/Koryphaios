<script lang="ts">
  import { onMount } from 'svelte';
  import Check from 'lucide-svelte/icons/check';
  import Download from 'lucide-svelte/icons/download';
  import Mic from 'lucide-svelte/icons/mic';
  import Play from 'lucide-svelte/icons/play';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Square from 'lucide-svelte/icons/square';
  import Volume2 from 'lucide-svelte/icons/volume-2';
  import type { VoicePackStatus, VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { playVoiceResponse, stopVoicePlayback } from '$lib/utils/voice-playback';
  import KorySelect from './KorySelect.svelte';
  import KorySlider from './KorySlider.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';

  const DEFAULT_SETTINGS: VoiceSettings = {
    input: { provider: 'openai', modelId: 'gpt-4o-mini-transcribe', language: 'en' },
    output: { provider: 'system', modelId: 'web-speech-synthesis', voiceId: 'system-default', speed: 1 },
    autoReadFinalReplies: false,
    voiceModeEnabled: true,
    liveTranscription: false,
  };
  const openAIVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((voice) => ({ value: voice, label: voice.charAt(0).toUpperCase() + voice.slice(1) }));

  let settings = $state<VoiceSettings>(structuredClone(DEFAULT_SETTINGS));
  let providers = $state<VoiceProviderDescriptor[]>([]);
  let voicePacks = $state<VoicePackStatus[]>([]);
  let systemVoices = $state<Array<{ value: string; label: string }>>([]);
  let loading = $state(true);
  let saving = $state(false);
  let downloading = $state(false);
  let previewing = $state(false);
  let systemSpeechSupported = $state(false);
  let openAIConfigured = $derived(providers.find((provider) => provider.id === 'openai')?.configured === true);
  let englishDictation = $derived(voicePacks.find((pack) => pack.manifest.id === 'moonshine-tiny-en-int8'));
  let outputOptions = $derived([
    { value: 'system', label: 'Operating system', description: 'Uses voices installed on this device' },
    { value: 'openai', label: 'OpenAI Audio', description: openAIConfigured ? 'Cloud speech is ready' : 'Connect OpenAI first', disabled: !openAIConfigured },
  ]);
  let voiceOptions = $derived(settings.output.provider === 'openai' ? openAIVoices : [{ value: 'system-default', label: 'System default' }, ...systemVoices]);

  function refreshSystemVoices() {
    if (!systemSpeechSupported) return;
    systemVoices = speechSynthesis.getVoices().map((voice) => ({ value: voice.voiceURI, label: `${voice.name} · ${voice.lang}` }));
  }

  async function load() {
    loading = true;
    const [settingsResult, providerResult, packResult] = await Promise.allSettled([
      apiFetch(apiUrl('/api/voice/settings')).then((response) => response.json()),
      apiFetch(apiUrl('/api/voice/providers')).then((response) => response.json()),
      apiFetch(apiUrl('/api/voice/packs')).then((response) => response.json()),
    ]);
    if (settingsResult.status === 'fulfilled' && settingsResult.value.data) settings = settingsResult.value.data;
    if (providerResult.status === 'fulfilled' && Array.isArray(providerResult.value.data)) providers = providerResult.value.data;
    if (packResult.status === 'fulfilled' && Array.isArray(packResult.value.data)) voicePacks = packResult.value.data;
    loading = false;
  }

  async function save(showConfirmation = true): Promise<boolean> {
    saving = true;
    try {
      const response = await apiFetch(apiUrl('/api/voice/settings'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Save failed');
      settings = result.data;
      if (showConfirmation) toastStore.success('Voice settings saved');
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not save voice settings');
      return false;
    } finally {
      saving = false;
    }
  }

  function selectOutput(provider: string) {
    settings.output.provider = provider;
    settings.output.modelId = provider === 'openai' ? 'gpt-4o-mini-tts' : 'web-speech-synthesis';
    settings.output.voiceId = provider === 'openai' ? 'alloy' : 'system-default';
  }

  async function previewVoice() {
    if (previewing || !(await save(false))) return;
    previewing = true;
    try {
      await playVoiceResponse('voice-settings-preview', 'Koryphaios voice input and speech playback are ready.');
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Speech preview failed');
    } finally {
      previewing = false;
    }
  }

  async function downloadPack() {
    if (!englishDictation || downloading) return;
    downloading = true;
    try {
      const response = await apiFetch(apiUrl(`/api/voice/packs/${englishDictation.manifest.id}/download`), { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Model download failed');
      await load();
      toastStore.success('Speech model downloaded and verified');
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Model download failed');
    } finally {
      downloading = false;
    }
  }

  onMount(() => {
    systemSpeechSupported = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    refreshSystemVoices();
    if (systemSpeechSupported) speechSynthesis.addEventListener('voiceschanged', refreshSystemVoices);
    void load();
    return () => {
      stopVoicePlayback();
      if (systemSpeechSupported) speechSynthesis.removeEventListener('voiceschanged', refreshSystemVoices);
    };
  });
</script>

<div class="mx-auto w-full max-w-4xl space-y-6 p-6">
  <header>
    <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Voice</h3>
    <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">Record prompts with OpenAI transcription and hear replies through system or OpenAI voices.</p>
  </header>
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Checking voice capabilities…</p>
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5">
        <div class="flex items-start gap-3">
          <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]"><Mic size={18} /></div>
          <div><h4 class="font-medium text-[var(--color-text-primary)]">Speech to text</h4><p class="mt-1 text-xs text-[var(--color-text-muted)]">OpenAI · gpt-4o-mini-transcribe</p></div>
        </div>
        <div class="flex items-center gap-2 text-xs {openAIConfigured ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}">
          {#if openAIConfigured}<Check size={13} /> Ready{:else}Connect OpenAI in Providers to enable the composer microphone.{/if}
        </div>
        <KorySelect value={settings.input.language} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Spanish' }, { value: 'fr', label: 'French' }, { value: 'de', label: 'German' }, { value: 'ja', label: 'Japanese' }, { value: 'zh', label: 'Chinese' }]} label="Input language" onchange={(value) => (settings.input.language = value)} />
      </section>

      <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5">
        <div class="flex items-start gap-3">
          <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]"><Volume2 size={18} /></div>
          <div><h4 class="font-medium text-[var(--color-text-primary)]">Text to speech</h4><p class="mt-1 text-xs text-[var(--color-text-muted)]">Choose local system playback or generated cloud audio.</p></div>
        </div>
        <KorySelect value={settings.output.provider} options={outputOptions} label="Speech provider" onchange={selectOutput} />
        <KorySelect value={settings.output.voiceId} options={voiceOptions} label="Voice" onchange={(value) => (settings.output.voiceId = value)} />
        <KorySlider id="voice-preview-speed" label="Speech speed" value={settings.output.speed} min={0.5} max={2} step={0.1} unit="×" displayValue={`${settings.output.speed.toFixed(1)}×`} valueText={`${settings.output.speed.toFixed(1)} times normal speed`} onchange={(value) => (settings.output.speed = value)} />
        {#if previewing}<button class="btn" type="button" onclick={() => { stopVoicePlayback(); previewing = false; }}><Square size={13} /> Stop</button>{:else}<button class="btn" type="button" disabled={(settings.output.provider === 'system' && !systemSpeechSupported) || (settings.output.provider === 'openai' && !openAIConfigured)} onclick={() => void previewVoice()}><Play size={13} /> Test voice</button>{/if}
      </section>
    </div>

    <section class="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5">
      <SettingsSwitch checked={settings.voiceModeEnabled} label="Composer microphone" description="Show and enable audio recording in the message composer." onchange={() => { settings.voiceModeEnabled = !settings.voiceModeEnabled; }} />
      <SettingsSwitch checked={settings.autoReadFinalReplies} label="Read final replies aloud" description="Automatically play completed assistant replies with the selected voice." onchange={() => { settings.autoReadFinalReplies = !settings.autoReadFinalReplies; }} />
    </section>

    {#if englishDictation}
      <section class="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5">
        <div>
          <h4 class="font-medium text-[var(--color-text-primary)]">{englishDictation.manifest.name}</h4>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">Verified local assets for the upcoming on-device runtime · current transcription uses OpenAI · {(englishDictation.manifest.sizeBytes / 1024 / 1024).toFixed(0)} MB</p>
        </div>
        {#if englishDictation.state === 'installed'}<span class="rounded-full bg-[var(--color-success-bg)] px-3 py-1.5 text-xs text-[var(--color-success)]"><Check size={12} class="inline" /> Installed</span>{:else}<button class="btn" type="button" disabled={downloading} onclick={() => void downloadPack()}><Download size={14} /> {downloading ? 'Downloading…' : 'Download model'}</button>{/if}
      </section>
    {/if}

    <div class="flex justify-end gap-2"><button class="btn" type="button" onclick={() => void load()}><RefreshCw size={14} /> Reload</button><button class="btn btn-primary" type="button" disabled={saving} onclick={() => void save()}>{saving ? 'Saving…' : 'Save voice settings'}</button></div>
  {/if}
</div>
