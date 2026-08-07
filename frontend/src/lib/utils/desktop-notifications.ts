/**
 * Desktop OS notifications (Tauri) — only meaningful, human-readable alerts.
 *
 * Never posts internal wire-protocol names (e.g. `agent.completed`,
 * `stream.complete`) into the notification body. Those look like debug dump
 * text in the system notification center and confuse users.
 */

import { browser } from '$app/environment';

const INTERNAL_EVENT_TYPE =
  /^(agent|stream|system|session|kory|native|permission|process|context|goals)\.[\w.]+$/;

let permissionReady: Promise<boolean> | null = null;
let lastSentAt = 0;
let lastSentKey = '';

function isTauri(): boolean {
  if (!browser) return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

function isWindowFocused(): boolean {
  if (!browser) return true;
  try {
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch (err: unknown) {
    console.debug('Failed to check window focus state:', err instanceof Error ? err.message : String(err));
    return true;
  }
}

/** True when text is a dump of internal event-type names, not user copy. */
export function isInternalEventTypeDump(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  // Single event type, or comma/space-separated list of them.
  const parts = raw
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => INTERNAL_EVENT_TYPE.test(p));
}

async function ensurePermission(): Promise<boolean> {
  if (!isTauri()) return false;
  if (!permissionReady) {
    permissionReady = (async () => {
      try {
        const {
          isPermissionGranted,
          requestPermission,
        } = await import('@tauri-apps/plugin-notification');
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === 'granted';
      } catch (err: unknown) {
        console.debug('Failed to request notification permission:', err instanceof Error ? err.message : String(err));
        return false;
      }
    })();
  }
  return permissionReady;
}

export type DesktopNotifyOpts = {
  title: string;
  body: string;
  /** Dedup key; suppresses identical alerts within the cooldown window. */
  key?: string;
  /** Skip when the app window is focused (default true). */
  onlyWhenUnfocused?: boolean;
  /** Min ms between identical keys (default 8s). */
  cooldownMs?: number;
};

/**
 * Show a desktop notification with human-readable title/body.
 * Silently no-ops when permission is denied, not in Tauri, body looks like
 * an internal event dump, or the window is focused (unless overridden).
 */
export async function notifyDesktop(opts: DesktopNotifyOpts): Promise<void> {
  const title = opts.title.trim();
  const body = opts.body.trim();
  if (!title || !body) return;
  if (isInternalEventTypeDump(title) || isInternalEventTypeDump(body)) return;
  if ((opts.onlyWhenUnfocused ?? true) && isWindowFocused()) return;

  const key = opts.key ?? `${title}\0${body}`;
  const cooldown = opts.cooldownMs ?? 8_000;
  const now = Date.now();
  if (key === lastSentKey && now - lastSentAt < cooldown) return;

  if (!(await ensurePermission())) return;

  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ title, body });
    lastSentKey = key;
    lastSentAt = now;
  } catch (err: unknown) {
    // Plugin unavailable or OS blocked the post — never surface as a toast.
    console.debug('Failed to send desktop notification:', err instanceof Error ? err.message : String(err));
  }
}

/** Notify when Kory finished a turn the user may have stepped away from. */
export function notifyAgentFinished(summary?: string): void {
  const body =
    summary?.trim() && !isInternalEventTypeDump(summary)
      ? summary.trim().slice(0, 180)
      : 'Kory finished working. Open the app to review the result.';
  void notifyDesktop({
    title: 'Kory finished',
    body,
    key: 'agent-finished',
    cooldownMs: 12_000,
  });
}

/** Notify when the agent needs the user (permission, question, approval). */
export function notifyNeedsAttention(reason: string): void {
  const body =
    reason?.trim() && !isInternalEventTypeDump(reason)
      ? reason.trim().slice(0, 180)
      : 'Kory is waiting for your input.';
  void notifyDesktop({
    title: 'Kory needs your attention',
    body,
    key: `needs-attention:${body}`,
    cooldownMs: 6_000,
  });
}
