#!/usr/bin/env bun
/** Build the credential-free runtime image for the resolved version, then prove mandatory bwrap works. */
import {
  ensureFreebuffRuntimeImage,
  refreshFreebuffRuntimeStatus,
} from '../backend/src/providers/freebuff-runtime';

if ((process.platform === 'darwin' || process.platform === 'win32') && !process.argv.includes('--probe-only'))
  await ensureFreebuffRuntimeImage();
const result = await refreshFreebuffRuntimeStatus(true);
console.log(JSON.stringify(result, null, 2));
if (!result.available) process.exitCode = 1;
