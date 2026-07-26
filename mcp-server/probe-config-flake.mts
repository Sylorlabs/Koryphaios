import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { ProactiveMonitoringCoordinator } from '@/monitoring/proactive-monitoring-coordinator.js';

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

let misses = 0;
const loops = 120;
for (let i=1;i<=loops;i++) {
  const tempDir = await mkdtemp(join(tmpdir(), 'cfg-flake-'));

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

  const detectorManager = new ErrorDetectorManager({config:testConfig, workspaceRoot: tempDir, proactiveMonitoring: proactiveConfig});
  const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
  let t = 0, p = 0, e = 0;
  coordinator.on('tsconfig-changed', ()=>t++);
  coordinator.on('package-json-changed', ()=>p++);
  coordinator.on('eslint-config-changed', ()=>e++);

  await coordinator.start();

  await writeFile(join(tempDir, 'tsconfig.json'), '{}');
  await writeFile(join(tempDir, 'package.json'), '{"name":"x"}');
  await writeFile(join(tempDir, '.eslintrc.json'), '{"a":1}');

  await new Promise(r=>setTimeout(r, 500));

  await coordinator.stop();

  if (!t || !p || !e) {
    misses++;
    console.log('MISS', i, {t,p,e});
  }

  await rm(tempDir, {recursive:true, force:true});
}
console.log('done', misses, 'misses of', loops);
