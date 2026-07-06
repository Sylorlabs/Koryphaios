type ChartType = 'bar' | 'line' | 'pie';

interface ChartDataset {
  label?: string;
  data: number[];
}

interface ChartSpec {
  type: ChartType;
  title?: string;
  labels: string[];
  datasets: ChartDataset[];
}

const COLORS = ['#d5b261', '#60a5fa', '#34d399', '#a78bfa', '#fb7185', '#22d3ee'];

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSpec(source: string): ChartSpec | null {
  try {
    const raw = JSON.parse(source) as Record<string, unknown>;
    if (!['bar', 'line', 'pie'].includes(String(raw.type))) return null;

    let labels = Array.isArray(raw.labels) ? raw.labels.map(String) : [];
    let datasets: ChartDataset[] = Array.isArray(raw.datasets)
      ? raw.datasets.slice(0, 6).flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          const data = Array.isArray(row.data)
            ? row.data.map(finiteNumber).filter((value): value is number => value !== null)
            : [];
          return data.length ? [{ label: row.label ? String(row.label) : undefined, data }] : [];
        })
      : [];

    // Compact form: { type, data: [{ label, value }] }
    if (!datasets.length && Array.isArray(raw.data)) {
      const points = raw.data.slice(0, 48).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const point = item as Record<string, unknown>;
        const value = finiteNumber(point.value);
        return value === null ? [] : [{ label: String(point.label ?? ''), value }];
      });
      labels = points.map((point) => point.label);
      datasets = points.length ? [{ data: points.map((point) => point.value) }] : [];
    }

    const pointCount = Math.min(48, labels.length, ...datasets.map((dataset) => dataset.data.length));
    if (!datasets.length || pointCount < 1) return null;
    return {
      type: raw.type as ChartType,
      title: raw.title ? String(raw.title).slice(0, 160) : undefined,
      labels: labels.slice(0, pointCount),
      datasets: datasets.map((dataset) => ({ ...dataset, data: dataset.data.slice(0, pointCount) })),
    };
  } catch {
    return null;
  }
}

function legend(spec: ChartSpec): string {
  if (spec.datasets.length < 2) return '';
  return `<div class="kory-chart-legend">${spec.datasets.map((dataset, index) =>
    `<span><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(dataset.label ?? `Series ${index + 1}`)}</span>`,
  ).join('')}</div>`;
}

function cartesianChart(spec: ChartSpec): string {
  const width = 760;
  const height = 320;
  const plot = { x: 62, y: 20, width: 678, height: 240 };
  const values = spec.datasets.flatMap((dataset) => dataset.data);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const y = (value: number) => plot.y + ((max - value) / range) * plot.height;
  const baseline = y(0);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max - (range * index) / 4;
    const py = y(value);
    return `<line x1="${plot.x}" y1="${py}" x2="${plot.x + plot.width}" y2="${py}" class="chart-grid"/><text x="${plot.x - 10}" y="${py + 4}" text-anchor="end" class="chart-axis-label">${escapeHtml(Number(value.toFixed(2)))}</text>`;
  }).join('');
  const step = plot.width / spec.labels.length;
  const xLabels = spec.labels.map((label, index) =>
    `<text x="${plot.x + step * (index + 0.5)}" y="${plot.y + plot.height + 27}" text-anchor="middle" class="chart-axis-label">${escapeHtml(label.length > 14 ? `${label.slice(0, 13)}…` : label)}</text>`,
  ).join('');

  let marks = '';
  if (spec.type === 'bar') {
    const groupWidth = Math.min(step * 0.72, 72);
    const barWidth = groupWidth / spec.datasets.length;
    marks = spec.datasets.flatMap((dataset, datasetIndex) => dataset.data.map((value, index) => {
      const px = plot.x + step * index + (step - groupWidth) / 2 + datasetIndex * barWidth;
      const py = Math.min(y(value), baseline);
      const barHeight = Math.max(1, Math.abs(y(value) - baseline));
      return `<rect x="${px}" y="${py}" width="${Math.max(2, barWidth - 3)}" height="${barHeight}" rx="4" fill="${COLORS[datasetIndex % COLORS.length]}" class="chart-bar"><title>${escapeHtml(`${spec.labels[index]} · ${dataset.label ?? 'Value'}: ${value}`)}</title></rect>`;
    })).join('');
  } else {
    marks = spec.datasets.map((dataset, datasetIndex) => {
      const color = COLORS[datasetIndex % COLORS.length];
      const points = dataset.data.map((value, index) => `${plot.x + step * (index + 0.5)},${y(value)}`).join(' ');
      const dots = dataset.data.map((value, index) => `<circle cx="${plot.x + step * (index + 0.5)}" cy="${y(value)}" r="4" fill="${color}"><title>${escapeHtml(`${spec.labels[index]} · ${dataset.label ?? 'Value'}: ${value}`)}</title></circle>`).join('');
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
    }).join('');
  }
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(spec.title ?? `${spec.type} chart`)}">${grid}<line x1="${plot.x}" y1="${baseline}" x2="${plot.x + plot.width}" y2="${baseline}" class="chart-axis"/>${marks}${xLabels}</svg>`;
}

function pieChart(spec: ChartSpec): string {
  const values = spec.datasets[0].data.map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return '';
  let angle = -Math.PI / 2;
  const paths = values.map((value, index) => {
    const start = angle;
    angle += (value / total) * Math.PI * 2;
    const end = angle;
    const point = (a: number) => `${190 + Math.cos(a) * 112} ${150 + Math.sin(a) * 112}`;
    const path = `M 190 150 L ${point(start)} A 112 112 0 ${end - start > Math.PI ? 1 : 0} 1 ${point(end)} Z`;
    return `<path d="${path}" fill="${COLORS[index % COLORS.length]}" class="chart-slice"><title>${escapeHtml(`${spec.labels[index]}: ${value} (${((value / total) * 100).toFixed(1)}%)`)}</title></path>`;
  }).join('');
  const labels = spec.labels.map((label, index) => `<span><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(label)} · ${escapeHtml(values[index])}</span>`).join('');
  return `<div class="kory-chart-pie"><svg viewBox="0 0 380 300" role="img" aria-label="${escapeHtml(spec.title ?? 'Pie chart')}">${paths}<circle cx="190" cy="150" r="55" class="chart-donut-hole"/></svg><div class="kory-chart-legend kory-chart-pie-legend">${labels}</div></div>`;
}

export function renderKoryChart(source: string): string | null {
  const spec = parseSpec(source);
  if (!spec) return null;
  const graphic = spec.type === 'pie' ? pieChart(spec) : cartesianChart(spec);
  if (!graphic) return null;
  return `<figure class="kory-chart"><figcaption>${escapeHtml(spec.title ?? `${spec.type[0].toUpperCase()}${spec.type.slice(1)} chart`)}</figcaption>${graphic}${spec.type === 'pie' ? '' : legend(spec)}</figure>`;
}
