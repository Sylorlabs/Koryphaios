<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  interface Props {
    siteKey: string;
  }

  let { siteKey }: Props = $props();
  let container = $state<HTMLElement | null>(null);
  let widgetId = $state<string | null>(null);
  let ready = $state<Promise<void> | null>(null);
  let resolveToken: ((token: string) => void) | null = null;
  let rejectToken: ((error: Error) => void) | null = null;

  function loadScript(): Promise<void> {
    if (window.turnstile) return Promise.resolve();
    const existing = document.querySelector<HTMLScriptElement>('script[data-kory-turnstile]');
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Human verification could not load.')), {
          once: true,
        });
      });
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.koryTurnstile = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Human verification could not load.'));
      document.head.append(script);
    });
  }

  async function render(): Promise<void> {
    if (!siteKey || !container || widgetId || !window.turnstile) return;
    widgetId = window.turnstile.render(container, {
      sitekey: siteKey,
      size: 'invisible',
      execution: 'execute',
      action: 'feedback',
      callback: (token: string) => {
        resolveToken?.(token);
        resolveToken = null;
        rejectToken = null;
      },
      'error-callback': () => {
        rejectToken?.(new Error('Human verification failed. Please try again.'));
        resolveToken = null;
        rejectToken = null;
      },
      'expired-callback': () => {
        rejectToken?.(new Error('Human verification expired. Please try again.'));
        resolveToken = null;
        rejectToken = null;
      },
    });
  }

  onMount(() => {
    if (!siteKey) return;
    ready = loadScript().then(render);
  });

  onDestroy(() => {
    if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
  });

  export async function execute(): Promise<string> {
    if (!siteKey) return '';
    await ready;
    await render();
    if (!widgetId || !window.turnstile) throw new Error('Human verification is unavailable.');
    return new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
      window.turnstile?.execute(widgetId!);
    });
  }

  export function reset() {
    if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
  }
</script>

<div bind:this={container} aria-hidden="true"></div>
