import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'benchmarks/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/index.ts',
      ],
      thresholds: {
        global: {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@/types': resolve(__dirname, './src/types'),
      '@/utils': resolve(__dirname, './src/utils'),
      '@/server': resolve(__dirname, './src/server'),
      '@/detectors': resolve(__dirname, './src/detectors'),
      '@/analyzers': resolve(__dirname, './src/analyzers'),
      '@/debuggers': resolve(__dirname, './src/debuggers'),
      '@/diagnostics': resolve(__dirname, './src/diagnostics'),
      '@/integrations': resolve(__dirname, './src/integrations'),
    },
  },
});
