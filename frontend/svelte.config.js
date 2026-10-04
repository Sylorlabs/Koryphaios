import bunAdapter from 'svelte-adapter-bun';
import staticAdapter from '@sveltejs/adapter-static';

const isStaticBuild =
  process.env.BUILD_MODE === 'static' ||
  process.env.TAURI_BUILD ||
  // Tauri v2 injects TAURI_ENV_* into beforeBuildCommand — cross-platform,
  // no shell env-prefix needed (that broke Windows cmd.exe).
  !!process.env.TAURI_ENV_PLATFORM;
const isDesktopDev = process.env.KORYPHAIOS_DESKTOP_DEV === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Svelte 5 with runes support
    css: 'injected',
    // The native shell loads a Vite dev server, and a component-level hot swap
    // in WKWebView can leave a half-updated DOM runtime. The native launcher
    // sets KORYPHAIOS_DESKTOP_DEV, so compile without HMR boundaries there and
    // let Vite fall back to a full page reload. Browser development keeps
    // normal component HMR.
    //
    // Note: this is NOT what caused "next_sibling_getter.call" failures. That
    // error comes from two Vite servers sharing one node_modules/.vite cache —
    // see frontend/vite.config.ts cacheDir and the dev-server reaper in
    // scripts/desktop-frontend-reaper.ts.
    ...(isDesktopDev ? { hmr: false } : {}),
  },
  kit: {
    adapter: isStaticBuild
      ? staticAdapter({
          pages: 'build/client',
          assets: 'build/client',
          fallback: 'index.html',
          precompress: false,
        })
      : bunAdapter({
          out: 'build',
          precompress: true,
        }),
    alias: {
      '@koryphaios/shared': '../shared/src/index.ts',
    },
    // Demo embed on koryphaios.com is served under /demo-app; a base path makes
    // all asset URLs resolve there. Empty for the normal desktop build.
    paths: process.env.DEMO_BASE ? { base: process.env.DEMO_BASE } : {},
  },
};

export default config;
