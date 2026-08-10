/**
 * Cross-environment clipboard text writer.
 *
 * In the Tauri desktop shell, `navigator.clipboard.writeText` can fail
 * silently or be rejected because the webview lacks the secure-context
 * clipboard permission.  When that happens, fall back to the Tauri
 * clipboard-manager plugin which writes through the native OS clipboard.
 *
 * In a regular browser, `navigator.clipboard.writeText` is the only path
 * and the Tauri import is dynamically skipped.
 */
export async function copyText(text: string): Promise<void> {
  // Try the web Clipboard API first — it works in browsers and sometimes
  // in Tauri depending on the platform/webview version.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the Tauri plugin below.
  }

  // Tauri desktop fallback.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  }

  // Last-resort: execCommand on a hidden textarea (legacy browsers).
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
