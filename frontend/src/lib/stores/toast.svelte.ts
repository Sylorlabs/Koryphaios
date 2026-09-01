// Toast notification store — Svelte 5 runes

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  onRetry?: () => void;
  actionLabel?: string;
  /** Whether the toast's auto-dismiss timer is currently paused (e.g. on hover). */
  paused?: boolean;
}

let toasts = $state<Toast[]>([]);
let idCounter = 0;

// Track timers and remaining time per toast so we can pause/resume.
const timers = new Map<
  string,
  { timeoutId: ReturnType<typeof setTimeout>; startedAt: number; remaining: number }
>();

function clearTimer(id: string) {
  const entry = timers.get(id);
  if (entry) {
    clearTimeout(entry.timeoutId);
    timers.delete(id);
  }
}

function startTimer(id: string, duration: number) {
  clearTimer(id);
  const timeoutId = setTimeout(() => dismiss(id), duration);
  timers.set(id, { timeoutId, startedAt: Date.now(), remaining: duration });
}

function add(
  type: ToastType,
  message: string,
  duration = 4000,
  onRetry?: () => void,
  actionLabel?: string,
) {
  const id = `toast-${++idCounter}`;
  toasts = [...toasts, { id, type, message, duration, onRetry, actionLabel }];
  startTimer(id, duration);
}

function dismiss(id: string) {
  clearTimer(id);
  toasts = toasts.filter((t) => t.id !== id);
}

function dismissMany(ids: string[]) {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  for (const id of ids) clearTimer(id);
  toasts = toasts.filter((t) => !idSet.has(t.id));
}

function clear() {
  for (const id of timers.keys()) clearTimer(id);
  toasts = [];
}

/** Pause a toast's auto-dismiss timer (e.g. on mouseenter). */
function pause(id: string) {
  const entry = timers.get(id);
  if (!entry) return;
  clearTimeout(entry.timeoutId);
  const elapsed = Date.now() - entry.startedAt;
  entry.remaining = Math.max(entry.remaining - elapsed, 0);
  toasts = toasts.map((t) => (t.id === id ? { ...t, paused: true } : t));
}

/** Resume a paused toast's auto-dismiss timer (e.g. on mouseleave). */
function resume(id: string) {
  const entry = timers.get(id);
  if (!entry) return;
  entry.startedAt = Date.now();
  entry.timeoutId = setTimeout(() => dismiss(id), entry.remaining);
  toasts = toasts.map((t) => (t.id === id ? { ...t, paused: false } : t));
}

export const toastStore = {
  get toasts() {
    return toasts;
  },
  success: (
    msg: string,
    options?: { duration?: number; action?: () => void; actionLabel?: string },
  ) => add('success', msg, options?.duration ?? 4000, options?.action, options?.actionLabel),
  error: (msg: string, options?: { duration?: number; onRetry?: () => void }) =>
    add('error', msg, options?.duration ?? 6000, options?.onRetry),
  info: (msg: string) => add('info', msg),
  warning: (
    msg: string,
    options?: { duration?: number; action?: () => void; actionLabel?: string },
  ) => add('warning', msg, options?.duration ?? 8000, options?.action, options?.actionLabel),
  dismiss,
  dismissMany,
  clear,
  pause,
  resume,
};
