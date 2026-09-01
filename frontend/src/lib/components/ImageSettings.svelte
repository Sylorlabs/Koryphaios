<script lang="ts">
  import { onMount } from 'svelte';
  import Copy from 'lucide-svelte/icons/copy';
  import Download from 'lucide-svelte/icons/download';
  import Eye from 'lucide-svelte/icons/eye';
  import Image from 'lucide-svelte/icons/image';
  import ImagePlus from 'lucide-svelte/icons/image-plus';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import WandSparkles from 'lucide-svelte/icons/wand-sparkles';
  import X from 'lucide-svelte/icons/x';
  import { apiFetch } from '$lib/api.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import {
    clearRecoverableImageJob,
    loadRecoverableImageJob,
    saveRecoverableImageJob,
  } from '$lib/utils/image-job-recovery';
  import KorySelect from './KorySelect.svelte';

  type ImageModelInfo = {
    id: string;
    label: string;
    sizes?: string[];
    qualities?: string[];
    formats?: string[];
    background?: string[];
    edits?: boolean;
  };
  type ImageProviderInfo = {
    id: string;
    label: string;
    adapter: string;
    configured: boolean;
    models: ImageModelInfo[];
  };
  type GeneratedImage = {
    imageBase64: string;
    mimeType: string;
    revisedPrompt?: string;
    provider: string;
    model: string;
  };
  type HistoryEntry = {
    id: string;
    ts: number;
    provider: string;
    model: string;
    mimeType: string;
    prompt: string;
    revisedPrompt?: string;
    effect?: string;
    size?: string;
    quality?: string;
    mode: 'generate' | 'edit';
  };
  type AttachedImage = { base64: string; mimeType: string; name: string };
  type ImageJobStatus = 'running' | 'completed' | 'unknown';

  const IMAGE_JOB_POLL_INTERVAL_MS = 1_500;

  const effects = [
    { value: 'none', label: 'Natural', description: 'Use only your prompt' },
    { value: 'cinematic', label: 'Cinematic', description: 'Film lighting and dramatic depth' },
    { value: 'illustration', label: 'Illustration', description: 'Polished editorial artwork' },
    { value: 'neon', label: 'Neon glow', description: 'Luminous color and atmosphere' },
    { value: 'miniature', label: 'Miniature', description: 'Tilt-shift tactile diorama' },
    { value: 'watercolor', label: 'Watercolor', description: 'Layered pigment and paper texture' },
  ];
  const SIZE_LABELS: Record<string, string> = {
    '1024x1024': 'Square · 1024×1024',
    '1536x1024': 'Landscape · 1536×1024',
    '1024x1536': 'Portrait · 1024×1536',
    '1792x1024': 'Landscape · 1792×1024',
    '1024x1792': 'Portrait · 1024×1792',
    auto: 'Automatic',
  };
  const QUALITY_LABELS: Record<string, string> = {
    low: 'Draft',
    medium: 'Standard',
    high: 'High detail',
    standard: 'Standard',
    hd: 'High detail',
    auto: 'Automatic',
  };
  const FORMAT_LABELS: Record<string, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };
  const FALLBACK_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
  const FALLBACK_QUALITIES = ['low', 'medium', 'high', 'auto'];
  const FALLBACK_FORMATS = ['png', 'jpeg', 'webp'];

  let providers = $state<ImageProviderInfo[]>([]);
  let selectedProvider = $state('');
  let selectedModel = $state('');
  let loading = $state(true);
  let generating = $state(false);
  let generationController = $state<AbortController | null>(null);
  let generationJobId = $state<string | null>(null);
  let generationPollTimer: ReturnType<typeof setTimeout> | null = null;
  let generationStatusMessage = $state('');
  let explicitlyCancellingJobId = $state<string | null>(null);
  let componentMounted = false;
  let prompt = $state('');
  let visualEffect = $state('cinematic');
  let size = $state('1024x1024');
  let quality = $state('medium');
  let outputFormat = $state('png');
  let background = $state('auto');
  let generated = $state<GeneratedImage | null>(null);
  let generatedHistoryId = $state('');
  let generatedPrompt = $state('');
  let history = $state<HistoryEntry[]>([]);
  let sourceImage = $state<AttachedImage | null>(null);
  let fileInput = $state<HTMLInputElement>();
  let imageUrl = $derived(
    generated ? `data:${generated.mimeType};base64,${generated.imageBase64}` : '',
  );

  const configuredProviders = $derived(providers.filter((provider) => provider.configured));
  const activeProvider = $derived(
    configuredProviders.find((provider) => provider.id === selectedProvider) ??
      configuredProviders[0],
  );
  const activeModel = $derived(
    activeProvider
      ? (activeProvider.models.find((model) => model.id === selectedModel) ??
          (selectedModel ? { id: selectedModel, label: selectedModel } : activeProvider.models[0]))
      : undefined,
  );
  const ready = $derived(Boolean(activeProvider?.configured && activeModel));
  const sizeOptions = $derived(
    (activeModel?.sizes ?? FALLBACK_SIZES).map((value) => ({
      value,
      label: SIZE_LABELS[value] ?? value,
    })),
  );
  const qualityOptions = $derived(
    (activeModel?.qualities ?? FALLBACK_QUALITIES).map((value) => ({
      value,
      label: QUALITY_LABELS[value] ?? value,
    })),
  );
  const formatOptions = $derived(
    (activeModel?.formats ?? FALLBACK_FORMATS).map((value) => ({
      value,
      label: FORMAT_LABELS[value] ?? value.toUpperCase(),
    })),
  );
  const backgroundOptions = $derived(activeModel?.background ?? []);

  $effect(() => {
    const model = activeModel;
    if (!model) return;
    const sizes = model.sizes ?? FALLBACK_SIZES;
    if (!sizes.includes(size))
      size = sizes.find((value) => value === '1024x1024') ?? sizes[0] ?? 'auto';
    const qualities = model.qualities ?? FALLBACK_QUALITIES;
    if (!qualities.includes(quality))
      quality = qualities.find((value) => value === 'medium') ?? qualities[0] ?? 'auto';
    const formats = model.formats ?? FALLBACK_FORMATS;
    if (!formats.includes(outputFormat))
      outputFormat = formats.find((value) => value === 'png') ?? formats[0] ?? 'png';
    const backgrounds = model.background ?? [];
    if (backgrounds.length === 0) background = 'auto';
    else if (!backgrounds.includes(background))
      background = backgrounds.includes('auto') ? 'auto' : (backgrounds[0] ?? 'auto');
  });

  async function loadProviders() {
    loading = true;
    try {
      const response = await apiFetch(apiUrl('/api/images/providers'));
      const result = await response.json();
      providers = response.ok && Array.isArray(result.data) ? result.data : [];
      const configured = providers.filter((provider) => provider.configured);
      if (!configured.some((provider) => provider.id === selectedProvider)) {
        selectedProvider = configured[0]?.id ?? '';
      }
      const nextActive =
        configured.find((provider) => provider.id === selectedProvider) ?? configured[0];
      if (!nextActive?.models.some((model) => model.id === selectedModel)) {
        selectedModel = nextActive?.models[0]?.id ?? '';
      }
    } catch {
      providers = [];
    } finally {
      loading = false;
    }
  }

  function selectProvider(id: string) {
    selectedProvider = id;
    const provider = configuredProviders.find((candidate) => candidate.id === id);
    if (!provider?.models.some((model) => model.id === selectedModel)) {
      selectedModel = provider?.models[0]?.id ?? '';
    }
  }

  async function loadHistory() {
    try {
      const response = await apiFetch(apiUrl('/api/images/history?limit=12'));
      const result = await response.json();
      history = response.ok && Array.isArray(result.data) ? result.data : [];
    } catch {
      history = [];
    }
  }

  function clearGenerationPollTimer() {
    if (generationPollTimer) {
      clearTimeout(generationPollTimer);
      generationPollTimer = null;
    }
  }

  function clearRecoverableJobIfCurrent(jobId: string) {
    if (loadRecoverableImageJob()?.jobId === jobId) clearRecoverableImageJob();
  }

  function finishTrackedGeneration(jobId: string) {
    clearGenerationPollTimer();
    clearRecoverableJobIfCurrent(jobId);
    if (generationJobId === jobId) {
      generationJobId = null;
      generating = false;
      generationStatusMessage = '';
    }
  }

  async function loadHistoryEntry(id: string, fallbackPrompt = ''): Promise<boolean> {
    try {
      const response = await apiFetch(apiUrl(`/api/images/history/${encodeURIComponent(id)}`));
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Image not found');
      generated = {
        imageBase64: result.data.imageBase64,
        mimeType: result.data.mimeType,
        revisedPrompt: result.data.revisedPrompt,
        provider: result.data.provider,
        model: result.data.model,
      };
      generatedHistoryId = id;
      generatedPrompt = result.data.prompt ?? fallbackPrompt;
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not load image');
      return false;
    }
  }

  function scheduleGenerationStatusPoll(jobId: string) {
    clearGenerationPollTimer();
    if (!componentMounted) return;
    generationPollTimer = setTimeout(() => {
      generationPollTimer = null;
      void pollGenerationStatus(jobId);
    }, IMAGE_JOB_POLL_INTERVAL_MS);
  }

  async function pollGenerationStatus(jobId: string): Promise<void> {
    const tracked = loadRecoverableImageJob();
    if (!componentMounted || tracked?.jobId !== jobId) return;

    try {
      const response = await apiFetch(apiUrl(`/api/images/jobs/${encodeURIComponent(jobId)}`));
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: { status?: ImageJobStatus; historyId?: string };
      };
      if (!response.ok || !result.ok || !result.data?.status) {
        throw new Error(result.error || 'Could not check image generation status');
      }

      if (result.data.status === 'running') {
        generationJobId = jobId;
        generating = true;
        generationStatusMessage = 'Generation is still running in the background.';
        scheduleGenerationStatusPoll(jobId);
        return;
      }

      if (result.data.status === 'completed' && result.data.historyId) {
        // The image history entry is durable. Do not discard recovery state
        // until the completed result has actually been restored into this view.
        const restored = await loadHistoryEntry(result.data.historyId);
        if (!componentMounted || !restored) {
          if (componentMounted) scheduleGenerationStatusPoll(jobId);
          return;
        }
        await loadHistory();
        finishTrackedGeneration(jobId);
        toastStore.success('Recovered completed image');
        return;
      }

      // `unknown` is the honest result after a backend restart or retention
      // expiry. The gallery remains available, but this renderer has no job to
      // resume, so remove only the opaque recovery id.
      finishTrackedGeneration(jobId);
      toastStore.info(
        result.data.status === 'completed'
          ? 'Image completed but its gallery entry is unavailable.'
          : 'Image job is no longer available. Check Recent images for a completed result.',
      );
    } catch (error) {
      // A status transport failure is not a terminal image failure. Keep the
      // session-only job id and retry while this component remains mounted.
      if (!componentMounted) return;
      generationJobId = jobId;
      generating = true;
      generationStatusMessage = 'Connection interrupted; checking image generation again…';
      scheduleGenerationStatusPoll(jobId);
    }
  }

  async function generate() {
    if (!prompt.trim() || generating || !activeProvider || !activeModel) return;
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    generationController = controller;
    generationJobId = jobId;
    generating = true;
    generationStatusMessage = 'Generating image…';
    saveRecoverableImageJob(jobId);
    let terminalFailure = false;
    try {
      const endpoint = sourceImage ? '/api/images/edit' : '/api/images/generate';
      const response = await apiFetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          jobId,
          prompt,
          provider: activeProvider.id,
          model: activeModel.id,
          effect: visualEffect,
          size,
          quality,
          background,
          outputFormat,
          ...(sourceImage ? { imageBase64: sourceImage.base64 } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        terminalFailure = true;
        throw new Error(result.error || 'Image generation failed');
      }
      generated = result.data;
      generatedHistoryId = result.data.historyId ?? '';
      generatedPrompt = prompt;
      finishTrackedGeneration(jobId);
      if (result.data.spendWarning) toastStore.warning(`Spend limit: ${result.data.spendWarning}`);
      toastStore.success(sourceImage ? 'Image edited' : 'Image generated');
      void loadHistory();
    } catch (error) {
      if (terminalFailure) {
        finishTrackedGeneration(jobId);
        toastStore.error(error instanceof Error ? error.message : 'Image generation failed');
      } else if (controller.signal.aborted) {
        // Component teardown aborts only this renderer's pending HTTP wait.
        // The backend-owned job remains durable and its session recovery id is
        // intentionally retained unless the user explicitly cancels it.
        if (componentMounted && explicitlyCancellingJobId !== jobId) {
          generationStatusMessage = 'Image generation continues in the background.';
          scheduleGenerationStatusPoll(jobId);
        }
      } else {
        generationStatusMessage = 'Connection interrupted; checking image generation again…';
        if (componentMounted) scheduleGenerationStatusPoll(jobId);
        toastStore.warning('Connection interrupted. Image generation may still complete.');
      }
    } finally {
      if (generationController === controller) {
        generationController = null;
        // Keep the job id/status if the HTTP wait was interrupted. The status
        // endpoint, not component teardown, decides whether recovery is done.
        if (loadRecoverableImageJob()?.jobId !== jobId && generationJobId === jobId) {
          generationJobId = null;
          generating = false;
          generationStatusMessage = '';
        }
      }
    }
  }

  async function cancelGeneration() {
    const controller = generationController;
    const jobId = generationJobId ?? loadRecoverableImageJob()?.jobId;
    if (!jobId) return;
    explicitlyCancellingJobId = jobId;
    controller?.abort(new DOMException('Image generation cancelled', 'AbortError'));
    try {
      const response = await apiFetch(apiUrl(`/api/images/jobs/${encodeURIComponent(jobId)}/cancel`), {
        method: 'POST',
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: { cancelled?: boolean };
      };
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not cancel image generation');
      if (result.data?.cancelled) {
        finishTrackedGeneration(jobId);
        toastStore.info('Image generation cancelled');
        return;
      }
      // It may have completed in the narrow interval before the cancel call.
      // Resolve against the authoritative status endpoint rather than guessing.
      generationJobId = jobId;
      generating = true;
      generationStatusMessage = 'Checking image generation status…';
      await pollGenerationStatus(jobId);
    } catch {
      // The backend may already have completed the job. Its durable gallery
      // entry is still the source of truth after a reload, so retain recovery
      // and retry status instead of pretending the cancel reached it.
      if (componentMounted) {
        generationJobId = jobId;
        generating = true;
        generationStatusMessage = 'Could not confirm cancellation; checking status again…';
        scheduleGenerationStatusPoll(jobId);
      }
    } finally {
      if (explicitlyCancellingJobId === jobId) explicitlyCancellingJobId = null;
    }
  }

  async function openHistoryEntry(entry: HistoryEntry) {
    await loadHistoryEntry(entry.id, entry.prompt);
  }

  async function removeHistoryEntry(id: string) {
    try {
      const response = await apiFetch(apiUrl(`/api/images/history/${id}`), { method: 'DELETE' });
      if (!response.ok) throw new Error('Delete failed');
      history = history.filter((item) => item.id !== id);
      if (generatedHistoryId === id) generatedHistoryId = '';
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not delete image');
    }
  }

  async function attachSourceImage(file: File) {
    if (!file.type.startsWith('image/')) {
      toastStore.error('Choose an image file to edit');
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the image file'));
      reader.readAsDataURL(file);
    });
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) throw new Error('Could not read the image file');
    sourceImage = { base64: match[2] ?? '', mimeType: match[1] ?? 'image/png', name: file.name };
  }

  async function copyPrompt() {
    if (!generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      toastStore.success('Prompt copied');
    } catch {
      toastStore.error('Could not copy the prompt');
    }
  }

  function downloadImage() {
    if (!generated) return;
    const extension = generated.mimeType.includes('jpeg')
      ? 'jpg'
      : (generated.mimeType.split('/')[1] ?? 'png');
    const anchor = document.createElement('a');
    anchor.href = imageUrl;
    anchor.download = `koryphaios-image-${Date.now()}.${extension}`;
    anchor.click();
  }

  onMount(() => {
    componentMounted = true;
    void loadProviders();
    void loadHistory();
    const recovered = loadRecoverableImageJob();
    if (recovered) {
      generationJobId = recovered.jobId;
      generating = true;
      generationStatusMessage = 'Resuming image generation status…';
      void pollGenerationStatus(recovered.jobId);
    }
    return () => {
      componentMounted = false;
      clearGenerationPollTimer();
      // Abort only this component's HTTP wait. The server-side job and its
      // session recovery record intentionally survive the view being closed.
      generationController?.abort(new DOMException('Image studio closed', 'AbortError'));
    };
  });
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
          Generate images with your connected providers, apply a visual treatment, and download the
          original result.
        </p>
      </div>
    </div>
    <button type="button" class="btn" onclick={() => void loadProviders()} disabled={loading}>
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} /> Refresh
    </button>
  </header>

  <section
    class="overflow-visible rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
  >
    <div class="grid gap-0 overflow-visible lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
      <div class="space-y-5 p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h4 class="font-medium text-[var(--color-text-primary)]">Image studio</h4>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              {#if activeProvider && activeModel}
                {activeProvider.label} · {activeModel.label}
              {:else}
                No image providers available
              {/if}
            </p>
          </div>
          {#if activeProvider}
            <span
              class="rounded-full px-2.5 py-1 text-[10px] font-medium {activeProvider.configured
                ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]'}"
            >
              {activeProvider.configured ? 'Ready' : `Connect ${activeProvider.label}`}
            </span>
          {/if}
        </div>

        {#if !loading && configuredProviders.length === 0}
          <p
            class="rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning-bg)] px-4 py-3 text-xs leading-relaxed text-[var(--color-warning)]"
          >
            No image providers available. Connect OpenAI, Google, xAI, or OpenRouter, point Local,
            LM Studio, or llama.cpp at an OpenAI-compatible image server, or add a custom provider
            under Providers &amp; models.
          </p>
        {/if}

        <div class="grid gap-3 sm:grid-cols-2">
          <KorySelect
            value={selectedProvider}
            options={providers.map((provider) => ({
              value: provider.id,
              label: provider.configured ? provider.label : `${provider.label} (not connected)`,
              disabled: !provider.configured,
            }))}
            label="Provider"
            placeholder="No providers available"
            disabled={loading || providers.length === 0}
            onchange={selectProvider}
          />
          <KorySelect
            value={activeModel?.id ?? ''}
            options={(activeProvider?.models ?? []).map((model) => ({
              value: model.id,
              label: model.label,
            }))}
            label="Model"
            placeholder={activeProvider ? 'Select model' : 'No provider selected'}
            allowCustom
            customLabel="Custom model"
            customPlaceholder="Provider model ID"
            disabled={!activeProvider}
            onchange={(value) => (selectedModel = value)}
          />
        </div>

        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          class="hidden"
          onchange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void attachSourceImage(file);
            event.currentTarget.value = '';
          }}
        />
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn"
            disabled={!activeModel?.edits}
            title={activeModel?.edits
              ? 'Edit a source image with this model'
              : 'Pick a model that supports editing (GPT Image, Gemini 2.5 Flash Image)'}
            onclick={() => fileInput?.click()}
          >
            <ImagePlus size={14} />
            {sourceImage ? 'Replace source image' : 'Edit an image'}
          </button>
          {#if sourceImage}
            <span
              class="flex max-w-64 items-center gap-2 rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 px-3 py-1.5 text-xs text-[var(--color-text-primary)]"
            >
              <span class="truncate">{sourceImage.name}</span>
              <button
                type="button"
                aria-label="Remove source image"
                class="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                onclick={() => (sourceImage = null)}
              >
                <X size={13} />
              </button>
            </span>
          {/if}
        </div>

        <label class="block space-y-2">
          <span class="text-xs font-medium text-[var(--color-text-secondary)]">Prompt</span>
          <textarea
            bind:value={prompt}
            rows="5"
            maxlength="32000"
            placeholder="Describe the subject, composition, lighting, colors, and mood…"
            class="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
          ></textarea>
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <KorySelect
            value={visualEffect}
            options={effects}
            label="Visual effect"
            onchange={(value) => (visualEffect = value)}
          />
          <KorySelect
            value={size}
            options={sizeOptions}
            label="Canvas size"
            onchange={(value) => (size = value)}
          />
          <KorySelect
            value={quality}
            options={qualityOptions}
            label="Quality"
            onchange={(value) => (quality = value)}
          />
          <KorySelect
            value={outputFormat}
            options={formatOptions}
            label="File format"
            onchange={(value) => (outputFormat = value)}
          />
        </div>

        {#if backgroundOptions.length > 0}
          <div class="flex flex-wrap gap-2" role="group" aria-label="Image background">
            {#each backgroundOptions as option (option)}
              <button
                type="button"
                aria-pressed={background === option}
                class="rounded-full border px-3 py-1.5 text-xs capitalize transition-colors {background ===
                option
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]'}"
                onclick={() => (background = option)}>{option}</button
              >
            {/each}
          </div>
        {/if}

        <button
          type="button"
          class="btn btn-primary w-full justify-center py-3"
          disabled={!generating && (!ready || !prompt.trim())}
          onclick={() => {
            if (generating) void cancelGeneration();
            else void generate();
          }}
        >
          {#if generating}<X size={16} /> Cancel generation{:else}<WandSparkles size={16} />
            {sourceImage ? 'Apply edit' : 'Generate image'}{/if}
        </button>
        {#if generating && generationStatusMessage}
          <p role="status" class="text-center text-xs text-[var(--color-text-muted)]">
            {generationStatusMessage}
          </p>
        {/if}
      </div>

      <div
        class="relative flex min-h-96 items-center justify-center overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 lg:border-l lg:border-t-0"
      >
        <div class="pointer-events-none absolute inset-0 opacity-40 image-atmosphere"></div>
        {#if generated}
          <div class="relative w-full space-y-3 image-result">
            <img
              src={imageUrl}
              alt={generated.revisedPrompt || prompt}
              class="mx-auto max-h-[34rem] w-full rounded-xl object-contain shadow-2xl"
            />
            <div class="flex items-center justify-between gap-3">
              <p class="min-w-0 truncate text-[10px] text-[var(--color-text-muted)]">
                {generated.provider} · {generated.model}
              </p>
              <div class="flex shrink-0 gap-2">
                {#if generatedPrompt}
                  <button type="button" class="btn" onclick={() => void copyPrompt()}>
                    <Copy size={14} /> Copy prompt
                  </button>
                {/if}
                <button type="button" class="btn" onclick={downloadImage}
                  ><Download size={14} /> Download</button
                >
              </div>
            </div>
          </div>
        {:else}
          <div class="relative max-w-xs text-center text-[var(--color-text-muted)]">
            <div
              class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-accent)]"
            >
              <Sparkles size={28} />
            </div>
            <p class="text-sm font-medium text-[var(--color-text-secondary)]">
              Your generated image appears here
            </p>
            <p class="mt-2 text-xs leading-relaxed">
              Choose an effect and format, then generate an original image.
            </p>
          </div>
        {/if}
      </div>
    </div>
  </section>

  {#if history.length > 0}
    <section
      class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
    >
      <div class="flex items-center justify-between gap-3">
        <h4 class="font-medium text-[var(--color-text-primary)]">Recent images</h4>
        <button type="button" class="btn" onclick={() => void loadHistory()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each history as entry (entry.id)}
          <button
            type="button"
            class="group rounded-xl border p-3 text-left transition-colors {generatedHistoryId ===
            entry.id
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/8'
              : 'border-[var(--color-border)] hover:bg-[var(--color-surface-3)]'}"
            onclick={() => void openHistoryEntry(entry)}
          >
            <div class="flex items-start justify-between gap-2">
              <p class="line-clamp-2 min-w-0 text-xs font-medium text-[var(--color-text-primary)]">
                {entry.prompt}
              </p>
              <span
                role="button"
                tabindex="0"
                aria-label="Delete image from history"
                class="shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--color-danger, #e5484d)] focus:opacity-100"
                onclick={(event) => {
                  event.stopPropagation();
                  void removeHistoryEntry(entry.id);
                }}
                onkeydown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    void removeHistoryEntry(entry.id);
                  }
                }}
              >
                <Trash2 size={13} />
              </span>
            </div>
            <p class="mt-2 truncate text-[10px] text-[var(--color-text-muted)]">
              {entry.mode === 'edit' ? 'Edit · ' : ''}{entry.provider} · {entry.model} · {new Date(
                entry.ts,
              ).toLocaleTimeString()}
            </p>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <section
    class="flex items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
  >
    <Eye size={18} class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
    <div>
      <h4 class="font-medium text-[var(--color-text-primary)]">Image input is enabled</h4>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        Paste or attach images in chat, and agents can inspect workspace images with the scoped
        image viewer.
      </p>
    </div>
  </section>
</div>

<style>
  .image-atmosphere {
    background:
      radial-gradient(
        circle at 20% 20%,
        color-mix(in srgb, var(--color-accent) 35%, transparent),
        transparent 40%
      ),
      radial-gradient(
        circle at 80% 75%,
        color-mix(in srgb, var(--color-info) 25%, transparent),
        transparent 42%
      );
  }
  .image-result {
    animation: reveal-image 420ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes reveal-image {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
      filter: blur(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
      filter: blur(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .image-result {
      animation: none;
    }
  }
</style>
