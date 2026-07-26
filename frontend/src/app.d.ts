// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // Vite environment variables
  interface ImportMetaEnv {
    readonly VITE_BACKEND_URL?: string;
    readonly VITE_BACKEND_WS_URL?: string;
    /** Public Cloudflare Turnstile site key. Safe to ship in the desktop bundle. */
    readonly VITE_TURNSTILE_SITE_KEY?: string;
    readonly DEV?: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface CloudflareTurnstileApi {
    render: (container: HTMLElement, options: Record<string, unknown>) => string;
    execute: (widgetId: string) => void;
    reset: (widgetId: string) => void;
    remove: (widgetId: string) => void;
  }

  interface Window {
    turnstile?: CloudflareTurnstileApi;
  }

  // Build-time constants injected by vite.config.ts (define). Used by the
  // backend-health sentinel to evaluate the backend /api/health compat block.
  // Both default to 'dev'/null when no compat-hash.json is present (dev mode).
  const __KORYPHAIOS_FRONTEND_VERSION__: string | undefined;
  const __KORYPHAIOS_FRONTEND_BUNDLE_HASH__: string | undefined;
}

export {};
