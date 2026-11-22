<script lang="ts">
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Check from 'lucide-svelte/icons/check';
  import Info from 'lucide-svelte/icons/info';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Shield from 'lucide-svelte/icons/shield';
  import ProviderIcon from '../icons/ProviderIcon.svelte';
  import { SETTINGS_CATALOG } from '$lib/utils/settings-catalog';
  import { deviceStore } from '$lib/stores/devices.svelte';
  import {
    buildUsageChartGeometry,
    deriveUsageWindowView,
    formatBucketDetailLabel,
    type UsageBreakdownTab,
    type UsageViewMode,
    type UsageWindowKey,
  } from '$lib/utils/usage-analytics';

  interface Props {
    billingCredits: any;
    billingLoading?: boolean;
    showSubscriptionApiEquivalent?: boolean;
    selectedEnvironment?: string;
    viewMode?: UsageViewMode;
    getProviderDisplayLabel: (provider: string) => string;
    onRefresh: () => void;
    onOpenSafetyLimits?: () => void;
  }

  let {
    billingCredits,
    billingLoading = false,
    showSubscriptionApiEquivalent = true,
    selectedEnvironment = $bindable('all'),
    viewMode = $bindable<UsageViewMode>('cost'),
    getProviderDisplayLabel,
    onRefresh,
    onOpenSafetyLimits,
  }: Props = $props();

  const billingEntry = SETTINGS_CATALOG.find((entry) => entry.id === 'billing');
  const pageTitle = billingEntry?.label ?? 'Usage & billing';
  const pageDescription = billingEntry?.description ?? '';
  const uid = $props.id();
  const headingId = `usage-billing-${uid}`;

  let timeWindow = $state<UsageWindowKey>('24h');
  let breakdownTab = $state<UsageBreakdownTab>('model');
  let providerFilter = $state<string>('all');
  let openHeaderDropdown = $state<'environment' | 'provider' | null>(null);
  let hoveredBucketIndex = $state<number | null>(null);

  const WINDOW_OPTIONS: Array<{ id: UsageWindowKey; label: string }> = [
    { id: '24h', label: 'Past 24h' },
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
    { id: '90d', label: '90 days' },
  ];

  const VIEW_MODES: Array<{ id: UsageViewMode; label: string }> = [
    { id: 'cost', label: 'Cost' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'limits', label: 'Limits' },
  ];

  const environmentOptions = $derived.by(() => {
    const localName =
      deviceStore.status?.local?.name ||
      deviceStore.status?.osName ||
      'This computer';
    const peers = (deviceStore.status?.peers ?? []).map((peer) => ({
      id: peer.id,
      label: peer.name || peer.id,
    }));
    return [
      { id: 'all', label: 'All environments' },
      { id: 'local', label: localName },
      ...peers,
    ];
  });

  const activeEnvironmentLabel = $derived(
    environmentOptions.find((e) => e.id === selectedEnvironment)?.label ?? 'All environments',
  );

  const allProviderOptions = $derived.by(() => {
    const set = new Set<string>();
    for (const p of billingCredits?.availableBillingProviders ?? []) {
      if (p && p !== 'gemini') set.add(p);
    }
    for (const p of billingCredits?.byProvider ?? []) {
      if (p?.name && p.name !== 'gemini') set.add(p.name);
    }
    for (const c of billingCredits?.cliUsage ?? []) {
      if (c?.provider && c.provider !== 'gemini') set.add(c.provider);
    }
    return [...set].sort((a, b) =>
      getProviderDisplayLabel(a).localeCompare(getProviderDisplayLabel(b)),
    );
  });

  const activeProviderLabel = $derived(
    providerFilter === 'all' ? 'All providers' : getProviderDisplayLabel(providerFilter),
  );

  const usageView = $derived(
    deriveUsageWindowView(billingCredits, timeWindow, providerFilter),
  );

  const chartMode = $derived<'cost' | 'tokens'>(viewMode === 'tokens' ? 'tokens' : 'cost');

  const chartGeometry = $derived(
    buildUsageChartGeometry(usageView.series, chartMode, 420, 148, 8, 6),
  );

  const hoveredPoint = $derived(
    hoveredBucketIndex != null ? (chartGeometry.points[hoveredBucketIndex] ?? null) : null,
  );

  const costTypeShares = $derived.by(() => {
    const { inputUsd, cacheReadUsd, outputUsd } = usageView.costByType;
    const total = inputUsd + cacheReadUsd + outputUsd;
    if (total <= 0) {
      return { input: 34, cacheRead: 16, output: 50, hasCost: false };
    }
    return {
      input: Math.max(0, (inputUsd / total) * 100),
      cacheRead: Math.max(0, (cacheReadUsd / total) * 100),
      output: Math.max(0, (outputUsd / total) * 100),
      hasCost: true,
    };
  });

  const timeBreakdownRows = $derived.by(() => {
    const totalVal =
      chartMode === 'tokens' ? usageView.totals.processedTokens : usageView.totalSpendUsd;
    return [...usageView.series]
      .reverse()
      .filter((b) => b.tokens > 0 || b.costUsd > 0)
      .slice(0, 24)
      .map((b) => {
        const val = chartMode === 'tokens' ? b.tokens : b.costUsd;
        return {
          ...b,
          detailLabel: formatBucketDetailLabel(b.ts, b.endTs, usageView.granularity),
          sharePercent: totalVal > 0 ? (val / totalVal) * 100 : 0,
        };
      });
  });

  function formatCompactTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) {
      const k = n / 1e3;
      return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
    }
    return String(Math.round(n));
  }

  function formatUsdClean(value: number | null | undefined, detailed = false): string {
    if (value == null || !Number.isFinite(value)) return 'Unpriced';
    if (value === 0) return '$0.00';
    if (detailed && value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
  }

  function handleChartPointerMove(event: PointerEvent) {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !usageView.series.length) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const idx = Math.min(
      usageView.series.length - 1,
      Math.max(0, Math.round(ratio * (usageView.series.length - 1))),
    );
    if (hoveredBucketIndex !== idx) hoveredBucketIndex = idx;
  }

  function handleWindowClick(e: MouseEvent) {
    if (!openHeaderDropdown) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest('[data-usage-filter-bar]')) {
      openHeaderDropdown = null;
    }
  }
