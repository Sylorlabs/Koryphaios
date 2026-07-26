import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from '@/utils/file-watcher.js';

for (const name of ['tsconfig.json','.eslintrc.json','package.json']) {
  const dir = await mkdtemp(join(tmpdir(), 'fwatch-'));
  const watcher = new FileWatcher({cwd: dir, dot: true, ignoreInitial: true});
  watcher.watch(['package.json','tsconfig.json','.eslintrc.*']);
  watcher.on('change', e => console.log(name, 'evt', e.path, e.action));
  await new Promise(r=>setTimeout(r, 200));
  await writeFile(join(dir, name), '{}');
  await new Promise(r=>setTimeout(r, 300));
  watcher.close();
  await rm(dir,{recursive:true, force:true});
}
