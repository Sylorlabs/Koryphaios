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
    // WebKitGTK can retain a half-updated Svelte DOM runtime after a component
    // hot swap (`next_sibling_getter` becomes undefined). The native launcher
    // sets KORYPHAIOS_DESKTOP_DEV, so use Vite's safe full-page reload there.
    // Browser development keeps normal component HMR.
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
