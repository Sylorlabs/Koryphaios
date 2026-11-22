/**
 * Start the packaged backend that evidence runs must target.
 *
 * This is the same bundle, config, and data directory the watcher used, so a
 * measurement does not change when it moves here. What changes is restarts: the
 * watcher reloads on any `backend/src` edit, which kills a turn mid stream and
 * turns an infrastructure kill into an apparent candidate failure.
 *
 *   bun run eval:backend                 start on 3001
 *   KORYPHAIOS_PORT=3101 bun run eval:backend
 *   bun run eval:backend -- --rebuild    force a fresh bundle first
 *   bun run eval:backend -- --foreground
 *
 * The bundle is rebuilt when it is older than the newest source file, because a
 * stale bundle silently serves older evaluator code.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const backendDir = join(projectRoot, 'backend');
const bundlePath = join(backendDir, 'build', 'server.js');
const args = process.argv.slice(2);
const forceRebuild = args.includes('--rebuild');
const foreground = args.includes('--foreground');
const port = process.env.KORYPHAIOS_PORT?.trim() || '3001';

function newestSourceMtime(dir: string, newest = 0): number {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'build') continue;
      newest = newestSourceMtime(path, newest);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const mtime = statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function bundleIsStale(): boolean {
  if (!existsSync(bundlePath)) return true;
  const bundleMtime = statSync(bundlePath).mtimeMs;
  return newestSourceMtime(join(backendDir, 'src')) > bundleMtime;
}

if (forceRebuild || bundleIsStale()) {
  process.stderr.write('[eval:backend] building backend bundle\n');
  const build = spawnSync('bun', ['run', 'build'], {
    cwd: backendDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const child = spawn('bun', ['build/server.js'], {
  cwd: backendDir,
  stdio: foreground ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, KORYPHAIOS_PORT: port },
  detached: !foreground,
});

if (!foreground) {
  // Keep the log next to the run so a wedged turn can be explained afterwards.
  const logPath = join(projectRoot, 'outputs', 'eval-backend.log');
  const stream = Bun.file(logPath).writer();
  child.stdout?.on('data', (chunk: Buffer) => void stream.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => void stream.write(chunk));
  child.stdout?.on('close', () => void stream.end());
  child.unref();
  process.stdout.write(
    `[eval:backend] packaged backend pid ${child.pid} on ${port}; log ${logPath}\n`,
  );
  process.stdout.write(
    '[eval:backend] packaged bundle only, no file watcher, so an edit cannot restart it mid turn\n',
  );
}
