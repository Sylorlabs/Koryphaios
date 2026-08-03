<script lang="ts">
  import { onMount } from 'svelte';
  import { Download, Mic, RefreshCw, Upload, Volume2 } from 'lucide-svelte';
  import type { VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
  import KorySelect from './KorySelect.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import ProviderConnectionCard from './ProviderConnectionCard.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { providersStore } from '$lib/stores/providers.svelte';

  const DEFAULT_PROVIDERS: VoiceProviderDescriptor[] = [
    { id: 'local', name: 'On device', capabilities: ['stt', 'tts'], local: true, configured: true, supportsDiscovery: false },
    { id: 'system', name: 'System voice', capabilities: ['stt', 'tts'], local: false, configured: true, supportsDiscovery: true },
    { id: 'openai', name: 'OpenAI', capabilities: ['stt', 'tts'], local: false, configured: false, supportsDiscovery: true },
    { id: 'aistudio', name: 'Google AI Studio', capabilities: ['stt', 'tts'], local: false, configured: false, supportsDiscovery: true },
    { id: 'elevenlabs', name: 'ElevenLabs', capabilities: ['stt', 'tts'], local: false, configured: false, supportsDiscovery: true },
    { id: 'deepgram', name: 'Deepgram', capabilities: ['stt', 'tts'], local: false, configured: false, supportsDiscovery: true },
    { id: 'gladia', name: 'Gladia', capabilities: ['stt'], local: false, configured: false, supportsDiscovery: false },
    { id: 'assemblyai', name: 'AssemblyAI', capabilities: ['stt'], local: false, configured: false, supportsDiscovery: false },
    { id: 'lmnt', name: 'LMNT', capabilities: ['tts'], local: false, configured: false, supportsDiscovery: true },
  ];

  let settings = $state<VoiceSettings>({ input: { provider: 'local', modelId: 'moonshine-tiny-en-int8', language: 'en' }, output: { provider: 'local', modelId: 'kitten-tts-0.8-micro', voiceId: 'expr-voice-2-m', speed: 1 }, autoReadFinalReplies: false, voiceModeEnabled: true, liveTranscription: true });
  let providers = $state<VoiceProviderDescriptor[]>(DEFAULT_PROVIDERS);
  let loading = $state(true); let saving = $state(false);
  let inputProviders = $derived(providers.filter(p => p.capabilities.includes('stt')).map(p => ({ value: p.id, label: `${p.name}${p.configured ? '' : ' — key required'}` })));
  let outputProviders = $derived(providers.filter(p => p.capabilities.includes('tts')).map(p => ({ value: p.id, label: `${p.name}${p.configured ? '' : ' — key required'}` })));
  const voices = [1,2,3,4,5,6,7,8].map((n) => ({ value: `expr-voice-${n}-${n % 2 ? 'm' : 'f'}`, label: `Kitten voice ${n}` }));
  const providerDescriptions: Record<string, string> = { openai: 'Uses your existing OpenAI connection for transcription and speech', aistudio: 'Uses your existing Google AI Studio connection for audio-capable models', elevenlabs: 'Speech input and natural voice output', deepgram: 'Real-time transcription and speech output', gladia: 'Multilingual speech transcription', assemblyai: 'Speech transcription and language intelligence', lmnt: 'Low-latency speech output' };
  async function withSavedConnection(provider: VoiceProviderDescriptor): Promise<VoiceProviderDescriptor> {
    if (provider.local || provider.id === 'system' || provider.configured || providersStore.statusList.some(status => status.name === provider.id && status.authenticated)) return { ...provider, configured: true };
    try { const result = await apiFetch(apiUrl(`/api/providers/${provider.id}/accounts`)).then(response => response.json()); return { ...provider, configured: (result.data?.length ?? 0) > 0 }; } catch { return provider; }
  }
  async function load() {
    loading = true;
    const [settingsResult, providerResult] = await Promise.allSettled([
      apiFetch(apiUrl('/api/voice/settings')).then(r => r.json()),
      apiFetch(apiUrl('/api/voice/providers')).then(r => r.json()),
    ]);
    if (settingsResult.status === 'fulfilled' && settingsResult.value.data) settings = settingsResult.value.data;
    const catalog = providerResult.status === 'fulfilled' && Array.isArray(providerResult.value.data) && providerResult.value.data.length ? providerResult.value.data : DEFAULT_PROVIDERS;
    providers = await Promise.all(catalog.map(withSavedConnection));
    loading = false;
  }
  async function save() { saving = true; try { const r = await apiFetch(apiUrl('/api/voice/settings'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); toastStore.success('Voice settings saved'); } catch (e) { toastStore.error(e instanceof Error ? e.message : 'Could not save voice settings'); } finally { saving = false; } }
  onMount(load);
</script>

<div class="mx-auto w-full max-w-5xl space-y-6 p-6">
  <div><h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Voice</h3><p class="mt-1 text-sm text-[var(--color-text-muted)]">Dictation is inserted into the composer for editing. Local voice never falls back to a paid cloud provider.</p></div>
  {#if loading}<p class="text-sm text-[var(--color-text-muted)]">Loading voice settings…</p>{:else}
    <section class="grid gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 md:grid-cols-2">
      <div class="space-y-4"><div class="flex items-center gap-2 font-medium"><Mic size={16}/> Speech input</div>
        <label class="block text-xs text-[var(--color-text-muted)]">Provider<KorySelect options={inputProviders} value={settings.input.provider} onchange={(value) => { settings.input.provider = value; }}/></label>
        <label class="block text-xs text-[var(--color-text-muted)]">Model ID<input class="input mt-1 w-full" bind:value={settings.input.modelId}/></label>
        <label class="block text-xs text-[var(--color-text-muted)]">Language<input class="input mt-1 w-full" bind:value={settings.input.language}/></label>
      </div>
      <div class="space-y-4"><div class="flex items-center gap-2 font-medium"><Volume2 size={16}/> Speech output</div>
        <label class="block text-xs text-[var(--color-text-muted)]">Provider<KorySelect options={outputProviders} value={settings.output.provider} onchange={(value) => { settings.output.provider = value; }}/></label>
        <label class="block text-xs text-[var(--color-text-muted)]">Model ID<input class="input mt-1 w-full" bind:value={settings.output.modelId}/></label>
        {#if settings.output.provider === 'local'}<label class="block text-xs text-[var(--color-text-muted)]">Voice<KorySelect options={voices} value={settings.output.voiceId} onchange={(value) => { settings.output.voiceId = value; }}/></label>{:else}<label class="block text-xs text-[var(--color-text-muted)]">Voice ID<input class="input mt-1 w-full" bind:value={settings.output.voiceId}/></label>{/if}
        <label class="block text-xs text-[var(--color-text-muted)]">Speed: {settings.output.speed.toFixed(1)}×<input class="mt-2 w-full accent-[var(--color-accent)]" type="range" min="0.5" max="2" step="0.1" bind:value={settings.output.speed}/></label>
      </div>
      <div class="space-y-2 md:col-span-2">
        <SettingsSwitch checked={settings.voiceModeEnabled} label="Show voice controls" description="Adds dictation to the composer and Play/Stop to completed replies." onchange={() => { settings.voiceModeEnabled = !settings.voiceModeEnabled; }}/>
        <SettingsSwitch checked={settings.liveTranscription} label="Show words while speaking" description="Supported by System voice. Offline Moonshine replaces the text with its final transcript after Stop." onchange={() => { settings.liveTranscription = !settings.liveTranscription; }}/>
        <SettingsSwitch checked={settings.autoReadFinalReplies} label="Automatically read completed replies" description="Off by default. Thinking and tool output are never read." onchange={() => { settings.autoReadFinalReplies = !settings.autoReadFinalReplies; }}/>
      </div>
    </section>
    <section class="space-y-3"><div><h4 class="font-medium text-[var(--color-text-primary)]">Cloud voice connections</h4><p class="text-xs text-[var(--color-text-muted)]">Connect here once. The same encrypted credential is reused anywhere this provider is available.</p></div><div class="grid gap-3 md:grid-cols-2">{#each providers.filter(provider => !provider.local && provider.id !== 'system') as provider (provider.id)}<ProviderConnectionCard id={provider.id} name={provider.name} configured={provider.configured} description={providerDescriptions[provider.id] ?? provider.capabilities.join(' and ')} onconnected={load}/>{/each}</div></section>
    <section class="space-y-3"><h4 class="font-medium text-[var(--color-text-primary)]">Local language packs</h4>
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"><div class="flex items-center justify-between"><div><div class="font-medium">English speech output <span class="ml-2 rounded-full bg-[var(--color-surface-3)] px-2 py-0.5 text-[10px]">Built in</span></div><div class="text-xs text-[var(--color-text-muted)]">KittenTTS 0.8 Micro · ~41 MB · Apache-2.0 · 8 voices</div></div></div></div>
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"><div class="flex items-center justify-between gap-4"><div><div class="font-medium">English Dictation</div><div class="text-xs text-[var(--color-text-muted)]">Moonshine Tiny INT8 · ~124 MB · downloads on first use</div></div><button class="btn" disabled title="Native pack catalog is not included in this build"><Download size={14}/> Download</button></div></div>
      <p class="text-xs text-[var(--color-text-muted)]">System voice works immediately where the operating system or webview exposes speech services. Those services may use the operating-system vendor's cloud; select it explicitly only if that is acceptable.</p>
      <button class="btn" disabled title="Desktop .koryvoice importer is not included in this build"><Upload size={14}/> Import .koryvoice</button>
    </section>
    <div class="flex justify-end gap-2"><button class="btn" onclick={load}><RefreshCw size={14}/> Reload</button><button class="btn btn-primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save voice settings'}</button></div>
  {/if}
</div>
