<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import {
    MessageSquare,
    ArrowRight,
    CornerDownRight,
    MessagesSquare,
    SlidersHorizontal,
  } from 'lucide-svelte';
  import { renderKoryChart } from '$lib/utils/chart-renderer';
  import KorySlider from './KorySlider.svelte';

  let otherValue = $state('');
  let showOther = $state(false);
  let dialogEl = $state<HTMLElement | null>(null);
  let sliderValues = $state<Record<string, number>>({});

  let pendingQuestion = $derived(wsStore.pendingQuestion);
  let suggestedOptions = $derived(
    pendingQuestion?.options.filter(
      (option) => !/^(other|custom|something else)\b/i.test(option.trim()),
    ) ?? [],
  );
  let chartHtml = $derived(
    pendingQuestion?.chart ? renderKoryChart(JSON.stringify(pendingQuestion.chart)) : null,
  );

  $effect(() => {
    void showOther;
    if (pendingQuestion && dialogEl) {
      const focusable = dialogEl.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      (dialogEl.querySelector<HTMLElement>('[data-autofocus]') ?? first)?.focus();

      function trapFocus(e: KeyboardEvent) {
        if (e.key !== 'Tab') return;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }

      dialogEl.addEventListener('keydown', trapFocus);
      return () => dialogEl?.removeEventListener('keydown', trapFocus);
    }
  });

  function submit(val: string) {
    if (!sessionStore.activeSessionId) return;
    wsStore.sendUserInput(sessionStore.activeSessionId, val);
    otherValue = '';
    showOther = false;
  }

  function keepChatting() {
    submit(
      'Keep chatting — I am not choosing an option yet. Continue the discussion or ask a narrower follow-up.',
    );
  }

  function submitSliders() {
    const values =
      pendingQuestion?.sliders?.map(
        (slider) =>
          `${slider.label}: ${sliderValues[slider.id] ?? slider.value}${slider.unit ?? ''}`,
      ) ?? [];
    if (values.length > 0) submit(`Use these values:\n${values.join('\n')}`);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && otherValue.trim()) {
      e.preventDefault();
      submit(otherValue);
    }
  }

  $effect(() => {
    if (!pendingQuestion) {
      showOther = false;
      otherValue = '';
      return;
    }
    showOther = false;
    sliderValues = Object.fromEntries(
      (pendingQuestion.sliders ?? []).map((slider) => [slider.id, slider.value]),
    );
  });
</script>

