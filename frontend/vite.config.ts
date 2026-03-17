import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PortInfo {
	port: number;
	host: string;
	url: string;
	timestamp: number;
	pid: number;
}

function loadBackendTargetFromConfig(): string {
	// Priority 1: Environment variable (highest priority)
	if (process.env.KORYPHAIOS_PORT) {
		console.log(`[vite] Using backend port from KORYPHAIOS_PORT: ${process.env.KORYPHAIOS_PORT}`);
		return `http://127.0.0.1:${process.env.KORYPHAIOS_PORT}`;
	}

	// Priority 2: Active port file (written by backend when using dynamic port)
	const portFilePaths = [
		resolve(process.cwd(), '.koryphaios', '.active-port.json'),
		resolve(process.cwd(), '..', '.koryphaios', '.active-port.json'),
	];
	
	for (const portFile of portFilePaths) {
		if (!existsSync(portFile)) continue;
		try {
			const raw = readFileSync(portFile, 'utf-8');
			const info = JSON.parse(raw) as PortInfo;
			// Check if port info is fresh (within last 5 minutes)
			if (Date.now() - info.timestamp < 5 * 60 * 1000) {
				console.log(`[vite] Using backend port from active-port.json: ${info.port}`);
				return info.url;
			}
		} catch {
			// Ignore invalid port file
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
			const port = parsed.server?.port || 29473;
			console.log(`[vite] Using backend port from ${path}: ${port}`);
			return `http://${host}:${port}`;
		} catch {
			// Ignore invalid local config and fall back.
		}
	}

	// Priority 4: Default fallback
	console.log('[vite] Using default backend port: 29473');
	return 'http://127.0.0.1:29473';
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
