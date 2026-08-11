/**
 * Capabilities of the host running deterministic tests.
 *
 * Some sandboxes intentionally deny loopback listeners or interactive Bun
 * child stdin pipes. Tests that exercise those OS boundaries must be skipped
 * with an explicit reason instead of failing as if the product were broken;
 * normal CI/desktop hosts still execute them.
 */

export function canBindLoopback(): boolean {
  try {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function canUseBunStdioPipes(): Promise<boolean> {
  if (process.platform === 'win32') return true;
  let child: Bun.Subprocess | undefined;
  try {
    child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        'process.stdin.on("data", chunk => process.stdout.write(chunk))',
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
    );
    const stdin = child.stdin as unknown as {
      write(chunk: string): void;
      flush(): void;
      end(): void;
    };
    stdin.write('kory-stdio-probe');
    stdin.flush();
    stdin.end();
    const stdout = child.stdout as unknown as ReadableStream<Uint8Array>;
    const output = await Promise.race([
      new Response(stdout).text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 500)),
    ]);
    await child.exited;
    return output === 'kory-stdio-probe';
  } catch {
    try {
      child?.kill();
    } catch {
      /* best effort */
    }
    return false;
  }
}
