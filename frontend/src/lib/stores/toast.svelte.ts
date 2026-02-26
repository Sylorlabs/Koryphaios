// Toast notification store — Svelte 5 runes

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  onRetry?: () => void;
}

let toasts = $state<Toast[]>([]);
let idCounter = 0;

function add(type: ToastType, message: string, duration = 4000, onRetry?: () => void) {
  const id = `toast-${++idCounter}`;
  toasts = [...toasts, { id, type, message, duration, onRetry }];
  setTimeout(() => dismiss(id), duration);
}

function dismiss(id: string) {
  toasts = toasts.filter(t => t.id !== id);
}

export const toastStore = {
  get toasts() { return toasts; },
  success: (msg: string) => add('success', msg),
  error: (msg: string, options?: { duration?: number; onRetry?: () => void }) =>
    add('error', msg, options?.duration ?? 6000, options?.onRetry),
  info: (msg: string) => add('info', msg),
  warning: (msg: string) => add('warning', msg, 5000),
  dismiss,
};
