#!/usr/bin/env bun
/**
 * Build the embedded backend payload for the HOST platform's Tauri target.
 *
 * The payload ships as a Tauri resource, separately from the Rust shell.
 * Local `bun run build:desktop` calls this before `tauri build`; CI currently
 * has its own per-target compile route.
 *
 * Use the backend's fresh-source V5 contract plugin in the actual standalone
 * compile, not a generated manifest or a prebuilt backend/build artifact.
 * RELAY_URL is baked into the payload as before (an endpoint, not a secret).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BuildConfig } from 'bun';
import { hostOS } from '../backend/src/runtime/platform';
import { currentV5SkillEvaluationContractsPlugin } from '../backend/scripts/build-current-v5-contracts';

const PROJECT_ROOT = join(import.meta.dir, '..');
const BACKEND_ENTRY = join(PROJECT_ROOT, 'backend', 'src', 'packaged-entry.ts');
const PAYLOAD_DIR = join(PROJECT_ROOT, 'desktop', 'src-tauri', 'embedded-backend');

export interface HostTarget {
  rustTarget: string;
  bunTarget: Bun.Build.CompileTarget;
  suffix: string;
  compressResource: boolean;
}

const HOST_TARGETS: Record<string, Record<string, HostTarget>> = {
  win32: {
    x64: {
      rustTarget: 'x86_64-pc-windows-msvc',
      bunTarget: 'bun-windows-x64',
      suffix: '.exe',
      compressResource: false,
    },
    arm64: {
      rustTarget: 'aarch64-pc-windows-msvc',
      bunTarget: 'bun-windows-arm64',
      suffix: '.exe',
      compressResource: false,
    },
  },
  darwin: {
    x64: {
      rustTarget: 'x86_64-apple-darwin',
      bunTarget: 'bun-darwin-x64',
      suffix: '',
      compressResource: false,
    },
    arm64: {
      rustTarget: 'aarch64-apple-darwin',
      bunTarget: 'bun-darwin-arm64',
      suffix: '',
      compressResource: false,
    },
  },
  linux: {
    x64: {
      rustTarget: 'x86_64-unknown-linux-gnu',
      bunTarget: 'bun-linux-x64',
      suffix: '',
      compressResource: true,
    },
    arm64: {
      rustTarget: 'aarch64-unknown-linux-gnu',
      bunTarget: 'bun-linux-arm64',
      suffix: '',
      compressResource: true,
    },
  },
};

export function detectHostTarget(
  platform: string = hostOS(),
  arch: string = process.arch,
): HostTarget {
  const targets = HOST_TARGETS[platform];
  if (!targets) throw new Error(`Unsupported platform: ${platform}`);
  const target = targets[arch];
  if (!target) throw new Error(`Unsupported ${platform} arch: ${arch}`);
  return target;
}

export interface EmbeddedBackendCompileOptions {
  entrypoint: string;
  outfile: string;
  bunTarget: Bun.Build.CompileTarget;
  relayUrl?: string;
  /** Build-coherent bundle hash baked into the payload's own identity. */
  bundleHash?: string;
}

/** Shared by the real desktop route and a credential-free native compile smoke. */
export function embeddedBackendBuildConfig(options: EmbeddedBackendCompileOptions): BuildConfig {
  const define: Record<string, string> = {};
  if (options.relayUrl) {
    define['process.env.RELAY_URL'] = JSON.stringify(options.relayUrl);
  }
  // The payload reports its own build identity on /api/health, so the
  // frontend's compat sentinel compares the backend hash to the frontend
  // hash — not the frontend hash to itself via the shell's env stamp.
  if (options.bundleHash) {
    define['process.env.KORYPHAIOS_BACKEND_BUILD_HASH'] = JSON.stringify(options.bundleHash);
  }
  return {
    entrypoints: [options.entrypoint],
    root: PROJECT_ROOT,
    target: 'bun',
    compile: { target: options.bunTarget, outfile: options.outfile },
    define: Object.keys(define).length > 0 ? define : undefined,
    // Each invocation collects actual current source packages/registered IDs.
    plugins: [currentV5SkillEvaluationContractsPlugin()],
  };
}

export async function compileEmbeddedBackend(
  options: EmbeddedBackendCompileOptions,
): Promise<void> {
  const result = await Bun.build(embeddedBackendBuildConfig(options));
  if (!result.success) {
    throw new AggregateError(
      result.logs,
      `Failed to build embedded backend payload for ${options.bunTarget}`,
    );
  }
  if (!existsSync(options.outfile)) {
    throw new Error(`Embedded backend payload was not written to ${options.outfile}`);
  }
}

/** The hash the packaged backend reports as its own build identity. A missing
 * or 'dev' compat file leaves the payload unstamped, same as a dev frontend. */
export function readCompileTimeBundleHash(root: string = PROJECT_ROOT): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'compat-hash.json'), 'utf-8')) as {
      hash?: unknown;
    };
    const hash = typeof parsed.hash === 'string' ? parsed.hash.trim() : '';
    return hash && hash !== 'dev' ? hash : undefined;
  } catch {
    return undefined;
  }
}

export async function buildEmbeddedBackend(payloadDir: string = PAYLOAD_DIR): Promise<void> {
  const target = detectHostTarget();
  const outfile = join(payloadDir, `koryphaios-backend-${target.rustTarget}${target.suffix}`);
  // linuxdeploy rewrites every ELF resource it discovers. Keep Linux's payload
  // opaque to that pass; lib.rs restores executable permissions in its cache.
  const compressedOutfile = `${outfile}.gz`;
  // Keep Windows's executable suffix at the end of the staging name too.
  const compileOutfile = join(
    payloadDir,
    `koryphaios-backend-${target.rustTarget}.raw-${process.pid}${target.suffix}`,
  );

  mkdirSync(dirname(outfile), { recursive: true });
  console.log(`[build-embedded-backend] target=${target.rustTarget} bun=${target.bunTarget}`);
  console.log(
    `[build-embedded-backend] outfile=${target.compressResource ? compressedOutfile : outfile}`,
  );

  try {
    await compileEmbeddedBackend({
      entrypoint: BACKEND_ENTRY,
      outfile: compileOutfile,
      bunTarget: target.bunTarget,
      relayUrl: process.env.RELAY_URL,
      bundleHash: readCompileTimeBundleHash(),
    });

    if (target.compressResource) {
      const compressed = gzipSync(readFileSync(compileOutfile), { level: 9 });
      writeFileSync(compressedOutfile, compressed, { mode: 0o644 });
      if (existsSync(outfile)) unlinkSync(outfile);
    } else {
      renameSync(compileOutfile, outfile);
      if (existsSync(compressedOutfile)) unlinkSync(compressedOutfile);
    }
    // Remove the obsolete format only after success: Tauri copies the directory
    // as a whole, but a failed compile must not erase a previous usable payload.
  } finally {
    if (existsSync(compileOutfile)) unlinkSync(compileOutfile);
  }

  console.log('[build-embedded-backend] done');
}

if (import.meta.main) await buildEmbeddedBackend();
