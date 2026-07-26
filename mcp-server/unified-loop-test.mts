import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedFileWatcher } from '@/monitoring/unified-file-watcher.js';

let misses = 0;
for (let i=1;i<=40;i++) {
  const dir = await mkdtemp(join(tmpdir(),'ufwloop-'));
  const w = UnifiedFileWatcher.createDefault(dir);
  let e=false,p=false,t=false;
  w.on('config-changed', event => {
    if (event.relativePath.includes('.eslintrc')) e = true;
    if (event.relativePath.includes('package.json')) p = true;
    if (event.relativePath.includes('tsconfig.json')) t = true;
  });
  await w.start();
  await new Promise(r=>setTimeout(r,50));
  await writeFile(join(dir,'tsconfig.json'),'{}');
  await writeFile(join(dir,'package.json'),'{}');
  await writeFile(join(dir,'.eslintrc.json'),'{}');
  await new Promise(r=>setTimeout(r,500));
  await w.stop();
  if (!e||!p||!t) {
    misses++;
    console.log('MISS',i,{t,p,e});
  }
  await rm(dir,{recursive:true, force:true});
}
console.log('done misses',misses);
