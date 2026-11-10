/** Format a millisecond duration with auto-scaling units so a reader never
 *  sees an absurd value like "3000000000.1 s". Mirrors ThinkingBlock's
 *  stopwatch formatting and is shared by tool activity rows. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const remS = Math.round(s % 60);
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = Math.round(m % 60);
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = Math.round(h % 24);
  return `${d}d ${remH}h`;
}
