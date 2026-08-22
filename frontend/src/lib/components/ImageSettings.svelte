<script lang="ts">
  import { onMount } from 'svelte';
  import Download from 'lucide-svelte/icons/download';
  import Eye from 'lucide-svelte/icons/eye';
  import Image from 'lucide-svelte/icons/image';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import WandSparkles from 'lucide-svelte/icons/wand-sparkles';
  import { apiFetch } from '$lib/api.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import KorySelect from './KorySelect.svelte';

  type GeneratedImage = {
    imageBase64: string;
    mimeType: string;
    revisedPrompt?: string;
    provider: string;
    model: string;
  };

  const effects = [
    { value: 'none', label: 'Natural', description: 'Use only your prompt' },
    { value: 'cinematic', label: 'Cinematic', description: 'Film lighting and dramatic depth' },
    { value: 'illustration', label: 'Illustration', description: 'Polished editorial artwork' },
    { value: 'neon', label: 'Neon glow', description: 'Luminous color and atmosphere' },
    { value: 'miniature', label: 'Miniature', description: 'Tilt-shift tactile diorama' },
    { value: 'watercolor', label: 'Watercolor', description: 'Layered pigment and paper texture' },
  ];
  const sizes = [
    { value: '1024x1024', label: 'Square · 1024×1024' },
    { value: '1536x1024', label: 'Landscape · 1536×1024' },
    { value: '1024x1536', label: 'Portrait · 1024×1536' },
    { value: 'auto', label: 'Automatic' },
  ];
  const qualities = [
    { value: 'low', label: 'Draft' },
    { value: 'medium', label: 'Standard' },
    { value: 'high', label: 'High detail' },
    { value: 'auto', label: 'Automatic' },
  ];
  const formats = [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
  ];

  let configured = $state(false);
  let loading = $state(true);
  let generating = $state(false);
  let prompt = $state('');
  let effect = $state('cinematic');
  let size = $state('1024x1024');
  let quality = $state('medium');
  let outputFormat = $state('png');
  let background = $state('auto');
  let generated = $state<GeneratedImage | null>(null);
  let imageUrl = $derived(generated ? `data:${generated.mimeType};base64,${generated.imageBase64}` : '');

  async function loadProviders() {
    loading = true;
    try {
      const response = await apiFetch(apiUrl('/api/images/providers'));
      const result = await response.json();
      configured = response.ok && result.data?.some((provider: { configured: boolean }) => provider.configured);
    } catch {
      configured = false;
    } finally {
      loading = false;
    }
  }

  async function generate() {
    if (!prompt.trim() || generating) return;
    generating = true;
    try {
      const response = await apiFetch(apiUrl('/api/images/generate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, effect, size, quality, background, outputFormat }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Image generation failed');
      generated = result.data;
      toastStore.success('Image generated');
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Image generation failed');
    } finally {
      generating = false;
    }
  }

  function downloadImage() {
    if (!generated) return;
    const anchor = document.createElement('a');
    anchor.href = imageUrl;
    anchor.download = `koryphaios-image-${Date.now()}.${outputFormat === 'jpeg' ? 'jpg' : outputFormat}`;
    anchor.click();
  }

  onMount(() => void loadProviders());
</script>

<div class="mx-auto w-full max-w-5xl space-y-6 p-6">
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex items-start gap-3">
      <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]">
        <Image size={20} />
      </div>
      <div>
        <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Images</h3>
        <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
          Generate images with OpenAI Images, apply a visual treatment, and download the original result.
        </p>
      </div>
    </div>
    <button type="button" class="btn" onclick={() => void loadProviders()} disabled={loading}>
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} /> Refresh
    </button>
  </header>

  <section class="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
    <div class="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
      <div class="space-y-5 p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h4 class="font-medium text-[var(--color-text-primary)]">Image studio</h4>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">OpenAI · gpt-image-1</p>
          </div>
          <span class="rounded-full px-2.5 py-1 text-[10px] font-medium {configured ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]' : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]'}">
            {configured ? 'Ready' : 'Connect OpenAI'}
          </span>
        </div>

        <label class="block space-y-2">
          <span class="text-xs font-medium text-[var(--color-text-secondary)]">Prompt</span>
          <textarea
            bind:value={prompt}
            rows="5"
            maxlength="32000"
            placeholder="Describe the subject, composition, lighting, colors, and mood…"
            class="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/35"
          ></textarea>
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <KorySelect value={effect} options={effects} label="Visual effect" onchange={(value) => (effect = value)} />
          <KorySelect value={size} options={sizes} label="Canvas size" onchange={(value) => (size = value)} />
          <KorySelect value={quality} options={qualities} label="Quality" onchange={(value) => (quality = value)} />
          <KorySelect value={outputFormat} options={formats} label="File format" onchange={(value) => (outputFormat = value)} />
        </div>

        <div class="flex flex-wrap gap-2" role="group" aria-label="Image background">
          {#each ['auto', 'opaque', 'transparent'] as option}
            <button
              type="button"
              aria-pressed={background === option}
              class="rounded-full border px-3 py-1.5 text-xs capitalize transition-colors {background === option ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]'}"
              onclick={() => (background = option)}>{option}</button
            >
          {/each}
        </div>

        <button
          type="button"
          class="btn btn-primary w-full justify-center py-3"
          disabled={!configured || !prompt.trim() || generating}
          onclick={() => void generate()}
        >
          {#if generating}<Sparkles size={16} class="animate-pulse" /> Creating image…{:else}<WandSparkles size={16} /> Generate image{/if}
        </button>
      </div>

      <div class="relative flex min-h-96 items-center justify-center overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 lg:border-l lg:border-t-0">
        <div class="pointer-events-none absolute inset-0 opacity-40 image-atmosphere"></div>
        {#if generated}
          <div class="relative w-full space-y-3 image-result">
            <img src={imageUrl} alt={generated.revisedPrompt || prompt} class="mx-auto max-h-[34rem] w-full rounded-xl object-contain shadow-2xl" />
            <div class="flex items-center justify-between gap-3">
              <p class="min-w-0 truncate text-[10px] text-[var(--color-text-muted)]">{generated.model}</p>
              <button type="button" class="btn" onclick={downloadImage}><Download size={14} /> Download</button>
            </div>
          </div>
        {:else}
          <div class="relative max-w-xs text-center text-[var(--color-text-muted)]">
            <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-accent)]">
              <Sparkles size={28} />
            </div>
            <p class="text-sm font-medium text-[var(--color-text-secondary)]">Your generated image appears here</p>
            <p class="mt-2 text-xs leading-relaxed">Choose an effect and format, then generate an original image.</p>
          </div>
        {/if}
      </div>
    </div>
  </section>

  <section class="flex items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5">
    <Eye size={18} class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
    <div>
      <h4 class="font-medium text-[var(--color-text-primary)]">Image input is enabled</h4>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Paste or attach images in chat, and agents can inspect workspace images with the scoped image viewer.
      </p>
    </div>
  </section>
</div>

<style>
  .image-atmosphere {
    background:
      radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--color-accent) 35%, transparent), transparent 40%),
      radial-gradient(circle at 80% 75%, color-mix(in srgb, var(--color-info) 25%, transparent), transparent 42%);
  }
  .image-result { animation: reveal-image 420ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  @keyframes reveal-image {
    from { opacity: 0; transform: translateY(8px) scale(0.985); filter: blur(6px); }
    to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .image-result { animation: none; }
  }
</style>
