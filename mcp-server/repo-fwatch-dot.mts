import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from '@/utils/file-watcher.js';

const dir = await mkdtemp(join(tmpdir(), 'fwatch-'));
const watcher = new FileWatcher({cwd: dir, dot: true, ignoreInitial: true});
watcher.watch(['package.json','tsconfig.json','.eslintrc.*']);

watcher.on('change', e => console.log('evt', e.path, e.type, e.action));
await new Promise(r=>setTimeout(r, 100));
await writeFile(join(dir, '.eslintrc.json'),'{}');
await writeFile(join(dir,'package.json'),'{}');
await writeFile(join(dir,'tsconfig.json'),'{}');
await new Promise(r=>setTimeout(r, 400));
watcher.close();
await rm(dir,{recursive:true, force:true});
