import bunAdapter from 'svelte-adapter-bun';
import staticAdapter from '@sveltejs/adapter-static';

const isStaticBuild = process.env.BUILD_MODE === 'static' || process.env.TAURI_BUILD;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Generate compatible code for older WebKit (Tauri on Linux)
		compatibility: {
			componentApi: 4
		},
		// Disable modern JavaScript features that older WebKit doesn't support
		css: 'injected',
		// Don't use modern JS features
		generate: 'client',
	},
	kit: {
		adapter: isStaticBuild 
			? staticAdapter({
				pages: 'build',
				assets: 'build',
				fallback: 'index.html',
				precompress: false,
			})
			: bunAdapter({
				out: 'build',
				precompress: true,
			}),
		alias: {
			'@koryphaios/shared': '../shared/src/index.ts',
		}
	}
};

export default config;
