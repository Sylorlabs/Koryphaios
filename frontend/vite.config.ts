import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadBackendTargetFromConfig() {
	const configPaths = [
		resolve(process.cwd(), 'koryphaios.json'),
		resolve(process.cwd(), '..', 'koryphaios.json'),
	];

	for (const path of configPaths) {
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, 'utf-8');
			const parsed = JSON.parse(raw) as { server?: { host?: string; port?: number } };
			const host = parsed.server?.host?.trim();
			const port = parsed.server?.port;
			if (host && typeof port === 'number') {
				return `http://${host}:${port}`;
			}
		} catch {
			// Ignore invalid local config and fall back.
		}
	}

	return null;
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '0.0.0.0',
		proxy: (() => {
			const target = loadBackendTargetFromConfig() ?? 'http://127.0.0.1:3001';
			const wsTarget = target.replace(/^http/, 'ws');
			return {
				'/api': { target, changeOrigin: true },
				'/ws': { target: wsTarget, ws: true, changeOrigin: true },
			};
		})(),
	},
	define: (() => {
		const target = loadBackendTargetFromConfig() ?? 'http://127.0.0.1:3001';
		const wsBase = target.replace(/^http/, 'ws');
		const wsTarget = wsBase.endsWith('/ws') ? wsBase : `${wsBase}/ws`;
		return { 'import.meta.env.VITE_BACKEND_WS_URL': JSON.stringify(wsTarget) };
	})(),
});
