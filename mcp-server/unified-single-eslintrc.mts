import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedFileWatcher } from '@/monitoring/unified-file-watcher.js';

let miss=0;
for (let i=1;i<=20;i++) {
  const dir = await mkdtemp(join(tmpdir(),'u4-'));
  const w = UnifiedFileWatcher.createDefault(dir);
  let e=0;
  w.on('config-changed', ev => { if (ev.relativePath.includes('.eslintrc')) e++; });
  await w.start();
  await new Promise(r=>setTimeout(r,20));
  await writeFile(join(dir,'.eslintrc.json'),'{}');
  await new Promise(r=>setTimeout(r,700));
  await w.stop();
  if (!e) {
    miss++;
    console.log('MISS', i);
  }
  await rm(dir,{recursive:true, force:true});
}
console.log('misses', miss);
