#!/usr/bin/env bun
/**
 * Cross-platform desktop build orchestrator.
 *
 * Replaces the old `cd desktop && bun run build` (which used shell-specific
 * `cd` and didn't prepare the embedded backend payload or handle the updater
 * signing key). This script:
 *
 *   1. Writes the compat hash (frontend + backend + desktop pin together).
 *   2. Builds the embedded backend payload for the host target.
 *   3. Patches `tauri.conf.json` to disable `createUpdaterArtifacts` when
 *      `TAURI_SIGNING_PRIVATE_KEY` is not set, so local builds don't fail.
 *      The original config is restored after the build.
 *   4. Runs `tauri build` (which triggers beforeBuildCommand to build the
 *      frontend).
 *
 * Works on macOS, Windows, and Linux without bash.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = join(import.meta.dir, '..');
const DESKTOP_DIR = join(PROJECT_ROOT, 'desktop');
const TAURI_CONF = join(DESKTOP_DIR, 'src-tauri', 'tauri.conf.json');
const TAURI_METADATA = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as {
  productName?: string;
  version?: string;
};
const APPIMAGE_APPDIR = join(
  DESKTOP_DIR,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'appimage',
  'Koryphaios.AppDir',
);
const RELEASE_BUNDLE_DIR = join(DESKTOP_DIR, 'src-tauri', 'target', 'release', 'bundle');
const APPIMAGE_DEB_DIR = join(RELEASE_BUNDLE_DIR, 'appimage_deb');
const DEB_STAGING_DIR = join(RELEASE_BUNDLE_DIR, 'deb');
const APPIMAGE_OUTPUT_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const APPIMAGE_RUNTIME_ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const APPIMAGE_FALLBACK_OUTPUT = join(
  RELEASE_BUNDLE_DIR,
  'appimage',
  `${TAURI_METADATA.productName ?? 'Koryphaios'}_${TAURI_METADATA.version ?? '0.0.0'}_${APPIMAGE_OUTPUT_ARCH}.AppImage`,
);

const SPAWN_SHELL = process.platform === 'win32';

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> } = { cwd: PROJECT_ROOT },
): number {
  console.log(`\n[build-desktop] ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
  return result.status ?? 0;
}

function patchTauriConfig(disableUpdater: boolean): string {
  const original = readFileSync(TAURI_CONF, 'utf-8');
  if (!disableUpdater) return original;

  const config = JSON.parse(original);
  if (config.bundle?.createUpdaterArtifacts === true) {
    config.bundle.createUpdaterArtifacts = false;
    const patched = JSON.stringify(config, null, 2) + '\n';
    writeFileSync(TAURI_CONF, patched);
    console.log(
      '[build-desktop] Temporarily disabled createUpdaterArtifacts (no TAURI_SIGNING_PRIVATE_KEY set)',
    );
  }
  return original;
}

/**
 * AppImage's plugin downloads the type-2 runtime when it is not already
 * available. Offline/native build hosts cannot satisfy that request, even
 * though linuxdeploy has finished the AppDir successfully. The cached
 * appimagetool itself is a type-2 AppImage, so its ELF prefix is a valid
 * runtime. Use it only as a local fallback after Tauri has produced a fully
 * validated AppDir; CI with network access continues using the normal plugin.
 */
