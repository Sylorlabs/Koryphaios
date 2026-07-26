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

let miss=0;
for (let i=1;i<=20;i++) {
  const tempDir = await mkdtemp(join(tmpdir(),'cde-'));
  const proactiveConfig = {
    enabled: true,
    workspaceRoot: tempDir,
    fileWatching: { enabled: true, debounceMs: 100, watchPatterns: ['**/*.ts','**/*.js'], ignorePatterns:['node_modules/**'] },
    buildProcessMonitoring: { enabled:true, buildCommands:['tsc'], watchConfigFiles:true, autoRestartBuilds:false },
    compilationMonitoring: { enabled:true, languages:['typescript','javascript'], watchTsConfig:true, watchPackageJson:true },
    realTimeAnalysis: { enabled:true, analysisDelay:100, maxConcurrentAnalysis:2 },
  };

  const dm = new ErrorDetectorManager({config:testConfig, workspaceRoot:tempDir, proactiveMonitoring:proactiveConfig});
  const c = new ProactiveMonitoringCoordinator(dm, proactiveConfig);

  let coordE=0, coordP=0, coordT=0;
  let unifiedE=0, unifiedP=0, unifiedT=0;
  c.on('eslint-config-changed', ()=>coordE++);
  c.on('package-json-changed', ()=>coordP++);
  c.on('tsconfig-changed', ()=>coordT++);

  await c.start();

  c.unifiedFileWatcher?.on('config-changed', e => {
    if (e.relativePath.includes('.eslintrc.json')) unifiedE++;
    if (e.relativePath.includes('package.json')) unifiedP++;
    if (e.relativePath.includes('tsconfig.json')) unifiedT++;
  });

  await writeFile(join(tempDir, 'tsconfig.json'), '{}');
  await writeFile(join(tempDir, 'package.json'), '{}');
  await writeFile(join(tempDir, '.eslintrc.json'), '{}');

  await new Promise(r=>setTimeout(r,500));
  await c.stop();

  if (!coordE || !coordP || !coordT || !unifiedE) {
    miss++;
    console.log('MISS', i, {coord:{t:coordT,p:coordP,e:coordE}, unified:{t:unifiedT,p:unifiedP,e:unifiedE}});
  }

  await rm(tempDir,{recursive:true, force:true});
}
console.log('miss', miss);
