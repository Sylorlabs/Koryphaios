import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { ProactiveMonitoringCoordinator } from '@/monitoring/proactive-monitoring-coordinator.js';

const tempDir = await mkdtemp(join(tmpdir(), 'proactive-debug-'));

const testConfig = {
  enabled: true,
  realTime: true,
  sources: {
    console: true,
    runtime: true,
    build: true,
    test: true,
    linter: true,
    staticAnalysis: true,
    ide: true,
  },
  filters: {
    categories: [],
    severities: [],
    excludeFiles: ['node_modules/**'],
    excludePatterns: ['*.min.js'],
  },
  polling: {
    interval: 1000,
    maxRetries: 3,
  },
  bufferSize: 100,
  maxErrorsPerSession: 50,
};

const proactiveConfig = {
  enabled: true,
  workspaceRoot: tempDir,
  fileWatching: {
    enabled: true,
    debounceMs: 100,
    watchPatterns: ['**/*.ts', '**/*.js'],
    ignorePatterns: ['node_modules/**'],
  },
  buildProcessMonitoring: {
    enabled: true,
    buildCommands: ['tsc'],
    watchConfigFiles: true,
    autoRestartBuilds: false,
  },
  compilationMonitoring: {
    enabled: true,
    languages: ['typescript', 'javascript'],
    watchTsConfig: true,
    watchPackageJson: true,
  },
  realTimeAnalysis: {
    enabled: true,
    analysisDelay: 100,
    maxConcurrentAnalysis: 2,
  },
};

const detectorManager = new ErrorDetectorManager({
  config: testConfig,
  workspaceRoot: tempDir,
  proactiveMonitoring: proactiveConfig,
});

const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);

for (const ev of [
  'file-changed','file-added','file-deleted','config-changed',
  'source-file-changed','test-file-changed','config-file-changed',
  'typescript-file-changed','javascript-file-changed','tsconfig-changed','package-json-changed','eslint-config-changed',
  'file-batch-processed',
]) {
  coordinator.on(ev, payload => {
    console.log('EVENT', ev, payload?.relativePath || payload?.path || payload);
  });
}

await coordinator.start();

await writeFile(join(tempDir, 'tsconfig.json'), '{"a":1}');
await writeFile(join(tempDir, 'package.json'), '{"name":"x"}');
await writeFile(join(tempDir, '.eslintrc.json'), '{"a":1}');

await new Promise(r => setTimeout(r, 1200));
await coordinator.stop();
await rm(tempDir, { recursive: true, force: true });
