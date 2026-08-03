<script lang="ts">
  import { Image, ShieldCheck } from 'lucide-svelte';
  import ProviderConnectionCard from './ProviderConnectionCard.svelte';
  const providers = [
    { id: 'openai', name: 'OpenAI', description: 'Image generation and editing through supported OpenAI image models' },
    { id: 'aistudio', name: 'Google AI Studio', description: 'Google image generation through configured Gemini image models' },
    { id: 'xai', name: 'xAI', description: 'Image generation through xAI image models' },
    { id: 'blackforestlabs', name: 'Black Forest Labs', description: 'FLUX image generation models' },
    { id: 'fal', name: 'fal', description: 'Hosted image generation and editing models' },
    { id: 'replicate', name: 'Replicate', description: 'Hosted community image models' },
    { id: 'stabilityai', name: 'Stability AI', description: 'Stable image generation models' },
  ];
</script>
<div class="mx-auto w-full max-w-5xl space-y-6 p-6"><div class="flex items-start gap-3"><div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]"><Image size={20}/></div><div><h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Images</h3><p class="mt-1 text-sm text-[var(--color-text-muted)]">Connect image services where they are used. Chat and coding providers remain under AI Models.</p></div></div><div class="grid gap-3 md:grid-cols-2">{#each providers as provider (provider.id)}<ProviderConnectionCard {...provider}/>{/each}</div><div class="flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-xs text-[var(--color-text-muted)]"><ShieldCheck size={16} class="shrink-0 text-emerald-400"/><span>Credentials are shared by provider, not copied into image settings. Image model discovery and defaults stay capability-specific.</span></div></div>