{#if pendingQuestion}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
  >
    <div
      class="flex max-h-[min(820px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl animate-in fade-in zoom-in duration-200"
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="question-dialog-title"
    >
      <div
        class="px-6 py-5 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-3"
      >
        <div
          class="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-500"
        >
          <MessageSquare size={18} />
        </div>
        <div>
          <h3
            id="question-dialog-title"
            class="text-sm font-semibold text-[var(--color-text-primary)]"
          >
            Kory needs guidance
          </h3>
          <p class="text-[10px] text-[var(--color-text-muted)]">
            Choose, tune the values, or keep talking
          </p>
        </div>
      </div>

      <div class="overflow-y-auto p-6">
        <p class="text-sm text-[var(--color-text-secondary)] mb-6 leading-relaxed">
          {pendingQuestion.question}
        </p>

        {#if chartHtml}
          <div class="question-chart mb-5">
            {@html chartHtml}
            <details
              class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
            >
              <summary
                class="cursor-pointer text-[11px] font-medium text-[var(--color-text-secondary)]"
                >View chart data</summary
              >
              <div class="mt-2 overflow-x-auto">
                <table class="w-full border-collapse text-left text-[11px]">
                  <caption class="sr-only"
                    >{pendingQuestion.chart?.title ?? 'Question chart data'}</caption
                  >
                  <thead>
                    <tr>
                      <th
                        class="border-b border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-muted)]"
                        >Label</th
                      >
                      {#each pendingQuestion.chart?.datasets ?? [] as dataset, index}
                        <th
                          class="border-b border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-muted)]"
                          >{dataset.label ?? `Series ${index + 1}`}</th
                        >
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each pendingQuestion.chart?.labels ?? [] as label, labelIndex}
                      <tr>
                        <th
                          class="border-b border-[var(--color-border)] px-2 py-1.5 font-medium text-[var(--color-text-secondary)]"
                          >{label}</th
                        >
                        {#each pendingQuestion.chart?.datasets ?? [] as dataset}
                          <td
                            class="border-b border-[var(--color-border)] px-2 py-1.5 font-mono text-[var(--color-text-secondary)]"
                            >{dataset.data[labelIndex]}</td
                          >
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        {/if}

        {#if pendingQuestion.sliders?.length}
          <section
            class="mb-5 space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
            aria-label="Adjust values"
          >
            <div
              class="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-primary)]"
            >
              <SlidersHorizontal size={14} />
              Adjust values
            </div>
            {#each pendingQuestion.sliders as slider (slider.id)}
              <KorySlider
                id={`question-slider-${slider.id}`}
                label={slider.label}
                bind:value={sliderValues[slider.id]}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                unit={slider.unit}
                description={slider.description}
              />
            {/each}
            <button
              class="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
              onclick={submitSliders}
            >
              Use these values
            </button>
          </section>
        {/if}

        {#if !showOther}
          <div class="space-y-2">
            {#each suggestedOptions as option (option)}
              <button
                class="w-full flex items-center justify-between px-4 py-3 text-left text-sm rounded-xl transition-all border border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] hover:border-amber-500/50 group"
                onclick={() => submit(option)}
              >
                <span
                  class="text-[var(--color-text-primary)] group-hover:text-amber-400 transition-colors"
                  >{option}</span
                >
                <ArrowRight
                  size={14}
                  class="text-[var(--color-text-muted)] group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all"
                />
              </button>
            {/each}
            <div class="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
              <button
                class="flex items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-3)]"
                onclick={() => (showOther = true)}
              >
                <CornerDownRight size={15} />
                Custom response
              </button>
              <button
                class="flex items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-3)]"
                onclick={keepChatting}
              >
                <MessagesSquare size={15} />
                Keep chatting
              </button>
            </div>
          </div>
        {:else}
          <div class="space-y-4">
            <div class="relative">
              <div class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
                <CornerDownRight size={16} />
              </div>
              <textarea
                data-autofocus
                bind:value={otherValue}
                onkeydown={handleKeydown}
                placeholder="Add your own answer or notes..."
                rows="3"
                class="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] py-3 pl-10 pr-4 text-sm transition-colors focus:border-amber-500 focus:outline-none"
              ></textarea>
            </div>
            <p class="text-[10px] text-[var(--color-text-muted)]">
              Tab moves to the actions. Shift+Enter adds a new line; Enter submits.
            </p>
            <div class="flex gap-2">
              <button
                class="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onclick={() => submit(otherValue)}
                disabled={!otherValue.trim()}
              >
                Confirm
              </button>
              <button
                class="px-4 py-2.5 text-sm font-medium rounded-xl bg-[var(--color-surface-3)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-4)] transition-colors"
                onclick={() => (showOther = false)}
              >
                Back
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  :global(.question-chart .kory-chart) {
    margin: 0;
    padding: 14px;
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: linear-gradient(145deg, var(--color-surface-2), var(--color-surface-1));
  }
  :global(.question-chart .kory-chart figcaption) {
    margin-bottom: 8px;
    color: var(--color-text-primary);
    font-size: 12px;
    font-weight: 700;
  }
  :global(.question-chart .kory-chart svg) {
    display: block;
    width: 100%;
    min-width: 460px;
    max-height: 300px;
  }
  :global(.question-chart .chart-grid) {
    stroke: var(--color-border);
    opacity: 0.6;
  }
  :global(.question-chart .chart-axis) {
    stroke: var(--color-text-muted);
  }
  :global(.question-chart .chart-axis-label) {
    fill: var(--color-text-muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }
  :global(.question-chart .chart-donut-hole) {
    fill: var(--color-surface-2);
  }
  :global(.question-chart .kory-chart-legend) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 8px;
    color: var(--color-text-secondary);
    font-size: 11px;
  }
  :global(.question-chart .kory-chart-legend span) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  :global(.question-chart .kory-chart-legend i) {
    width: 9px;
    height: 9px;
    border-radius: 3px;
  }
  :global(.question-chart .kory-chart-pie) {
    display: grid;
    grid-template-columns: minmax(280px, 1fr) minmax(140px, auto);
    align-items: center;
  }
  :global(.question-chart .kory-chart-pie-legend) {
    flex-direction: column;
    margin: 0;
  }
</style>
