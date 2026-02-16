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

const backendFromConfig = loadBackendTargetFromConfig();
const backendPort = process.env.KORYPHAIOS_PORT ?? '3001';
const backendHttp = process.env.KORY_BACKEND_URL ?? backendFromConfig ?? `http://127.0.0.1:${backendPort}`;
const backendWs = backendHttp.replace(/^http/, 'ws');

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '127.0.0.1',
		proxy: {
			'/api': backendHttp,
			'/ws': {
				target: backendWs,
				ws: true,
			},
		},
	},
});
