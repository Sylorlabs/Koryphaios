<script lang="ts">
  import { onMount } from 'svelte';
  import Download from 'lucide-svelte/icons/download';
  import Film from 'lucide-svelte/icons/film';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import { apiFetch } from '$lib/api.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import KorySelect from './KorySelect.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';

  // Video generation is asynchronous upstream: Luma, Kling, and Replicate all
  // submit a task and finish it out of band. A generation can run for minutes, so
  // the backend owns the job, survives this view being closed, and is polled
  // here for status only.

  type VideoModelInfo = {
    id: string;
    label: string;
    durations?: string[];
    aspectRatios?: string[];
  };
  type VideoProviderCapabilities = {
    audio: boolean;
    resolution: boolean;
    negativePrompt: boolean;
    durationSeconds: boolean;
  };
  type VideoProviderInfo = {
    provider: string;
    label: string;
    configured: boolean;
    /** Which generation options this provider's request path actually forwards. */
    capabilities?: VideoProviderCapabilities;
    models: VideoModelInfo[];
  };
  type GeneratedVideo = {
    videoBase64: string;
    mimeType: string;
    provider: string;
    model: string;
    prompt: string;
    duration?: string;
    aspectRatio?: string;
  };
  type HistoryEntry = {
    id: string;
    ts: number;
    provider: string;
    model: string;
    mimeType: string;
    prompt: string;
    duration?: string;
    aspectRatio?: string;
  };
  type VideoJobStatus = 'running' | 'completed' | 'unknown';

  const POLL_INTERVAL_MS = 3_000;
  const FALLBACK_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];

  let providers = $state<VideoProviderInfo[]>([]);
  let unconnected = $state<string[]>([]);
  let selectedProvider = $state('');
  let selectedModel = $state('');
  let loading = $state(true);
  let generating = $state(false);
  let statusMessage = $state('');
  let componentMounted = false;

  let prompt = $state('');
  let duration = $state('5');
  let aspectRatio = $state('16:9');
  let resolution = $state('');
  let negativePrompt = $state('');
  let sound = $state(false);

  let generated = $state<GeneratedVideo | null>(null);
  let generatedHistoryId = $state('');
  let history = $state<HistoryEntry[]>([]);

  let generationController = $state<AbortController | null>(null);
  let generationJobId = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  let videoUrl = $derived(
    generated ? `data:${generated.mimeType};base64,${generated.videoBase64}` : '',
  );
  /**
   * Generated clips carry no transcript: the provider returns video bytes and,
   * when synchronized audio is requested, an audio track with no script. Rather
   * than leave assistive technology with nothing to read, every clip gets one
   * caption that states this plainly instead of inventing dialogue.
   */
  let captionTrackUrl = $derived.by(() => {
    const caption = 'Generated video clip. This clip has no caption track.';
    const vtt = `WEBVTT\n\n00:00.000 --> 00:03.000\n${caption}\n`;
    return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
  });
  let activeProvider = $derived(
    providers.find((provider) => provider.provider === selectedProvider),
  );
  // The picker renders only the controls the selected provider's request path
  // forwards, as declared by the provider itself — never a provider-name list.
  let supportsResolution = $derived(activeProvider?.capabilities?.resolution ?? false);
  let supportsSound = $derived(activeProvider?.capabilities?.audio ?? false);
  let supportsNegativePrompt = $derived(activeProvider?.capabilities?.negativePrompt ?? false);
  let activeModel = $derived(activeProvider?.models.find((model) => model.id === selectedModel));
  let durationSeconds = $derived(Number(duration.trim()));
  let validDuration = $derived(
    /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(duration.trim()) &&
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0,
  );
  let requestDuration = $derived(
    activeProvider?.capabilities?.durationSeconds ? String(durationSeconds) : `${durationSeconds}s`,
  );
  let aspectRatios = $derived(
    activeModel?.aspectRatios?.length ? activeModel.aspectRatios : FALLBACK_ASPECT_RATIOS,
  );
  let canGenerate = $derived(
    Boolean(selectedProvider && selectedModel && prompt.trim()) &&
      validDuration &&
      !generating &&
      Boolean(activeProvider?.configured),
  );
  let historyThumbs = $derived(history.slice(0, 12));

  $effect(() => {
    if (!aspectRatios.includes(aspectRatio)) aspectRatio = aspectRatios[0] ?? '16:9';
  });

  async function loadProviders() {
    loading = true;
    try {
      const response = await apiFetch(apiUrl('/api/video/providers'));
      const result = await response.json();
      providers = response.ok && Array.isArray(result.data) ? result.data : [];
      unconnected = response.ok && Array.isArray(result.unconnected) ? result.unconnected : [];
      const configured = providers.filter((provider) => provider.configured);
      if (!configured.some((provider) => provider.provider === selectedProvider)) {
        selectedProvider = configured[0]?.provider ?? '';
      }
      const next = configured.find((provider) => provider.provider === selectedProvider);
      if (!next?.models.some((model) => model.id === selectedModel)) {
        selectedModel = next?.models[0]?.id ?? '';
      }
    } catch {
      providers = [];
    } finally {
      loading = false;
    }
  }

  function selectProvider(id: string) {
    selectedProvider = id;
    const provider = providers.find((candidate) => candidate.provider === id);
    if (!provider?.models.some((model) => model.id === selectedModel)) {
      selectedModel = provider?.models[0]?.id ?? '';
    }
  }

  async function loadHistory() {
    try {
      const response = await apiFetch(apiUrl('/api/video/history?limit=12'));
      const result = await response.json();
      history = response.ok && Array.isArray(result.data) ? result.data : [];
    } catch {
      history = [];
    }
  }

  function clearPollTimer() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function loadHistoryEntry(id: string): Promise<boolean> {
    try {
      const response = await apiFetch(apiUrl(`/api/video/history/${encodeURIComponent(id)}`));
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Video not found');
      generated = {
        videoBase64: result.data.videoBase64,
        mimeType: result.data.mimeType,
        provider: result.data.provider,
        model: result.data.model,
        prompt: result.data.prompt,
        duration: result.data.duration,
        aspectRatio: result.data.aspectRatio,
      };
      generatedHistoryId = id;
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not load video');
      return false;
    }
  }

  async function pollGenerationStatus(jobId: string): Promise<void> {
    if (!componentMounted || generationJobId !== jobId) return;
    try {
      const response = await apiFetch(apiUrl(`/api/video/jobs/${encodeURIComponent(jobId)}`));
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: { status?: VideoJobStatus; historyId?: string };
      };
      if (!response.ok || !result.ok || !result.data?.status) {
        throw new Error(result.error || 'Could not check video generation status');
      }
      if (result.data.status === 'running') {
        statusMessage = 'The provider is still rendering this clip…';
        schedulePoll(jobId);
        return;
      }
      if (result.data.status === 'completed' && result.data.historyId) {
        const restored = await loadHistoryEntry(result.data.historyId);
        if (!restored && componentMounted) {
          schedulePoll(jobId);
          return;
        }
        if (componentMounted) {
          finishJob(jobId);
          statusMessage = '';
        }
        return;
      }
      // The backend restarted and lost the in-process job; the provider may
      // still be rendering, so say so rather than reporting failure.
      finishJob(jobId);
      statusMessage =
        'The backend restarted while this clip was rendering. Check the provider dashboard.';
    } catch (error) {
      finishJob(jobId);
      toastStore.error(
        error instanceof Error ? error.message : 'Could not check video generation status',
      );
    }
  }

  function schedulePoll(jobId: string) {
    clearPollTimer();
    if (!componentMounted) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollGenerationStatus(jobId);
    }, POLL_INTERVAL_MS);
  }

  function finishJob(jobId: string) {
    clearPollTimer();
    if (generationJobId === jobId) {
      generationJobId = null;
      generating = false;
    }
    void loadHistory();
  }

  async function generate() {
    if (!canGenerate || !activeProvider) return;
    const jobId = crypto.randomUUID();
    generationJobId = jobId;
    generating = true;
    generated = null;
    generatedHistoryId = '';
    statusMessage = 'Submitting to the provider…';
    generationController = new AbortController();
    try {
      const response = await apiFetch(apiUrl('/api/video/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          prompt: prompt.trim(),
          provider: selectedProvider,
          model: selectedModel,
          duration: requestDuration,
          aspectRatio,
          ...(supportsResolution && resolution ? { resolution } : {}),
          ...(selectedProvider !== 'luma' && negativePrompt.trim()
            ? { negativePrompt: negativePrompt.trim() }
            : {}),
          ...(supportsSound && sound ? { sound: true } : {}),
        }),
        signal: generationController.signal,
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: {
          videoBase64: string;
          mimeType: string;
          provider: string;
          model: string;
          historyId?: string;
        };
      };
      if (!response.ok || !result.ok || !result.data) {
        throw new Error(result.error || 'Video generation failed');
      }
      generated = {
        videoBase64: result.data.videoBase64,
        mimeType: result.data.mimeType,
        provider: result.data.provider,
        model: result.data.model,
        prompt: prompt.trim(),
        duration: requestDuration,
        aspectRatio,
      };
      generatedHistoryId = result.data.historyId ?? '';
      finishJob(jobId);
      statusMessage = '';
      void loadHistory();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        finishJob(jobId);
        statusMessage = 'Cancelled. The provider may still finish the job upstream.';
        return;
      }
      finishJob(jobId);
      statusMessage = '';
      toastStore.error(
        error instanceof Error ? error.message : 'Video generation failed. This may take minutes.',
      );
    }
  }

  async function cancelGeneration() {
    const jobId = generationJobId;
    if (!jobId) return;
    generationController?.abort(new DOMException('Cancelled', 'AbortError'));
    try {
      await apiFetch(apiUrl(`/api/video/jobs/${encodeURIComponent(jobId)}/cancel`), {
        method: 'POST',
      });
    } catch {
      // Cancelling locally is enough; the backend stops the upstream poll too.
    }
    finishJob(jobId);
    statusMessage = 'Cancelled. The provider may still finish the job upstream.';
  }

  async function deleteHistoryEntry(id: string) {
    try {
      const response = await apiFetch(apiUrl(`/api/video/history/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Could not delete the video');
      history = history.filter((entry) => entry.id !== id);
      if (generatedHistoryId === id) {
        generated = null;
        generatedHistoryId = '';
      }
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not delete the video');
    }
  }

  function downloadVideo() {
    if (!generated) return;
    const extension = generated.mimeType.includes('webm')
      ? 'webm'
      : generated.mimeType.includes('quicktime')
        ? 'mov'
        : 'mp4';
    const anchor = document.createElement('a');
    anchor.href = videoUrl;
    anchor.download = `koryphaios-video-${Date.now()}.${extension}`;
    anchor.click();
  }

  onMount(() => {
    componentMounted = true;
    void loadProviders();
    void loadHistory();
    return () => {
      componentMounted = false;
      clearPollTimer();
      // Abort only this view's HTTP wait. The server-side job and the provider's
      // own render intentionally survive the studio being closed.
      generationController?.abort(new DOMException('Video studio closed', 'AbortError'));
    };
  });
</script>

<div class="mx-auto w-full max-w-5xl space-y-6 p-6">
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex items-start gap-3">
      <div class="rounded-xl bg-[var(--color-surface-3)] p-2 text-[var(--color-accent)]">
        <Film size={20} />
      </div>
      <div>
        <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Video</h3>
        <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
          Generate short clips with Luma, Kling AI, Prodia, or Replicate. Generation runs on the
          provider and is billed per clip, so it usually takes 30 seconds to several minutes.
        </p>
      </div>
    </div>
    <button type="button" class="btn" onclick={() => void loadProviders()} disabled={loading}>
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} /> Refresh
    </button>
  </header>

  <section
    class="settings-panel overflow-visible rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
  >
    <div class="grid gap-0 overflow-visible lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
      <div class="space-y-5 p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h4 class="font-medium text-[var(--color-text-primary)]">Video studio</h4>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              {#if activeProvider}
                {activeProvider.label}{selectedModel ? ` · ${selectedModel}` : ''}
              {:else}
                No video providers available
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

        {#if !loading && providers.filter((provider) => provider.configured).length === 0}
          <p
            class="rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning-bg)] px-4 py-3 text-xs leading-relaxed text-[var(--color-warning)]"
          >
            No video providers are connected yet. Luma, Kling AI, Prodia, and Replicate all generate
            video but none of them answers chat requests, so they never appear in the chat provider
            picker.
            {#if unconnected.length > 0}
              Available to connect: {unconnected.join(', ')}.
            {/if}
            Add a key in Providers &amp; models.
          </p>
        {/if}

        <div class="space-y-3">
          <label class="block">
            <span class="text-xs font-medium text-[var(--color-text-secondary)]">Prompt</span>
            <textarea
              class="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              rows="4"
              placeholder="Describe the shot: subject, action, camera movement, mood."
              bind:value={prompt}
              disabled={generating}
            ></textarea>
          </label>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="text-xs font-medium text-[var(--color-text-secondary)]">Provider</span>
              <div class="mt-1.5">
                <KorySelect
                  value={selectedProvider}
                  onchange={(value: string) => selectProvider(value)}
                  disabled={generating}
                  options={providers.map((provider) => ({
                    value: provider.provider,
                    label: provider.configured
                      ? provider.label
                      : `${provider.label} (not connected)`,
                  }))}
                  placeholder={loading ? 'Loading providers…' : 'Select a provider'}
                />
              </div>
            </label>

            <label class="block">
              <span class="text-xs font-medium text-[var(--color-text-secondary)]">Model</span>
              <div class="mt-1.5">
                <KorySelect
                  value={selectedModel}
                  onchange={(value: string) => (selectedModel = value)}
                  disabled={generating}
                  options={(activeProvider?.models ?? []).map((model) => ({
                    value: model.id,
                    label: model.label,
                  }))}
                  placeholder="Select a model"
                  searchable
                  allowCustom
                  customLabel="Use another model"
                  customPlaceholder={activeProvider?.provider === 'replicate'
                    ? 'owner/name'
                    : 'model id'}
                />
              </div>
            </label>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="text-xs font-medium text-[var(--color-text-secondary)]">
                Duration (seconds)
              </span>
              <div class="relative mt-1.5">
                <input
                  type="text"
                  inputmode="decimal"
                  bind:value={duration}
                  disabled={generating}
                  aria-invalid={!validDuration}
                  class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 pr-9 text-sm tabular-nums text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
                <span
                  class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)]"
                  aria-hidden="true">s</span
                >
              </div>
            </label>

            <label class="block">
              <span class="text-xs font-medium text-[var(--color-text-secondary)]">
                Aspect ratio
              </span>
              <div class="mt-1.5">
                <KorySelect
                  value={aspectRatio}
                  onchange={(value: string) => (aspectRatio = value)}
                  disabled={generating}
                  options={aspectRatios.map((value) => ({ value, label: value }))}
                />
              </div>
            </label>
          </div>

          <label class="block">
            <span class="text-xs font-medium text-[var(--color-text-secondary)]">
              Avoid (optional)
            </span>
            <input
              type="text"
              class="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              placeholder="What should not appear in the clip"
              bind:value={negativePrompt}
              disabled={generating || !supportsNegativePrompt}
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-[var(--color-text-secondary)]"
              >Resolution (model dependent)</span
            >
            <div class="mt-1.5">
              <KorySelect
                value={resolution}
                onchange={(value: string) => (resolution = value)}
                disabled={generating || !supportsResolution}
                options={[
                  { value: '', label: 'Provider default' },
                  { value: '540p', label: '540p' },
                  { value: '720p', label: '720p' },
                  { value: '1080p', label: '1080p' },
                ]}
                allowCustom
                customLabel="Use another resolution"
              />
            </div>
          </label>

          <div class="border-y border-[var(--color-border)]">
            <SettingsSwitch
              checked={sound}
              label="Synchronized audio"
              description="Models that support audio generate a soundtrack with the clip"
              onchange={() => {
                sound = !sound;
              }}
              flat
              disabled={generating || !supportsSound}
            />
          </div>

          <div class="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              class="btn"
              onclick={() => void generate()}
              disabled={!canGenerate}
            >
              {#if generating}
                Generating…
              {:else}
                Generate video
              {/if}
            </button>
            {#if generating}
              <button type="button" class="btn-ghost" onclick={() => void cancelGeneration()}>
                Cancel
              </button>
            {/if}
            {#if statusMessage}
              <span class="text-xs text-[var(--color-text-muted)]">{statusMessage}</span>
            {/if}
          </div>
        </div>
      </div>

      <div class="space-y-4 border-t border-[var(--color-border)] p-5 lg:border-l lg:border-t-0">
        <h4 class="font-medium text-[var(--color-text-primary)]">Result</h4>
        {#if generated}
          <video
            class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)]"
            src={videoUrl}
            controls
            playsinline
          >
            <track kind="captions" srclang="en" label="No captions" src={captionTrackUrl} default />
          </video>
          <dl class="space-y-1 text-xs text-[var(--color-text-muted)]">
            <div class="flex gap-2">
              <dt class="font-medium text-[var(--color-text-secondary)]">Provider</dt>
              <dd>{generated.provider} · {generated.model}</dd>
            </div>
            {#if generated.duration}
              <div class="flex gap-2">
                <dt class="font-medium text-[var(--color-text-secondary)]">Duration</dt>
                <dd>{generated.duration}</dd>
              </div>
            {/if}
            {#if generated.aspectRatio}
              <div class="flex gap-2">
                <dt class="font-medium text-[var(--color-text-secondary)]">Aspect ratio</dt>
                <dd>{generated.aspectRatio}</dd>
              </div>
            {/if}
          </dl>
          <button type="button" class="btn" onclick={downloadVideo}>
            <Download size={14} /> Download
          </button>
        {:else}
          <p
            class="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-xs text-[var(--color-text-muted)]"
          >
            {generating ? 'Rendering on the provider…' : 'Generated clips appear here.'}
          </p>
        {/if}

        {#if historyThumbs.length > 0}
          <div>
            <h5 class="text-xs font-medium text-[var(--color-text-secondary)]">Recent clips</h5>
            <ul class="mt-2 space-y-2">
              {#each historyThumbs as entry (entry.id)}
                <li class="flex items-center gap-2">
                  <button
                    type="button"
                    class="min-w-0 flex-1 truncate rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-left text-xs text-[var(--color-text-primary)] hover:border-[var(--color-accent)]"
                    onclick={() => void loadHistoryEntry(entry.id)}
                    title={entry.prompt}
                  >
                    {entry.provider} · {entry.model}
                  </button>
                  <button
                    type="button"
                    class="btn-ghost px-2"
                    aria-label="Delete clip"
                    onclick={() => void deleteHistoryEntry(entry.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    </div>
  </section>
</div>
