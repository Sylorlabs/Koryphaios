import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from '@/utils/file-watcher.js';

const dir = await mkdtemp(join(tmpdir(), 'fwatch-'));
const w = FileWatcher.createForConfigFiles(dir);

w.on('change', e=>{ console.log('evt', e.path, e.type, e.action); });
w.on('error', e=>{ console.error('err', e.message); });

await new Promise(r=>setTimeout(r, 200));
await writeFile(join(dir, '.eslintrc.json'), '{}');
await writeFile(join(dir, 'package.json'), '{}');
await writeFile(join(dir,'tsconfig.json'), '{}');
await new Promise(r=>setTimeout(r, 700));
w.close();
await rm(dir,{recursive:true, force:true});
