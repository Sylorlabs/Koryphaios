/**
 * Run an evaluation command under a permissive agent permission preset, then put the project's
 * preset back, even when the command fails.
 *
 * Usage: bun run scripts/eval-permission-profile.ts --mode=yolo -- <command> [args...]
 */
import { spawn } from 'node:child_process';
import { applyPermissionMode, isEvalPermissionMode, restorePermissionMode } from './eval-permission';

const argv = process.argv.slice(2);
const modeArgument = argv.find((argument) => argument.startsWith('--mode='));
const separator = argv.indexOf('--');
if (!modeArgument || separator < 0 || separator === argv.length - 1) {
  throw new Error(
    'Usage: bun run scripts/eval-permission-profile.ts --mode=yolo -- <command> [args...]',
  );
}
const mode = modeArgument.slice('--mode='.length);
if (!isEvalPermissionMode(mode)) {
  throw new Error(`Unknown permission mode ${JSON.stringify(mode)}`);
}
const command = argv.slice(separator + 1);
const port = process.env.KORYPHAIOS_PORT?.trim() || '3001';

const previous = await applyPermissionMode(mode, port);
console.log(
  `[eval-permission] preset ${JSON.stringify(previous ?? 'default')} -> ${JSON.stringify(mode)} on port ${port}`,
);

let code = 1;
try {
  code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
} finally {
  await restorePermissionMode(previous, port);
  console.log(`[eval-permission] preset restored to ${JSON.stringify(previous ?? 'default')}`);
}
process.exit(code);
