// Shared sandbox for replay tests. Points HOME and PATH at a temp directory so the
// adapters' own binary lookup never reads the developer's real CLI state. No real
// CLI runs: the fake binaries exit 1 and are only found by whichBinary(). The turn
// itself goes through the replay spawn seam.
//
// Bun fixes os.homedir() at process start, so changing HOME here does NOT redirect
// adapters that call homedir() (the isolated runner also sets HOME before start).
// Adapters that discover CLI profiles must take the home explicitly; pass
// `sandbox.home` to the adapter (e.g. CodexCliProvider's profileHome argument).

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CliSandbox {
  home: string;
  workdir: string;
  /** Restore HOME/PATH and delete the temp tree. */
  dispose(): void;
}

export function createCliSandbox(
  binaries: string[],
  authFiles: Record<string, string> = {},
): CliSandbox {
  const root = mkdtempSync(join(tmpdir(), 'kory-replay-'));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  const workdir = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  for (const name of binaries) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\nexit 1\n');
    chmodSync(path, 0o755);
  }
  for (const [relative, content] of Object.entries(authFiles)) {
    const path = join(home, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  return {
    home,
    workdir,
    dispose() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
