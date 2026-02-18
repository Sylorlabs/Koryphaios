import adapter from 'svelte-adapter-bun';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			out: 'build',
			precompress: true,
		}),
		alias: {
			'@koryphaios/shared': '../shared/src/index.ts',
		}
	}
};

export default config;
