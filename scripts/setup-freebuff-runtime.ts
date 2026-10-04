#!/usr/bin/env bun
/** Build only the credential-free runtime directory, then prove mandatory bwrap works. */
import { fileURLToPath } from 'node:url';
import {
  FREEBUFF_RUNTIME_IMAGE,
  refreshFreebuffRuntimeStatus,
} from '../backend/src/providers/freebuff-runtime';

if (process.platform === 'darwin' && !process.argv.includes('--probe-only')) {
  const context = fileURLToPath(new URL('../docker/freebuff-runtime', import.meta.url));
  // Docker itself may use its host config, but no environment is forwarded into the image.
  const child = Bun.spawn(
    ['docker', 'build', '--platform', 'linux/amd64', '--tag', FREEBUFF_RUNTIME_IMAGE, context],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await child.exited) !== 0) throw new Error('Freebuff runtime image build failed');
}
const result = await refreshFreebuffRuntimeStatus(true);
console.log(JSON.stringify(result, null, 2));
if (!result.available) process.exitCode = 1;