function buildAppImageFromValidatedAppDir(): boolean {
  if (process.platform !== 'linux' || !existsSync(APPIMAGE_APPDIR)) return false;

  const backendDir = join(APPIMAGE_APPDIR, 'usr', 'lib', 'Koryphaios', 'backend');
  if (!existsSync(backendDir)) return false;
  const backendTriple =
    process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  const backendResources = readdirSync(backendDir).filter((name) =>
    new RegExp(`^koryphaios-backend-${backendTriple.replaceAll('-', '\\-')}(?:\\.gz)?$`).test(name),
  );
  if (backendResources.length !== 1 || !backendResources[0]?.endsWith('.gz')) {
    throw new Error(
      `Refusing AppImage fallback: expected exactly one opaque Linux backend resource, found ${backendResources.join(', ') || 'none'}`,
    );
  }

  const cachedToolCandidates = [
    process.env.APPIMAGE_TOOL,
    join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
      'tauri',
      'appimagetool-x86_64.AppImage',
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const cachedTool = cachedToolCandidates.find((candidate) => existsSync(candidate));
  if (!cachedTool) return false;

  const offsetResult = spawnSync(cachedTool, ['--appimage-offset'], {
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
    encoding: 'utf8',
  });
  const offset = Number.parseInt(String(offsetResult.stdout ?? '').trim(), 10);
  const toolBytes = readFileSync(cachedTool);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= toolBytes.length) {
    throw new Error(`Refusing AppImage fallback: invalid cached runtime offset (${offset})`);
  }

  const runtimeDir = mkdtempSync('/tmp/kory-appimage-runtime-');
  const runtimePath = join(runtimeDir, 'runtime-x86_64');
  try {
    writeFileSync(runtimePath, toolBytes.subarray(0, offset), { mode: 0o755 });
    chmodSync(runtimePath, 0o755);

    const result = spawnSync(cachedTool, [APPIMAGE_APPDIR, '--runtime-file', runtimePath], {
      cwd: join(RELEASE_BUNDLE_DIR, 'appimage'),
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
      stdio: 'inherit',
    });
    if (result.status !== 0) return false;

    const generated = join(
      join(RELEASE_BUNDLE_DIR, 'appimage'),
      `${TAURI_METADATA.productName ?? 'Koryphaios'}-${APPIMAGE_RUNTIME_ARCH}.AppImage`,
    );
    if (!existsSync(generated)) {
      throw new Error(`AppImage fallback completed without producing ${basename(generated)}`);
    }
    if (existsSync(APPIMAGE_FALLBACK_OUTPUT)) unlinkSync(APPIMAGE_FALLBACK_OUTPUT);
    renameSync(generated, APPIMAGE_FALLBACK_OUTPUT);
    console.log(
      `[build-desktop] Offline AppImage fallback produced ${basename(APPIMAGE_FALLBACK_OUTPUT)}`,
    );
    return true;
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function main() {
  const hasSigningKey = !!process.env.TAURI_SIGNING_PRIVATE_KEY;

  // 1. Write compat hash
  console.log('[build-desktop] Writing compat hash...');
  run('bun', ['run', 'scripts/write-compat-hash.ts']);

  // 2. Build embedded backend payload for the host target
  console.log('[build-desktop] Building embedded backend payload...');
  run('bun', ['run', 'scripts/build-embedded-backend.ts']);

  // 3. Patch tauri.conf.json if no signing key
  const originalConfig = patchTauriConfig(!hasSigningKey);

  try {
    // Tauri reuses an existing AppDir. Remove only that generated staging
    // directory so a prior raw backend resource cannot be copied alongside
    // the current opaque `.gz` payload and re-trigger linuxdeploy's ELF pass.
    if (process.platform === 'linux') {
      rmSync(APPIMAGE_APPDIR, { recursive: true, force: true });
      // The AppImage bundler derives its AppDir from these generated Debian
      // staging trees. Clear both so a prior raw Linux backend cannot be
      // reintroduced beside the current opaque `.gz` resource.
      rmSync(APPIMAGE_DEB_DIR, { recursive: true, force: true });
      rmSync(DEB_STAGING_DIR, { recursive: true, force: true });
    }

    // 4. Run tauri build (beforeBuildCommand builds the frontend)
    console.log('[build-desktop] Running tauri build...');
    const tauriArgs = ['run', 'tauri', 'build'];

    // Forward extra args (e.g., --target) to tauri
    const extraArgs = process.argv.slice(2);
    if (extraArgs.length > 0) {
      tauriArgs.push(...extraArgs);
    }

    try {
      run('bun', tauriArgs, { cwd: DESKTOP_DIR });
    } catch (error) {
      const requestedAppImage = tauriArgs.some((arg) => arg.includes('appimage'));
      // Never bypass a signed build: the fallback intentionally produces only
      // the unsigned local artifact used when updater signing is disabled.
      if (hasSigningKey || !requestedAppImage || !buildAppImageFromValidatedAppDir()) {
        throw error;
      }
      console.warn(
        '[build-desktop] Tauri AppImage plugin failed after AppDir creation; used the validated offline runtime fallback.',
      );
    }
  } finally {
    // Restore original config if it was patched
    if (!hasSigningKey && readFileSync(TAURI_CONF, 'utf-8') !== originalConfig) {
      writeFileSync(TAURI_CONF, originalConfig);
      console.log('[build-desktop] Restored original tauri.conf.json');
    }
  }

  console.log('\n[build-desktop] Build complete!');
}

main();
