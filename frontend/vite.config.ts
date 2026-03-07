import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadBackendTargetFromConfig(): string {
	// First check environment variable
	if (process.env.KORYPHAIOS_PORT) {
		return `http://127.0.0.1:${process.env.KORYPHAIOS_PORT}`;
	}

	// Then check config files
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
			const port = parsed.server?.port || 3000;
			return `http://${host}:${port}`;
		} catch {
			// Ignore invalid local config and fall back.
		}
	}

	// Default fallback
	return 'http://127.0.0.1:3000';
}

const target = loadBackendTargetFromConfig();
const wsBase = target.replace(/^http/, 'ws');
const wsTarget = wsBase.endsWith('/ws') ? wsBase : `${wsBase}/ws`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
	],
	server: {
		host: '0.0.0.0',
		fs: {
			// Allow serving files from the shared workspace
			allow: [
				'..',
				'../..',
			],
		},
		proxy: {
			'/api': { target, changeOrigin: true },
			'/ws': { target: wsTarget, ws: true, changeOrigin: true },
		},
	},
	define: {
		'import.meta.env.VITE_BACKEND_URL': JSON.stringify(target),
		'import.meta.env.VITE_BACKEND_WS_URL': JSON.stringify(wsTarget),
	},
	// Transpilation settings for older WebKit (Tauri on Linux)
	build: {
		target: 'es2015',
		minify: true,
		sourcemap: true,
	},
	esbuild: {
		target: 'es2015',
	},
	optimizeDeps: {
		esbuildOptions: {
			target: 'es2015',
		},
	},
});
