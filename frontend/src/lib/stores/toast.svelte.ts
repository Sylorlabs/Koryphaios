// Toast notification store — Svelte 5 runes

export type ToastType = 'success' | 'error' | 'info' | 'warning';

/** A button on a toast. Running it dismisses the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

/** Accepted by the success/warning options. A bare function is the older shape. */
export type ToastActionOption = ToastAction | (() => void);

/** Label that marks a toast as reversible. Only these answer the undo shortcut. */
export const UNDO_LABEL = 'Undo';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  onRetry?: () => void;
  /** Label for the retry button; the action button carries its own label. */
  actionLabel?: string;
  action?: ToastAction;
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

function normalizeAction(
  option: ToastActionOption | undefined,
  label: string | undefined,
): ToastAction | undefined {
  if (!option) return undefined;
  if (typeof option === 'function') return { label: label ?? 'Action', run: option };
  return option;
}

/** True when the toast is an undo offer, which the platform undo shortcut may run. */
export function isUndoToast(toast: Toast): boolean {
  return toast.action?.label === UNDO_LABEL;
}

function add(
  type: ToastType,
  message: string,
  duration = 4000,
  onRetry?: () => void,
  action?: ToastAction,
  actionLabel?: string,
) {
  const id = `toast-${++idCounter}`;
  toasts = [...toasts, { id, type, message, duration, onRetry, action, actionLabel }];
  startTimer(id, duration);
}

/** Run a toast's action and dismiss it. Returns false if the toast is gone or has none. */
function runAction(id: string): boolean {
  const toast = toasts.find((t) => t.id === id);
  if (!toast?.action) return false;
  const run = toast.action.run;
  dismiss(id);
  run();
  return true;
}

/** Run the newest undo offer, if any is visible. Used by the undo shortcut. */
function runLatestUndo(): boolean {
  for (let i = toasts.length - 1; i >= 0; i -= 1) {
    if (isUndoToast(toasts[i])) return runAction(toasts[i].id);
  }
  return false;
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
    options?: { duration?: number; action?: ToastActionOption; actionLabel?: string },
  ) =>
    add(
      'success',
      msg,
      options?.duration ?? 4000,
      undefined,
      normalizeAction(options?.action, options?.actionLabel),
      options?.actionLabel,
    ),
  error: (msg: string, options?: { duration?: number; onRetry?: () => void }) =>
    add('error', msg, options?.duration ?? 6000, options?.onRetry),
  info: (msg: string) => add('info', msg),
  warning: (
    msg: string,
    options?: { duration?: number; action?: ToastActionOption; actionLabel?: string },
  ) =>
    add(
      'warning',
      msg,
      options?.duration ?? 8000,
      undefined,
      normalizeAction(options?.action, options?.actionLabel),
      options?.actionLabel,
    ),
  dismiss,
  dismissMany,
  clear,
  pause,
  resume,
  runAction,
  runLatestUndo,
};
