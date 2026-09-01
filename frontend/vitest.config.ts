import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      '$app/environment': fileURLToPath(new URL('./src/test-app-environment.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 25,
        statements: 25,
      },
      include: ['src/lib/**/*.ts', 'src/lib/**/*.svelte'],
      exclude: [
        'src/lib/**/*.test.ts',
        'src/lib/**/*.d.ts',
        'src/lib/**/__mocks__/**',
        'src/lib/**/*.types.ts',
      ],
    },
    setupFiles: ['./src/test-setup.ts'],
  },
});
