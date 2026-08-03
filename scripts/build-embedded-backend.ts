#!/usr/bin/env bun
/**
 * Build the embedded backend payload for the HOST platform's Tauri target.
 *
 * `desktop/src-tauri/build.rs` panics in release builds if the payload for the
 * current compile target is missing. CI builds the payload per-target before
 * `tauri build`, but local `bun run build:desktop` on macOS or Windows had no
 * equivalent step — this script fills that gap so `tauri build` works locally
 * on any platform.
 *
 * Maps the host OS/arch to the Bun compile target and the Rust target triple,
 * then runs `bun build --compile --target=<bun-target> backend/src/server.ts
 * --outfile=<embedded-backend>/koryphaios-backend-<rust-target>[.exe]`.
 *
 * If RELAY_URL is set in the environment, it's baked into the payload via
 * `--define process.env.RELAY_URL=...` (matches the CI workflow).
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = join(import.meta.dir, '..');
const BACKEND_ENTRY = join(PROJECT_ROOT, 'backend', 'src', 'server.ts');
const PAYLOAD_DIR = join(PROJECT_ROOT, 'desktop', 'src-tauri', 'embedded-backend');

const SPAWN_SHELL = process.platform === 'win32';

interface HostTarget {
  rustTarget: string;
  bunTarget: string;
  suffix: string; // ".exe" on Windows, "" elsewhere
}

function detectHostTarget(): HostTarget {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    if (arch === 'x64') {
      return { rustTarget: 'x86_64-pc-windows-msvc', bunTarget: 'bun-windows-x64', suffix: '.exe' };
    }
    if (arch === 'arm64') {
      return {
        rustTarget: 'aarch64-pc-windows-msvc',
        bunTarget: 'bun-windows-arm64',
        suffix: '.exe',
      };
    }
    throw new Error(`Unsupported Windows arch: ${arch}`);
  }

  if (platform === 'darwin') {
    if (arch === 'x64') {
      return { rustTarget: 'x86_64-apple-darwin', bunTarget: 'bun-darwin-x64', suffix: '' };
    }
    if (arch === 'arm64') {
      return { rustTarget: 'aarch64-apple-darwin', bunTarget: 'bun-darwin-arm64', suffix: '' };
    }
    throw new Error(`Unsupported macOS arch: ${arch}`);
  }

  if (platform === 'linux') {
    if (arch === 'x64') {
      return { rustTarget: 'x86_64-unknown-linux-gnu', bunTarget: 'bun-linux-x64', suffix: '' };
    }
    if (arch === 'arm64') {
      return { rustTarget: 'aarch64-unknown-linux-gnu', bunTarget: 'bun-linux-arm64', suffix: '' };
    }
    throw new Error(`Unsupported Linux arch: ${arch}`);
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function main() {
  const target = detectHostTarget();
  const outfile = join(PAYLOAD_DIR, `koryphaios-backend-${target.rustTarget}${target.suffix}`);

  mkdirSync(dirname(outfile), { recursive: true });

  const args: string[] = ['build', '--compile', `--target=${target.bunTarget}`];

  // Bake the collaboration relay endpoint so shipped builds can host/join
  // out of the box (it's an endpoint, not a secret). Matches the CI workflow.
  const relayUrl = process.env.RELAY_URL;
  if (relayUrl) {
    args.push('--define', `process.env.RELAY_URL="${relayUrl}"`);
  }

  args.push(BACKEND_ENTRY, '--outfile', outfile);

  console.log(`[build-embedded-backend] target=${target.rustTarget} bun=${target.bunTarget}`);
  console.log(`[build-embedded-backend] outfile=${outfile}`);

  const result = spawnSync('bun', args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to build embedded backend payload (exit ${result.status}). ` +
        `Ensure 'bun build --compile --target=${target.bunTarget}' is supported by your Bun version.`,
    );
  }

  if (!existsSync(outfile)) {
    throw new Error(`Embedded backend payload was not written to ${outfile}`);
  }

  console.log(`[build-embedded-backend] done`);
}

main();
