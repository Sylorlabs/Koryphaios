#!/usr/bin/env bun
/** Build only the credential-free runtime directory, then prove mandatory bwrap works. */
import {
  ensureFreebuffDockerImage,
  refreshFreebuffRuntimeStatus,
} from '../backend/src/providers/freebuff-runtime';

if ((process.platform === 'darwin' || process.platform === 'win32') && !process.argv.includes('--probe-only'))
  await ensureFreebuffDockerImage();
const result = await refreshFreebuffRuntimeStatus(true);
console.log(JSON.stringify(result, null, 2));
if (!result.available) process.exitCode = 1;
