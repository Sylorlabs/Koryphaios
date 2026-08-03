import { toastStore } from '$lib/stores/toast.svelte';

let activeImageSource: string | null = null;

/**
 * Records the most recently opened image preview. The image shortcut deliberately
 * acts on that explicit preview, rather than guessing from unrelated UI icons.
 */
export function setActiveClipboardImage(source: string): void {
  activeImageSource = source;
}

export async function copyActiveClipboardImage(): Promise<void> {
  if (!activeImageSource) {
    toastStore.error('Open an image preview before copying it');
    return;
  }

  try {
    const response = await fetch(activeImageSource);
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const blob = await response.blob();

    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeImage(new Uint8Array(await blob.arrayBuffer()));
    } else if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    } else {
      throw new Error('Image clipboard support is unavailable');
    }

    toastStore.success('Image copied to clipboard');
  } catch (error) {
    console.error('[clipboard-shortcuts] image copy failed:', error);
    toastStore.error('Could not copy the image');
  }
}
