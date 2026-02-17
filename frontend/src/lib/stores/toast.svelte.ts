// Toast notification store — Svelte 5 runes

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

let toasts = $state<Toast[]>([]);
let idCounter = 0;

function add(type: ToastType, message: string, duration = 4000) {
  const id = `toast-${++idCounter}`;
  toasts = [...toasts, { id, type, message, duration }];
  setTimeout(() => dismiss(id), duration);
}

function dismiss(id: string) {
  toasts = toasts.filter(t => t.id !== id);
}

export const toastStore = {
  get toasts() { return toasts; },
  success: (msg: string) => add('success', msg),
  error: (msg: string) => add('error', msg, 6000),
  info: (msg: string) => add('info', msg),
  warning: (msg: string) => add('warning', msg, 5000),
  dismiss,
};
