import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { ProactiveMonitoringCoordinator } from '@/monitoring/proactive-monitoring-coordinator.js';

const testConfig = {
  enabled: true,
  realTime: true,
  sources: { console: true, runtime: true, build: true, test: true, linter: true, staticAnalysis: true, ide: true },
  filters: { categories: [], severities: [], excludeFiles: ['node_modules/**'], excludePatterns: ['*.min.js'] },
  polling: { interval: 1000, maxRetries: 3 },
  bufferSize: 100,
  maxErrorsPerSession: 50,
};

const tempDir = await mkdtemp(join(tmpdir(),'watch-test-'));
const proactiveConfig = {
  enabled: true,
  workspaceRoot: tempDir,
  fileWatching: { enabled: true, debounceMs: 100, watchPatterns: ['**/*.ts','**/*.js'], ignorePatterns:['node_modules/**'] },
  buildProcessMonitoring: { enabled: true, buildCommands: ['tsc'], watchConfigFiles: true, autoRestartBuilds: false },
  compilationMonitoring: { enabled: true, languages: ['typescript','javascript'], watchTsConfig: true, watchPackageJson: true },
  realTimeAnalysis: { enabled: true, analysisDelay: 100, maxConcurrentAnalysis: 2 },
};

const dm = new ErrorDetectorManager({config: testConfig, workspaceRoot: tempDir, proactiveMonitoring: proactiveConfig});
const c = new ProactiveMonitoringCoordinator(dm, proactiveConfig);

let src=0, test=0, cfg=0, conf=0, pkg=0, eslint=0;
c.on('source-file-changed', () => src++);
c.on('test-file-changed', () => test++);
c.on('config-file-changed', () => conf++);
c.on('tsconfig-changed', () => cfg++);
c.on('package-json-changed', () => pkg++);
c.on('eslint-config-changed', () => eslint++);

await c.start();

await writeFile(join(tempDir, 'source.ts'), 'export {}');
await writeFile(join(tempDir, 'test.spec.ts'), 'describe("",()=>{})');
await writeFile(join(tempDir, 'tsconfig.json'), '{"compilerOptions":{}}');
await new Promise(r => setTimeout(r, 1200));
console.log('beforeStop', {src,test,cfg,pkg,conf,eslint});
await c.stop();
console.log('afterStop', {src,test,cfg,pkg,conf,eslint});
await rm(tempDir, {recursive:true, force:true});
