#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { compileEmbeddedBackend } from './build-embedded-backend';

export const CI_BACKEND_COMPILE_TARGETS: readonly Bun.Build.CompileTarget[] = Object.freeze([
  'bun-windows-x64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-linux-x64',
]);

export interface BackendCompileArguments {
  bunTarget: Bun.Build.CompileTarget;
  outfile: string;
}

export function parseBackendCompileArguments(args: readonly string[]): BackendCompileArguments {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--(target|outfile)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1]!)) {
      throw new Error('Expected exactly one --target=<bun-target> and --outfile=<path>.');
    }
    values.set(match[1]!, match[2]!);
  }
  const target = values.get('target');
  const outfile = values.get('outfile');
  if (!target || !outfile) {
    throw new Error('Both --target=<bun-target> and --outfile=<path> are required.');
  }
  if (!CI_BACKEND_COMPILE_TARGETS.some((supported) => supported === target)) {
    throw new Error('Unsupported CI backend compile target.');
  }
  return { bunTarget: target as Bun.Build.CompileTarget, outfile: resolve(outfile) };
}

/** Compile with the same fresh-source plugin as desktop, without its gzip step. */
export async function compileBackendForCI(
  args: readonly string[],
  relayUrl?: string,
): Promise<string> {
  const { bunTarget, outfile } = parseBackendCompileArguments(args);
  mkdirSync(dirname(outfile), { recursive: true });
  const scratch = mkdtempSync(join(dirname(outfile), '.kory-backend-compile-'));
  const staged = join(scratch, basename(outfile));
  try {
    await compileEmbeddedBackend({
      entrypoint: resolve(import.meta.dir, '../backend/src/server.ts'),
      outfile: staged,
      bunTarget,
      relayUrl,
    });
    const artifact = statSync(staged);
    if (!artifact.isFile() || artifact.size === 0) {
      throw new Error('CI backend compile did not produce a regular nonempty artifact.');
    }
    // Stay on the destination filesystem and preserve the prior artifact on failure.
    renameSync(staged, outfile);
    return outfile;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const outfile = await compileBackendForCI(process.argv.slice(2), process.env.RELAY_URL);
  console.log(`Compiled backend: ${outfile}`);
}
