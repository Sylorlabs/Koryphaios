export type UsageWindowKey = '24h' | '7d' | '30d' | '90d';
export type UsageViewMode = 'cost' | 'tokens' | 'limits';
export type UsageBreakdownTab = 'model' | 'time';

export interface NormalizedSeriesPoint {
  ts: number;
  endTs: number;
  label: string;
  costUsd: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  sessionCount: number;
}

export interface NormalizedProviderRow {
  name: string;
  sessionCount: number;
  spendUsd: number;
  apiEquivalentUsd: number | null;
  sharePercent: number;
  tokenSharePercent: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  subscription: boolean;
}

export interface NormalizedModelRow {
  model: string;
  provider: string;
  spendUsd: number | null;
  apiEquivalentUsd: number | null;
  sharePercent: number;
  tokenSharePercent: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  subscription: boolean;
}

export interface NormalizedUsageView {
  window: UsageWindowKey;
  granularity: 'hour' | 'day';
  startTs: number;
  endTs: number;
  rangeLabel: string;
  totalSpendUsd: number;
  totalApiEquivalentUsd: number;
  hasKnownSpend: boolean;
  pricingIncomplete: boolean;
  sessionCount: number;
  totals: {
    processedTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheSavingsUsd: number;
  };
  costByType: {
    inputUsd: number;
    cacheReadUsd: number;
    outputUsd: number;
  };
  byProvider: NormalizedProviderRow[];
  byModel: NormalizedModelRow[];
  series: NormalizedSeriesPoint[];
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function cliPeriodAliases(window: UsageWindowKey): string[] {
  switch (window) {
    case '24h':
      return ['day', '24h'];
    case '7d':
      return ['week', '7d'];
    case '30d':
      return ['month', '30d'];
    case '90d':
      return ['month', '30d', '90d'];
  }
}

export function formatUsageDateRange(
  startTs: number,
  endTs: number,
  granularity: 'hour' | 'day',
): string {
  const start = new Date(startTs);
  const end = new Date(endTs);
  if (granularity === 'hour') {
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
    });
    return `${fmt.format(start)} to ${fmt.format(end)}`;
  }
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${fmt.format(start)} to ${fmt.format(end)}`;
}

export function formatBucketLabel(ts: number, granularity: 'hour' | 'day'): string {
  const date = new Date(ts);
  if (granularity === 'hour') {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatBucketDetailLabel(
  ts: number,
  endTs: number,
  granularity: 'hour' | 'day',
): string {
  const start = new Date(ts);
  const end = new Date(endTs);
  if (granularity === 'hour') {
    const dayPart = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(start);
    const startHour = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
    }).format(start);
    const endHour = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
    }).format(end);
    return `${dayPart}, ${startHour} – ${endHour}`;
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(start);
}

export function deriveUsageWindowView(
  billingCredits: any,
  window: UsageWindowKey,
  providerFilter: string = 'all',
  now = Date.now(),
): NormalizedUsageView {
  const filterNorm = providerFilter.trim().toLowerCase();
  const matchesFilter = (provider: string) =>
    filterNorm === 'all' || !filterNorm || provider.trim().toLowerCase() === filterNorm;

  const granularity: 'hour' | 'day' = window === '24h' ? 'hour' : 'day';
  const bucketCount = window === '24h' ? 24 : window === '7d' ? 7 : window === '30d' ? 30 : 90;
  const bucketMs = granularity === 'hour' ? HOUR_MS : DAY_MS;

  const rawWindow = billingCredits?.analytics?.windows?.[window];
  const startTs: number =
    typeof rawWindow?.startTs === 'number' ? rawWindow.startTs : now - bucketCount * bucketMs;
  const endTs: number = typeof rawWindow?.endTs === 'number' ? rawWindow.endTs : now;

  const providerMap = new Map<string, NormalizedProviderRow>();
  const modelMap = new Map<string, NormalizedModelRow>();

  // 1. Seed from backend windowed analytics when present
  if (rawWindow) {
    for (const p of rawWindow.byProvider ?? []) {
      if (!matchesFilter(p.name)) continue;
      providerMap.set(p.name, { ...p });
    }
    for (const m of rawWindow.byModel ?? []) {
      if (!matchesFilter(m.provider)) continue;
      modelMap.set(`${m.provider}::${m.model}`, { ...m });
    }
  } else if (Array.isArray(billingCredits?.byProvider)) {
    // Fallback when backend analytics object is absent (e.g. demo or legacy snapshot)
    for (const p of billingCredits.byProvider) {
      if (!p?.name || !matchesFilter(p.name)) continue;
      const spendUsd =
        typeof p.spendUsd === 'number'
          ? p.spendUsd
          : typeof p.spendCents === 'number'
            ? p.spendCents / 100
            : 0;
      const tokensIn = Number(p.tokensIn ?? 0);
      const tokensOut = Number(p.tokensOut ?? 0);
      const tokens = tokensIn + tokensOut;
      const subscription = Boolean(p.subscription);
      providerMap.set(p.name, {
        name: p.name,
        sessionCount: Math.max(1, Array.isArray(p.models) ? p.models.length : 1),
        spendUsd: subscription ? 0 : spendUsd,
        apiEquivalentUsd: typeof p.apiEquivalentUsd === 'number' ? p.apiEquivalentUsd : null,
        sharePercent: 0,
        tokenSharePercent: 0,
        tokens,
        tokensIn,
        tokensOut,
        cacheReadTokens: 0,
        hasKnownCost: p.hasKnownCost !== false,
        pricingIncomplete: Boolean(p.pricingIncomplete),
        subscription,
      });
      for (const m of p.models ?? []) {
        const mSpend =
          typeof m.spendUsd === 'number'
            ? m.spendUsd
            : typeof m.spendCents === 'number'
              ? m.spendCents / 100
              : null;
        const mIn = Number(m.tokensIn ?? 0);
        const mOut = Number(m.tokensOut ?? 0);
        modelMap.set(`${p.name}::${m.model}`, {
          model: m.model,
          provider: p.name,
          spendUsd: subscription || m.hasKnownCost === false ? null : mSpend,
          apiEquivalentUsd: typeof m.apiEquivalentUsd === 'number' ? m.apiEquivalentUsd : null,
          sharePercent: 0,
          tokenSharePercent: 0,
          tokens: mIn + mOut,
          tokensIn: mIn,
          tokensOut: mOut,
          cacheReadTokens: 0,
          hasKnownCost: !subscription && m.hasKnownCost !== false && mSpend !== null,
          pricingIncomplete: Boolean(m.pricingIncomplete),
          subscription,
        });
      }
    }
  }

  // 2. Supplement with CLI subscription usage reports for any CLI provider not yet in the map
  const aliases = cliPeriodAliases(window);
  for (const cli of billingCredits?.cliUsage ?? []) {
    if (!cli?.provider || !matchesFilter(cli.provider)) continue;
    const winEntry =
      (cli.windows ?? []).find((w: any) => aliases.includes(String(w.period).toLowerCase())) ??
      cli.windows?.[cli.windows.length - 1];
    const cliTokensIn = Number(winEntry?.tokensIn ?? 0);
    const cliTokensOut = Number(winEntry?.tokensOut ?? 0);
    const cliCacheRead = Number(winEntry?.cacheRead ?? 0);
    const cliTokens = cliTokensIn + cliTokensOut;
    if (cliTokens <= 0 && (!cli.byModel || cli.byModel.length === 0)) continue;

    const existingProv = providerMap.get(cli.provider);
    if (!existingProv || existingProv.tokens === 0) {
      providerMap.set(cli.provider, {
        name: cli.provider,
        sessionCount: Math.max(1, (cli.dailyUsage ?? []).filter((d: any) => d.tokens > 0).length || 1),
        spendUsd: 0,
        apiEquivalentUsd:
          typeof cli.apiValueUsd === 'number'
            ? cli.apiValueUsd
            : typeof winEntry?.inferenceValueUsd === 'number'
              ? winEntry.inferenceValueUsd
              : null,
        sharePercent: 0,
        tokenSharePercent: 0,
        tokens: cliTokens,
        tokensIn: cliTokensIn,
        tokensOut: cliTokensOut,
        cacheReadTokens: cliCacheRead,
        hasKnownCost: true,
        pricingIncomplete: false,
        subscription: true,
      });
    }

    for (const m of cli.byModel ?? []) {
      const key = `${cli.provider}::${m.model}`;
      if (modelMap.has(key)) continue;
      const mIn = Number(m.tokensIn ?? 0);
      const mOut = Number(m.tokensOut ?? 0);
      if (mIn + mOut <= 0) continue;
      modelMap.set(key, {
        model: m.model,
        provider: cli.provider,
        spendUsd: null,
        apiEquivalentUsd:
          typeof m.apiValueUsd === 'number'
            ? m.apiValueUsd
            : typeof m.inferenceValueUsd === 'number'
              ? m.inferenceValueUsd
              : null,
        sharePercent: 0,
        tokenSharePercent: 0,
        tokens: mIn + mOut,
        tokensIn: mIn,
        tokensOut: mOut,
        cacheReadTokens: 0,
        hasKnownCost: false,
        pricingIncomplete: false,
        subscription: true,
      });
    }
  }

  const providers = [...providerMap.values()];
  const models = [...modelMap.values()];

  const totalSpendUsd = providers.reduce((sum, p) => sum + (p.subscription ? 0 : p.spendUsd), 0);
  const totalApiEquivalentUsd = providers.reduce(
    (sum, p) => sum + (p.apiEquivalentUsd ?? 0),
    0,
  );
  const processedTokens =
    rawWindow && filterNorm === 'all' && rawWindow.totals?.processedTokens > 0
      ? Math.max(
          rawWindow.totals.processedTokens,
          providers.reduce((sum, p) => sum + p.tokens, 0),
        )
      : providers.reduce((sum, p) => sum + p.tokens, 0);

  const cachedInputTokens =
    rawWindow && filterNorm === 'all'
      ? Math.max(
          rawWindow.totals?.cachedInputTokens ?? 0,
          providers.reduce((sum, p) => sum + p.cacheReadTokens, 0),
        )
      : providers.reduce((sum, p) => sum + p.cacheReadTokens, 0);

  const totalTokensIn = providers.reduce((sum, p) => sum + p.tokensIn, 0);
  const outputTokens =
    rawWindow && filterNorm === 'all' && rawWindow.totals?.outputTokens > 0
      ? Math.max(
          rawWindow.totals.outputTokens,
          providers.reduce((sum, p) => sum + p.tokensOut, 0),
        )
      : providers.reduce((sum, p) => sum + p.tokensOut, 0);
  const uncachedInputTokens = Math.max(0, totalTokensIn - cachedInputTokens);
  const cacheWriteTokens = rawWindow?.totals?.cacheWriteTokens ?? 0;
  const cacheSavingsUsd = rawWindow?.totals?.cacheSavingsUsd ?? 0;

  for (const p of providers) {
    p.sharePercent = totalSpendUsd > 0 ? (p.spendUsd / totalSpendUsd) * 100 : 0;
    p.tokenSharePercent = processedTokens > 0 ? (p.tokens / processedTokens) * 100 : 0;
  }
  providers.sort(
    (a, b) => b.spendUsd - a.spendUsd || b.tokens - a.tokens || a.name.localeCompare(b.name),
  );

  for (const m of models) {
    m.sharePercent =
      m.hasKnownCost && m.spendUsd != null && totalSpendUsd > 0
        ? (m.spendUsd / totalSpendUsd) * 100
        : 0;
    m.tokenSharePercent = processedTokens > 0 ? (m.tokens / processedTokens) * 100 : 0;
  }
  models.sort(
    (a, b) =>
      (b.spendUsd ?? -1) - (a.spendUsd ?? -1) ||
      b.tokens - a.tokens ||
      a.model.localeCompare(b.model),
  );

  let costByType = {
    inputUsd: rawWindow?.costByType?.inputUsd ?? 0,
    cacheReadUsd: rawWindow?.costByType?.cacheReadUsd ?? 0,
    outputUsd: rawWindow?.costByType?.outputUsd ?? 0,
  };
  const costTypeSum = costByType.inputUsd + costByType.cacheReadUsd + costByType.outputUsd;
  if (totalSpendUsd > 0 && Math.abs(costTypeSum - totalSpendUsd) > 0.005) {
    if (costTypeSum > 0) {
      const scale = totalSpendUsd / costTypeSum;
      costByType = {
        inputUsd: costByType.inputUsd * scale,
        cacheReadUsd: costByType.cacheReadUsd * scale,
        outputUsd: costByType.outputUsd * scale,
      };
    } else {
      const wIn = Math.max(1, uncachedInputTokens);
      const wCache = cachedInputTokens * 0.1;
      const wOut = Math.max(1, outputTokens) * 3;
      const wTotal = wIn + wCache + wOut;
      costByType = {
        inputUsd: totalSpendUsd * (wIn / wTotal),
        cacheReadUsd: totalSpendUsd * (wCache / wTotal),
        outputUsd: totalSpendUsd * (wOut / wTotal),
      };
    }
  }

  let series: NormalizedSeriesPoint[] = [];
  if (Array.isArray(rawWindow?.series) && rawWindow.series.length > 0) {
    series = rawWindow.series.map((b: any) => ({
      ts: b.ts,
      endTs: b.endTs ?? b.ts + bucketMs,
      label: formatBucketLabel(b.ts, granularity),
      costUsd: Number(b.costUsd ?? 0),
      tokens: Number(b.tokens ?? 0),
      tokensIn: Number(b.tokensIn ?? 0),
      tokensOut: Number(b.tokensOut ?? 0),
      cacheReadTokens: Number(b.cacheReadTokens ?? 0),
      sessionCount: Number(b.sessionCount ?? 0),
    }));
  } else {
    series = Array.from({ length: bucketCount }, (_, index) => {
      const ts = startTs + index * bucketMs;
      return {
        ts,
        endTs: ts + bucketMs,
        label: formatBucketLabel(ts, granularity),
        costUsd: 0,
        tokens: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        sessionCount: 0,
      };
    });
    // Distribute demo/fallback spend across recent buckets so the chart matches the totals
    if (totalSpendUsd > 0 || processedTokens > 0) {
      const weights = [0.58, 0.22, 0.14, 0.06];
      weights.forEach((weight, offset) => {
        const idx = Math.max(0, series.length - 1 - offset * 2);
        if (series[idx]) {
          series[idx].costUsd += totalSpendUsd * weight;
          series[idx].tokens += Math.round(processedTokens * weight);
          series[idx].tokensIn += Math.round(totalTokensIn * weight);
          series[idx].tokensOut += Math.round(outputTokens * weight);
          series[idx].sessionCount = Math.max(1, Math.round(providers.length * weight));
        }
      });
    }
  }

  const sessionCount =
    rawWindow && filterNorm === 'all' && rawWindow.sessionCount > 0
      ? rawWindow.sessionCount
      : providers.reduce((sum, p) => sum + p.sessionCount, 0);

  const hasKnownSpend =
    providers.some((p) => !p.subscription && p.hasKnownCost) ||
    Boolean(rawWindow?.hasKnownSpend) ||
    Boolean(billingCredits?.hasKnownSpend);
  const pricingIncomplete =
    providers.some((p) => p.pricingIncomplete) ||
    Boolean(rawWindow?.pricingIncomplete) ||
    Boolean(billingCredits?.pricingIncomplete);

  return {
    window,
    granularity,
    startTs,
    endTs,
    rangeLabel: formatUsageDateRange(startTs, endTs, granularity),
    totalSpendUsd,
    totalApiEquivalentUsd,
    hasKnownSpend,
    pricingIncomplete,
    sessionCount,
    totals: {
      processedTokens,
      cachedInputTokens,
      uncachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      cacheSavingsUsd,
    },
    costByType,
    byProvider: providers,
    byModel: models,
    series,
  };
}

export interface ChartGeometry {
  linePath: string;
  areaPath: string;
  yTicks: Array<{ value: number; y: number; label: string }>;
  points: Array<{ x: number; y: number; value: number; point: NormalizedSeriesPoint }>;
  maxValue: number;
}

function niceMaxValue(rawMax: number, mode: 'cost' | 'tokens'): number {
  if (rawMax <= 0) return mode === 'cost' ? 1.5 : 100_000;
  if (mode === 'cost') {
    if (rawMax <= 0.03) return 0.03;
    if (rawMax <= 0.15) return 0.15;
    if (rawMax <= 0.3) return 0.3;
    if (rawMax <= 0.6) return 0.6;
    if (rawMax <= 1.5) return 1.5;
    if (rawMax <= 3) return 3;
    if (rawMax <= 6) return 6;
    if (rawMax <= 15) return 15;
    return Math.ceil(rawMax / 3) * 3;
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const normalized = rawMax / magnitude;
  const nice = normalized <= 1.5 ? 1.5 : normalized <= 3 ? 3 : normalized <= 6 ? 6 : 12;
  return nice * magnitude;
}

export function formatChartAxisValue(value: number, mode: 'cost' | 'tokens'): string {
  if (value === 0) return '0';
  if (mode === 'cost') {
    if (value >= 1) return `$${value.toFixed(2)}`;
    if (value >= 0.01) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(4)}`;
  }
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(Math.round(value));
}

