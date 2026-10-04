import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSandboxed, type OsSandboxOptions } from './os-sandbox';

export type ConfinedFileMutation =
  | { operation: 'write'; path: string; content: string; createParents?: boolean }
  | { operation: 'delete' | 'rmdir'; path: string }
  | { operation: 'move'; source: string; destination: string };

// Only this host-owned program is executable code. Paths and file contents are
// JSON on stdin, never shell arguments, interpolated source, or an eval input.
// In particular, do not move these syscalls back into the backend after a path
// check: a symlink can change during UI streaming (or after any later check).
const MUTATION_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  switch (input.operation) {
    case 'write':
      if (input.createParents) fs.mkdirSync(path.dirname(input.path), { recursive: true });
      fs.writeFileSync(input.path, input.content, 'utf8');
      break;
    case 'delete': fs.unlinkSync(input.path); break;
    case 'rmdir': fs.rmdirSync(input.path); break;
    case 'move':
      if (fs.existsSync(input.destination)) throw new Error('Destination already exists');
      fs.mkdirSync(path.dirname(input.destination), { recursive: true });
      try { fs.renameSync(input.source, input.destination); }
      catch (error) {
        if (error.code !== 'EXDEV' || fs.statSync(input.source).isDirectory()) throw error;
        fs.copyFileSync(input.source, input.destination, fs.constants.COPYFILE_EXCL);
        fs.unlinkSync(input.source);
      }
      break;
    default: throw new Error('Unsupported file mutation');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

/** Kernel-confined write boundary for a fixed, host-authorized chat root.
 * No fallback is permitted, even if optional workspace sandboxing is off.
 * Lexical checks are defense in depth; the OS enforces resolved destinations,
 * including symlink swaps after preflight and inside parent directories.
 */
export async function mutateFileConfined(
  requiredWorkspaceRoot: string,
  mutation: ConfinedFileMutation,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !isAbsolute(requiredWorkspaceRoot) ||
    resolve(requiredWorkspaceRoot) !== requiredWorkspaceRoot
  ) {
    throw new Error('Mandatory workspace root must be a canonical absolute path');
  }
  const paths =
    mutation.operation === 'move' ? [mutation.source, mutation.destination] : [mutation.path];
  for (const filePath of paths) {
    const rel = relative(requiredWorkspaceRoot, resolve(filePath));
    if (
      !isAbsolute(filePath) ||
      !rel ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      throw new Error('File mutation is outside the mandatory workspace root');
    }
  }
  signal?.throwIfAborted();
  const options: OsSandboxOptions = {
    allowedRoots: [requiredWorkspaceRoot],
    requiredWorkspaceRoot,
    cwd: requiredWorkspaceRoot,
    blockNetwork: true,
    // sandbox-exec must be allowed to exec the runtime. The fixed script never
    // starts subprocesses; it cannot execute any of the supplied JSON as code.
    blockSubprocesses: false,
    stdin: 'pipe',
  };
  const { proc, cleanup } = spawnSandboxed([process.execPath, '-e', MUTATION_SCRIPT], options);
  try {
    await new Promise<void>((accept, reject) => {
      let stderr = '';
      let transportError: Error | undefined;
      let stopped: Error | undefined;
      const stop = (error: Error) => {
        stopped = error;
        proc.kill('SIGKILL');
      };
      const abort = () => stop(new Error('File mutation aborted'));
      const timeout = setTimeout(() => stop(new Error('Confined file mutation timed out')), 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else accept();
      };
      proc.stdout?.resume();
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });
      proc.once('error', (error) => finish(error));
      proc.once('close', (code, exitSignal) =>
        finish(
          stopped ??
            (code === 0 && !transportError
              ? undefined
              : new Error(
                  `Confined file mutation failed (${exitSignal ?? code}): ${stderr.trim() || transportError?.message || 'sandbox rejected execution'}`,
                )),
        ),
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!proc.stdin) {
        stop(new Error('OS sandbox does not provide the required file mutation stdin transport'));
        return;
      }
      proc.stdin.on('error', (error) => {
        transportError = error;
      });
      proc.stdin.end(JSON.stringify(mutation));
    });
  } finally {
    cleanup();
  }
}
