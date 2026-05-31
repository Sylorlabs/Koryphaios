import bunAdapter from 'svelte-adapter-bun';
import staticAdapter from '@sveltejs/adapter-static';

const isStaticBuild = process.env.BUILD_MODE === 'static' || process.env.TAURI_BUILD;

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Svelte 5 with runes support
    css: 'injected',
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
  },
};

export default config;
