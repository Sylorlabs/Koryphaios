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

for (let i=0;i<5;i++) {
  const tempDir = await mkdtemp(join(tmpdir(),'seq-'));
  const proactiveConfig = {
    enabled: true,
    workspaceRoot: tempDir,
    fileWatching: { enabled: true, debounceMs: 100, watchPatterns: ['**/*.ts','**/*.js'], ignorePatterns:['node_modules/**'] },
    buildProcessMonitoring: { enabled: true, buildCommands:['tsc'], watchConfigFiles: true, autoRestartBuilds:false },
    compilationMonitoring: { enabled: true, languages:['typescript','javascript'], watchTsConfig:true, watchPackageJson:true },
    realTimeAnalysis: { enabled: true, analysisDelay:100, maxConcurrentAnalysis:2 },
  };

  const dm = new ErrorDetectorManager({config:testConfig, workspaceRoot:tempDir, proactiveMonitoring:proactiveConfig});
  const first = new ProactiveMonitoringCoordinator(dm, proactiveConfig);
  let source=0,test=0,config=0;
  first.on('source-file-changed', ()=>source++);
  first.on('test-file-changed', ()=>test++);
  first.on('config-file-changed', ()=>config++);
  await first.start();
  await writeFile(join(tempDir,'source1.ts'), 'x');
  await writeFile(join(tempDir,'source2.ts'), 'x');
  await writeFile(join(tempDir,'source3.ts'), 'x');
  await new Promise(r=>setTimeout(r,1500));
  console.log('FIRST', i, {source,test,config});
  await first.stop();
  await dm.stop();

  const dm2 = new ErrorDetectorManager({config:testConfig, workspaceRoot:tempDir, proactiveMonitoring:proactiveConfig});
  const second = new ProactiveMonitoringCoordinator(dm2, proactiveConfig);
  let cfg2=0,s2=0,t2=0;
  second.on('source-file-changed', ()=>s2++);
  second.on('test-file-changed', ()=>t2++);
  second.on('config-file-changed', ()=>cfg2++);
  let ts=0,p=0,e=0;
  second.on('tsconfig-changed', ()=>ts++);
  second.on('package-json-changed', ()=>p++);
  second.on('eslint-config-changed', ()=>e++);

  await second.start();
  await writeFile(join(tempDir,'source.ts'), '1');
  await writeFile(join(tempDir,'test.spec.ts'), '2');
  await writeFile(join(tempDir,'tsconfig.json'), '{}');
  await new Promise(r=>setTimeout(r,600));
  console.log('SECOND-cat', i, {s2,t2,cfg2,ts,p,e});

  await writeFile(join(tempDir,'package.json'), '{}');
  await writeFile(join(tempDir,'.eslintrc.json'), '{}');
  await new Promise(r=>setTimeout(r,600));
  console.log('SECOND-conf', i, {s2,t2,cfg2,ts,p,e});

  await second.stop();
  await dm2.stop();
  await rm(tempDir,{recursive:true,force:true});
}