/**
 * Generates a smooth monotone cubic spline SVG path and area fill for the
 * T3-style Hourly / Daily Usage chart.
 */
export function buildUsageChartGeometry(
  series: NormalizedSeriesPoint[],
  mode: 'cost' | 'tokens',
  width = 420,
  height = 148,
  padTop = 8,
  padBottom = 6,
): ChartGeometry {
  const usableHeight = Math.max(10, height - padTop - padBottom);
  const baseY = padTop + usableHeight;
  const values = series.map((item) =>
    Math.max(0, mode === 'tokens' ? item.tokens : item.costUsd),
  );
  const rawMax = values.length ? Math.max(...values) : 0;
  const maxValue = niceMaxValue(rawMax, mode);

  const yTicks = [1, 2 / 3, 1 / 3, 0].map((ratio) => {
    const val = maxValue * ratio;
    const y = padTop + (1 - ratio) * usableHeight;
    return {
      value: val,
      y,
      label: formatChartAxisValue(val, mode),
    };
  });

  if (!series.length) {
    return { linePath: '', areaPath: '', yTicks, points: [], maxValue };
  }

  const points = series.map((point, index) => {
    const value = values[index] ?? 0;
    const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * width;
    const y = baseY - (value / maxValue) * usableHeight;
    return { x, y, value, point };
  });

  if (points.length === 1) {
    const p = points[0]!;
    const linePath = `M 0 ${p.y.toFixed(1)} L ${width} ${p.y.toFixed(1)}`;
    const areaPath = `${linePath} L ${width} ${baseY.toFixed(1)} L 0 ${baseY.toFixed(1)} Z`;
    return { linePath, areaPath, yTicks, points, maxValue };
  }

  // Monotone cubic Hermite interpolation so spikes never overshoot below 0
  const n = points.length;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dxi = Math.max(1e-6, points[i + 1]!.x - points[i]!.x);
    const dyi = points[i + 1]!.y - points[i]!.y;
    dx.push(dxi);
    dy.push(dyi);
    m.push(dyi / dxi);
  }

  const tangents: number[] = [m[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const m0 = m[i - 1]!;
    const m1 = m[i]!;
    if (m0 * m1 <= 0) {
      tangents.push(0);
    } else {
      tangents.push((m0 + m1) / 2);
    }
  }
  tangents.push(m[n - 2] ?? 0);

  for (let i = 0; i < n - 1; i++) {
    const mi = m[i]!;
    if (Math.abs(mi) < 1e-6) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i]! / mi;
      const b = tangents[i + 1]! / mi;
      const h = Math.hypot(a, b);
      if (h > 3) {
        const t = 3 / h;
        tangents[i] = t * a * mi;
        tangents[i + 1] = t * b * mi;
      }
    }
  }

  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const segDx = dx[i]!;
    const cp1x = p0.x + segDx / 3;
    const cp1y = Math.min(baseY, Math.max(padTop, p0.y + (tangents[i]! * segDx) / 3));
    const cp2x = p1.x - segDx / 3;
    const cp2y = Math.min(baseY, Math.max(padTop, p1.y - (tangents[i + 1]! * segDx) / 3));
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  }

  const areaPath = `${d} L ${points[n - 1]!.x.toFixed(2)} ${baseY.toFixed(2)} L ${points[0]!.x.toFixed(2)} ${baseY.toFixed(2)} Z`;

  return {
    linePath: d,
    areaPath,
    yTicks,
    points,
    maxValue,
  };
}
