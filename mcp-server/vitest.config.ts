import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const sourceRoot = import.meta.dirname;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Several integration suites intentionally launch real compilers, linters,
    // and file watchers. Bound parallelism so a many-core workstation cannot
    // turn one test run into dozens of competing process trees.
    maxWorkers: 4,
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
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': resolve(sourceRoot, './src'),
      '@/types': resolve(sourceRoot, './src/types'),
      '@/utils': resolve(sourceRoot, './src/utils'),
      '@/server': resolve(sourceRoot, './src/server'),
      '@/detectors': resolve(sourceRoot, './src/detectors'),
      '@/analyzers': resolve(sourceRoot, './src/analyzers'),
      '@/debuggers': resolve(sourceRoot, './src/debuggers'),
      '@/diagnostics': resolve(sourceRoot, './src/diagnostics'),
      '@/integrations': resolve(sourceRoot, './src/integrations'),
    },
  },
});
