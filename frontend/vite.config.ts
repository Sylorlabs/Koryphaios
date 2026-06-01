import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadBackendTargetFromConfig(): string {
  // Priority 1: Environment variable
  if (process.env.KORYPHAIOS_PORT) {
    return `http://127.0.0.1:${process.env.KORYPHAIOS_PORT}`;
  }

  // Priority 2: Active port file (backend writes this when using dynamic port)
  const activePortPaths = [
    resolve(process.cwd(), '.koryphaios', '.active-port.json'),
    resolve(process.cwd(), '..', '.koryphaios', '.active-port.json'),
  ];

  for (const path of activePortPaths) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as {
        url?: string;
        port?: number;
        host?: string;
        timestamp?: number;
      };
      // Ignore stale files older than 5 minutes
      if (parsed.timestamp && Date.now() - parsed.timestamp > 5 * 60 * 1000) continue;
      if (parsed.url) return parsed.url;
      if (parsed.port) {
        const host = parsed.host?.trim() || '127.0.0.1';
        return `http://${host}:${parsed.port}`;
      }
    } catch {
      // Ignore invalid active-port file and fall back.
    }
  }

  // Priority 3: Config files
  const configPaths = [
    resolve(process.cwd(), 'koryphaios.json'),
    resolve(process.cwd(), '..', 'koryphaios.json'),
  ];

  for (const path of configPaths) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as { server?: { host?: string; port?: number } };
      const host = parsed.server?.host?.trim() || '127.0.0.1';
      const port = parsed.server?.port || 3001;
      return `http://${host}:${port}`;
    } catch {
      // Ignore invalid local config and fall back.
    }
  }

  return 'http://127.0.0.1:3001';
}

const target = loadBackendTargetFromConfig();
const wsBase = target.replace(/^http/, 'ws');
const wsTarget = wsBase.endsWith('/ws') ? wsBase : `${wsBase}/ws`;

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: '0.0.0.0',
    fs: {
      // Allow serving files from the shared workspace
      allow: ['..', '../..'],
    },
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: wsBase, ws: true, changeOrigin: true },
    },
  },
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(target),
    'import.meta.env.VITE_BACKEND_WS_URL': JSON.stringify(wsTarget),
  },
  // Build settings - use ES2020 for Svelte 5 runes support
  build: {
    target: 'es2020',
    minify: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('monaco-editor')) return 'monaco';
          if (id.includes('@tauri-apps')) return 'tauri';
          if (id.includes('lucide-svelte')) return 'icons';
          if (
            id.includes('marked') ||
            id.includes('highlight.js') ||
            id.includes('diff-match-patch')
          ) {
            return 'text-tools';
          }
        },
      },
    },
  },
  esbuild: {
    target: 'es2020',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2020',
    },
  },
});
