import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedFileWatcher } from '@/monitoring/unified-file-watcher.js';

const dir = await mkdtemp(join(tmpdir(),'u4x-'));
const w = UnifiedFileWatcher.createDefault(dir);
w.on('file-changed', e => console.log('file', e.relativePath, e.type, e.category, e.extension));
w.on('config-changed', e => console.log('cfg', e.relativePath, e.type, e.category));
await w.start();
await new Promise(r=>setTimeout(r,50));
await writeFile(join(dir,'.eslintrc.json'),'{}');
await new Promise(r=>setTimeout(r,800));
await w.stop();
await rm(dir,{recursive:true, force:true});