</script>

<svelte:window onclick={handleWindowClick} />

<section class="usage-analytics-surface usage-page w-full" aria-labelledby={headingId}>
  <!-- Page header: same metrics as the shared SettingsPage shell. -->
  <header class="usage-page-header">
    <h2 id={headingId}>{pageTitle}</h2>
    {#if pageDescription}<p>{pageDescription}</p>{/if}
  </header>

  <!-- Top T3-Style Usage Filter & Mode Bar -->
  <div
    data-usage-filter-bar
    class="sticky top-0 z-20 flex w-full flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-0)]/95 py-2.5 backdrop-blur-sm"
  >
    <!-- Breadcrumb + Inline Selectors + Date Range -->
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span class="font-medium text-[var(--color-text-muted)]">Usage</span>
      <span class="text-[var(--color-text-muted)]/50">/</span>

      <!-- Environment Dropdown Trigger -->
      <div class="relative inline-flex">
        <button
          type="button"
          class="inline-flex items-center gap-1 border-b border-dotted border-[var(--color-text-secondary)]/60 pb-px font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
          aria-haspopup="listbox"
          aria-expanded={openHeaderDropdown === 'environment'}
          onclick={(e) => {
            e.stopPropagation();
            openHeaderDropdown = openHeaderDropdown === 'environment' ? null : 'environment';
          }}
        >
          <span>{activeEnvironmentLabel}</span>
          <ChevronDown size={12} class="text-[var(--color-text-muted)]" />
        </button>

        {#if openHeaderDropdown === 'environment'}
          <div
            role="listbox"
            aria-label="Filter usage by environment"
            class="absolute left-0 top-full z-50 mt-1.5 min-w-[200px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1 shadow-xl"
          >
            {#each environmentOptions as env (env.id)}
              <button
                type="button"
                role="option"
                aria-selected={selectedEnvironment === env.id}
                class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
                onclick={() => {
                  selectedEnvironment = env.id;
                  openHeaderDropdown = null;
                }}
              >
                <span class="truncate font-medium text-[var(--color-text-primary)]"
                  >{env.label}</span
                >
                {#if selectedEnvironment === env.id}
                  <Check size={12} class="shrink-0 text-[var(--color-accent)]" />
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <span class="text-[var(--color-text-muted)]/50">/</span>

      <!-- Provider Dropdown Trigger -->
      <div class="relative inline-flex">
        <button
          type="button"
          class="inline-flex items-center gap-1 border-b border-dotted border-[var(--color-text-secondary)]/60 pb-px font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
          aria-haspopup="listbox"
          aria-expanded={openHeaderDropdown === 'provider'}
          onclick={(e) => {
            e.stopPropagation();
            openHeaderDropdown = openHeaderDropdown === 'provider' ? null : 'provider';
          }}
        >
          <span>{activeProviderLabel}</span>
          <ChevronDown size={12} class="text-[var(--color-text-muted)]" />
        </button>

        {#if openHeaderDropdown === 'provider'}
          <div
            role="listbox"
            aria-label="Filter usage by provider"
            class="absolute left-0 top-full z-50 mt-1.5 max-h-72 min-w-[210px] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1 shadow-xl"
          >
            <button
              type="button"
              role="option"
              aria-selected={providerFilter === 'all'}
              class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
              onclick={() => {
                providerFilter = 'all';
                openHeaderDropdown = null;
              }}
            >
              <span class="font-medium text-[var(--color-text-primary)]">All providers</span>
              {#if providerFilter === 'all'}
                <Check size={12} class="shrink-0 text-[var(--color-accent)]" />
              {/if}
            </button>
            {#if allProviderOptions.length > 0}
              <div class="my-1 border-t border-[var(--color-border)]/60"></div>
              {#each allProviderOptions as prov (prov)}
                <button
                  type="button"
                  role="option"
                  aria-selected={providerFilter === prov}
                  class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
                  onclick={() => {
                    providerFilter = prov;
                    openHeaderDropdown = null;
                  }}
                >
                  <span class="flex items-center gap-2 min-w-0">
                    <ProviderIcon provider={prov} size={13} class="shrink-0" />
                    <span class="truncate font-medium text-[var(--color-text-primary)]"
                      >{getProviderDisplayLabel(prov)}</span
                    >
                  </span>
                  {#if providerFilter === prov}
                    <Check size={12} class="shrink-0 text-[var(--color-accent)]" />
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>

      <span class="ml-1.5 text-[11px] tabular-nums text-[var(--color-text-muted)]">
        {usageView.rangeLabel}
      </span>
    </div>

    <!-- Segmented Controls: [Cost | Tokens | Limits] + [Past 24h | 7 days | 30 days | 90 days] + Refresh -->
    <div class="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="Usage metric view"
        class="inline-flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5"
      >
        {#each VIEW_MODES as mode (mode.id)}
          <button
            type="button"
            aria-pressed={viewMode === mode.id}
            onclick={() => (viewMode = mode.id)}
            class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 {viewMode ===
            mode.id
              ? 'bg-[var(--color-surface-0)] text-[var(--color-text-primary)] shadow-xs'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          >
            {mode.label}
          </button>
        {/each}
      </div>

      <div
        role="group"
        aria-label="Usage time window"
        class="inline-flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5"
      >
        {#each WINDOW_OPTIONS as win (win.id)}
          <button
            type="button"
            aria-pressed={timeWindow === win.id}
            onclick={() => {
              timeWindow = win.id;
              hoveredBucketIndex = null;
            }}
            class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 {timeWindow ===
            win.id
              ? 'bg-[var(--color-surface-0)] text-[var(--color-text-primary)] shadow-xs'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          >
            {win.label}
          </button>
        {/each}
      </div>

      <button
        type="button"
        disabled={billingLoading}
        onclick={onRefresh}
        title="Refresh usage and billing data"
        aria-label="Refresh billing data"
        class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] disabled:opacity-50"
      >
        <RefreshCw size={13} class={billingLoading ? 'animate-spin' : ''} />
      </button>
    </div>
  </div>

  <!-- Centered T3-Style Editorial Content Column -->
  <div class="w-full space-y-8 pb-8 pt-6">
    <!-- Top Row: Hero Headline + Provider Breakdown (Left) | Smooth Area Chart (Right) -->
    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
      <!-- Left Column: Hero Figure & Provider List -->
      <div class="lg:col-span-5 space-y-4">
        <div>
          <div class="flex items-baseline gap-2.5">
            {#if billingLoading && !billingCredits}
              <div class="h-10 w-28 rounded-lg bg-[var(--color-surface-3)] animate-pulse"></div>
            {:else if viewMode === 'tokens'}
              <span
                class="text-4xl font-semibold tracking-tight tabular-nums text-[var(--color-text-primary)]"
              >
                {formatCompactTokens(usageView.totals.processedTokens)}
              </span>
              <span class="text-xs font-medium text-[var(--color-text-muted)]">tokens</span>
            {:else if viewMode === 'limits'}
              <span
                class="text-4xl font-semibold tracking-tight tabular-nums text-[var(--color-text-primary)]"
              >
                {typeof billingCredits?.remainingCents === 'number'
                  ? `$${(billingCredits.remainingCents / 100).toFixed(2)}`
                  : `${billingCredits?.cliUsage?.length ?? 0} active`}
              </span>
              <span class="text-xs font-medium text-[var(--color-text-muted)]">
                {typeof billingCredits?.remainingCents === 'number'
                  ? 'live balance'
                  : 'CLI quotas'}
              </span>
            {:else}
              <span
                class="text-4xl font-semibold tracking-tight tabular-nums text-[var(--color-text-primary)]"
              >
                {formatUsdClean(usageView.totalSpendUsd)}
              </span>
              {#if showSubscriptionApiEquivalent && usageView.totalApiEquivalentUsd > 0}
                <span
                  class="rounded-full bg-[var(--color-accent)]/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-accent)]"
                  title="Estimated raw API equivalent value of flat-rate CLI subscription tokens"
                >
                  +{formatUsdClean(usageView.totalApiEquivalentUsd)} CLI equiv.
                </span>
              {/if}
            {/if}
          </div>

          <div
            class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]"
          >
            <span class="tabular-nums">
              {usageView.sessionCount}
              {usageView.sessionCount === 1 ? 'session' : 'sessions'}
            </span>
            <span>·</span>
            <span
              class="inline-flex items-center gap-1"
              title="Computed locally from recorded model tokens against verified models.dev & OpenRouter pricing"
            >
              API estimate
              <Info size={11} class="text-[var(--color-text-muted)]/80" />
            </span>
            {#if typeof billingCredits?.remainingCents === 'number' && viewMode !== 'limits'}
              <span>·</span>
              <span class="font-medium text-[var(--color-success)] tabular-nums">
                ${(billingCredits.remainingCents / 100).toFixed(2)} balance
              </span>
            {/if}
          </div>
        </div>

        <!-- Provider Breakdown List -->
        {#if usageView.byProvider.length > 0}
          <div class="space-y-3 pt-1">
            {#each usageView.byProvider as prov, idx (prov.name)}
              <div class="space-y-0.5">
                <div class="flex items-center gap-2 text-xs">
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    style="background: {idx === 0
                      ? 'var(--color-accent)'
                      : prov.subscription
                        ? 'var(--color-warning)'
                        : 'var(--color-text-secondary)'};"
                  ></span>
                  <ProviderIcon provider={prov.name} size={14} class="shrink-0" />
                  <span class="font-medium text-[var(--color-text-primary)] truncate">
                    {getProviderDisplayLabel(prov.name)}
                  </span>
                  <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                    {prov.sessionCount}
                    {prov.sessionCount === 1 ? 'session' : 'sessions'}
                  </span>
                  <span
                    class="ml-auto font-mono text-xs font-semibold tabular-nums text-[var(--color-text-primary)]"
                  >
                    {viewMode === 'tokens'
                      ? formatCompactTokens(prov.tokens)
                      : formatUsdClean(prov.spendUsd)}
                  </span>
                </div>
                <div class="pl-5 text-[11px] text-[var(--color-text-muted)] tabular-nums">
                  {prov.sharePercent.toFixed(1)}% of cost · {formatCompactTokens(prov.tokens)} tokens
                  {#if prov.subscription && showSubscriptionApiEquivalent && prov.apiEquivalentUsd != null && prov.apiEquivalentUsd > 0}
                    <span class="text-[var(--color-accent)]/85">
                      · ~{formatUsdClean(prov.apiEquivalentUsd)} API eq.
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <p class="pt-1 text-xs text-[var(--color-text-muted)]">
            No provider activity recorded in this window yet.
          </p>
        {/if}
      </div>

      <!-- Right Column: Hourly / Daily Cost or Token Spline Chart -->
      <div class="lg:col-span-7">
        <div class="mb-2 flex items-center justify-between gap-2 h-5">
          <span class="text-xs font-semibold text-[var(--color-text-primary)]">
            {usageView.granularity === 'hour' ? 'Hourly' : 'Daily'}
            {chartMode === 'tokens' ? 'tokens' : 'cost'}
          </span>
          {#if hoveredPoint}
            <span
              class="rounded-md bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] font-mono tabular-nums text-[var(--color-text-secondary)]"
            >
              {formatBucketDetailLabel(
                hoveredPoint.point.ts,
                hoveredPoint.point.endTs,
                usageView.granularity,
              )} ·
              <strong class="text-[var(--color-text-primary)]">
                {chartMode === 'tokens'
                  ? `${formatCompactTokens(hoveredPoint.point.tokens)} tokens`
                  : formatUsdClean(hoveredPoint.point.costUsd, true)}
              </strong>
            </span>
          {/if}
        </div>

        <div class="flex items-stretch">
          <!-- Y-axis labels -->
          <div
            class="flex w-11 shrink-0 flex-col justify-between pr-2.5 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-muted)] select-none"
            style="height: 148px;"
          >
            {#each chartGeometry.yTicks as tick (tick.y)}
              <span class="leading-none">{tick.label}</span>
            {/each}
          </div>

          <!-- SVG Chart -->
          <div class="min-w-0 flex-1">
            <svg
              class="h-[148px] w-full overflow-visible cursor-crosshair"
              viewBox="0 0 420 148"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${usageView.granularity === 'hour' ? 'Hourly' : 'Daily'} ${chartMode} chart`}
              onpointermove={handleChartPointerMove}
              onpointerleave={() => (hoveredBucketIndex = null)}
            >
              <defs>
                <linearGradient id="kory-t3-usage-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0.0" />
                </linearGradient>
              </defs>

              {#each chartGeometry.yTicks as tick (tick.y)}
                <line
                  x1="0"
                  y1={tick.y}
                  x2="420"
                  y2={tick.y}
                  stroke="var(--color-border)"
                  stroke-width="1"
                />
              {/each}

              {#if chartGeometry.areaPath}
                <path d={chartGeometry.areaPath} fill="url(#kory-t3-usage-area)" />
              {/if}
              {#if chartGeometry.linePath}
                <path
                  d={chartGeometry.linePath}
                  fill="none"
                  stroke="var(--color-accent)"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              {/if}

              {#if hoveredPoint}
                <line
                  x1={hoveredPoint.x}
                  y1="8"
                  x2={hoveredPoint.x}
                  y2="142"
                  stroke="var(--color-accent)"
                  stroke-width="1"
                  stroke-dasharray="3 3"
                />
                <circle
                  cx={hoveredPoint.x}
                  cy={hoveredPoint.y}
                  r="3.5"
                  fill="var(--color-accent)"
                  stroke="var(--color-surface-0)"
                  stroke-width="1.5"
                />
              {/if}
            </svg>

            <!-- X-axis labels -->
            {#if usageView.series.length > 0}
              {@const firstBucket = usageView.series[0]}
              {@const midBucket = usageView.series[Math.floor(usageView.series.length / 2)]}
              {@const lastBucket = usageView.series[usageView.series.length - 1]}
              <div
                class="mt-1.5 flex items-center justify-between text-[11px] tabular-nums text-[var(--color-text-muted)] select-none"
              >
                <span>{firstBucket?.label ?? ''}</span>
                <span>{midBucket?.label ?? ''}</span>
                <span>{lastBucket?.label ?? ''}</span>
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>

    <!-- Totals 5-Column Strip -->
    <section class="space-y-3" aria-label="Token and cache totals">
      <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Totals</h4>
      <div class="grid grid-cols-2 gap-x-5 gap-y-3 md:grid-cols-5">
        <div>
          <div class="text-[11px] text-[var(--color-text-muted)]">Processed tokens</div>
          <div
            class="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-text-primary)]"
          >
            {formatCompactTokens(usageView.totals.processedTokens)}
          </div>
        </div>
        <div>
          <div class="text-[11px] text-[var(--color-text-muted)]">Cached input</div>
          <div
            class="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-text-primary)]"
          >
            {formatCompactTokens(usageView.totals.cachedInputTokens)}
          </div>
        </div>
        <div>
          <div class="text-[11px] text-[var(--color-text-muted)]">Uncached input</div>
          <div
            class="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-text-primary)]"
          >
            {formatCompactTokens(usageView.totals.uncachedInputTokens)}
          </div>
        </div>
        <div>
          <div class="text-[11px] text-[var(--color-text-muted)]">Output</div>
          <div
            class="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-text-primary)]"
          >
            {formatCompactTokens(usageView.totals.outputTokens)}
          </div>
        </div>
        <div>
          <div class="text-[11px] text-[var(--color-text-muted)]">Cache savings</div>
          <div
            class="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-text-primary)]"
          >
            {formatUsdClean(usageView.totals.cacheSavingsUsd)}
          </div>
        </div>
      </div>
    </section>

    <!-- Cost by type Stacked Bar -->
    <section class="space-y-2.5" aria-label="Cost by token type">
      <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Cost by type</h4>
      <div
        class="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)] gap-[2px]"
      >
        <div
          class="h-full rounded-l-full bg-[var(--color-text-secondary)] transition-all"
          style:width={`${costTypeShares.input}%`}
        ></div>
        <div
          class="h-full bg-[var(--color-text-muted)]/55 transition-all"
          style:width={`${costTypeShares.cacheRead}%`}
        ></div>
        <div
          class="h-full rounded-r-full bg-[var(--color-text-primary)] transition-all"
          style:width={`${costTypeShares.output}%`}
        ></div>
      </div>
      <div class="flex flex-wrap items-center gap-5 text-[11px]">
        <span class="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <span class="h-2 w-2 rounded-[2px] bg-[var(--color-text-secondary)]"></span>
          Input
          <strong class="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">
            {formatUsdClean(usageView.costByType.inputUsd)}
          </strong>
        </span>
        <span class="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <span class="h-2 w-2 rounded-[2px] bg-[var(--color-text-muted)]/55"></span>
          Cache read
          <strong class="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">
            {formatUsdClean(usageView.costByType.cacheReadUsd)}
          </strong>
        </span>
        <span class="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <span class="h-2 w-2 rounded-[2px] bg-[var(--color-text-primary)]"></span>
          Output
          <strong class="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">
            {formatUsdClean(usageView.costByType.outputUsd)}
          </strong>
        </span>
      </div>
    </section>

    <!-- Breakdown Table ([Model | Hour/Day]) -->
    <section class="space-y-3" aria-label="Usage breakdown">
      <div class="flex items-center justify-between gap-4">
        <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Breakdown</h4>
        <div
          role="group"
          aria-label="Breakdown dimension"
          class="inline-flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5"
        >
          <button
            type="button"
            aria-pressed={breakdownTab === 'model'}
            onclick={() => (breakdownTab = 'model')}
            class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-all {breakdownTab ===
            'model'
              ? 'bg-[var(--color-surface-0)] text-[var(--color-text-primary)] shadow-xs'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          >
            Model
          </button>
          <button
            type="button"
            aria-pressed={breakdownTab === 'time'}
            onclick={() => (breakdownTab = 'time')}
            class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-all {breakdownTab ===
            'time'
              ? 'bg-[var(--color-surface-0)] text-[var(--color-text-primary)] shadow-xs'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          >
            {usageView.granularity === 'hour' ? 'Hour' : 'Day'}
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-left text-xs">
          <thead>
            <tr
              class="border-b border-[var(--color-border)] text-[11px] font-medium text-[var(--color-text-muted)]"
            >
              <th class="w-8 py-2 font-normal">#</th>
              <th class="py-2 font-normal">
                {breakdownTab === 'model'
                  ? 'Model'
                  : usageView.granularity === 'hour'
                    ? 'Hour'
                    : 'Day'}
              </th>
              <th class="py-2 text-right font-normal">Cost</th>
              <th class="w-20 py-2 text-right font-normal">Share</th>
              <th class="w-24 py-2 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--color-border)]/60">
            {#if breakdownTab === 'model'}
              {#if usageView.byModel.length > 0}
                {#each usageView.byModel as row, idx (`${row.provider}::${row.model}`)}
                  {@const barShare =
                    viewMode === 'tokens' ? row.tokenSharePercent : row.sharePercent}
                  <tr class="group transition-colors hover:bg-[var(--color-surface-2)]/40">
                    <td class="py-3 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
                      {idx + 1}
                    </td>
                    <td class="py-3 pr-4">
                      <div class="inline-flex flex-col gap-1 min-w-[160px] max-w-full">
                        <div class="flex items-center gap-2">
                          <ProviderIcon provider={row.provider} size={14} class="shrink-0" />
                          <span class="font-medium text-[var(--color-text-primary)] truncate">
                            {row.model}
                          </span>
                        </div>
                        {#if barShare > 0}
                          <div
                            class="h-[2px] w-36 max-w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]"
                          >
                            <div
                              class="h-full rounded-full bg-[var(--color-accent)]"
                              style:width={`${Math.max(4, Math.min(100, barShare))}%`}
                            ></div>
                          </div>
                        {/if}
                      </div>
                    </td>
                    <td class="py-3 text-right font-mono tabular-nums">
                      {#if row.hasKnownCost && row.spendUsd != null}
                        <span class="font-semibold text-[var(--color-text-primary)]">
                          {formatUsdClean(row.spendUsd, true)}
                        </span>
                      {:else}
                        <span class="font-sans text-[11px] text-[var(--color-text-muted)]">
                          Unpriced
                        </span>
                        {#if showSubscriptionApiEquivalent && row.apiEquivalentUsd != null && row.apiEquivalentUsd > 0}
                          <span class="block text-[11px] text-[var(--color-accent)]/85">
                            ~{formatUsdClean(row.apiEquivalentUsd)} eq.
                          </span>
                        {/if}
                      {/if}
                    </td>
                    <td
                      class="py-3 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]"
                    >
                      {#if row.hasKnownCost && row.spendUsd != null}
                        {row.sharePercent.toFixed(1)}%
                      {:else if viewMode === 'tokens'}
                        {row.tokenSharePercent.toFixed(1)}%
                      {/if}
                    </td>
                    <td
                      class="py-3 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]"
                    >
                      {formatCompactTokens(row.tokens)}
                    </td>
                  </tr>
                {/each}
              {:else}
                <tr>
                  <td colspan="5" class="py-8 text-center text-xs text-[var(--color-text-muted)]">
                    No model activity recorded in this window.
                  </td>
                </tr>
              {/if}
            {:else if timeBreakdownRows.length > 0}
              {#each timeBreakdownRows as bucket, idx (bucket.ts)}
                <tr class="transition-colors hover:bg-[var(--color-surface-2)]/40">
                  <td class="py-3 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
                    {idx + 1}
                  </td>
                  <td class="py-3 pr-4">
                    <div class="inline-flex flex-col gap-1 min-w-[160px]">
                      <span class="font-medium text-[var(--color-text-primary)]">
                        {bucket.detailLabel}
                      </span>
                      {#if bucket.sharePercent > 0}
                        <div
                          class="h-[2px] w-32 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
                        >
                          <div
                            class="h-full rounded-full bg-[var(--color-accent)]"
                            style:width={`${Math.max(4, Math.min(100, bucket.sharePercent))}%`}
                          ></div>
                        </div>
                      {/if}
                    </div>
                  </td>
                  <td
                    class="py-3 text-right font-mono font-semibold tabular-nums text-[var(--color-text-primary)]"
                  >
                    {formatUsdClean(bucket.costUsd, true)}
                  </td>
                  <td
                    class="py-3 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]"
                  >
                    {bucket.sharePercent.toFixed(1)}%
                  </td>
                  <td
                    class="py-3 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]"
                  >
                    {formatCompactTokens(bucket.tokens)}
                  </td>
                </tr>
              {/each}
            {:else}
              <tr>
                <td colspan="5" class="py-8 text-center text-xs text-[var(--color-text-muted)]">
                  No time-bucketed usage recorded in this window.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </section>

    {#if viewMode === 'limits' && onOpenSafetyLimits}
      <div
        class="flex items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] px-4 py-3 text-xs"
      >
        <div class="flex items-center gap-2.5 min-w-0">
          <Shield size={15} class="shrink-0 text-[var(--color-accent)]" />
          <span class="text-[var(--color-text-secondary)]">
            Configure runtime-enforced rolling hourly and daily spend caps in
            <strong class="text-[var(--color-text-primary)]">Safety limits</strong>.
          </span>
        </div>
        <button
          type="button"
          onclick={onOpenSafetyLimits}
          class="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)]"
        >
          Open safety limits
        </button>
      </div>
    {/if}
  </div>
</section>

<style>
  /* Same column and header metrics as SettingsPage width="wide": the title,
     the filter toolbar and the dashboard body share one left edge. */
  .usage-page {
    max-width: calc(1080px + 64px);
    margin: 0 auto;
    padding: 0 32px;
    min-width: 0;
  }
  .usage-page-header {
    padding-top: 28px;
    margin-bottom: 16px;
  }
  .usage-page-header h2 {
    margin: 0;
    font-size: 20px;
    line-height: 1.3;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .usage-page-header p {
    margin: 4px 0 0;
    max-width: 64ch;
    font-size: 13px;
    line-height: 1.55;
    color: var(--color-text-muted);
  }
  @media (max-width: 640px) {
    .usage-page {
      padding: 0 16px;
    }
    .usage-page-header {
      padding-top: 20px;
    }
  }
</style>
