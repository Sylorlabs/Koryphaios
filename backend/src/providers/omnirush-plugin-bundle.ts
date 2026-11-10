import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Bun evaluates this macro during source loading/build and embeds the result.
 * Packaged backends need neither node_modules nor a compiler at runtime. */
export async function bundleOmnirushPlugin(): Promise<string> {
  const entrypoint = fileURLToPath(new URL('./omnirush-plugin-runtime.ts', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'kory-omnirush-build-'));
  const output = join(directory, 'plugin.mjs');
  try {
    const result = Bun.spawnSync([
      process.execPath,
      'build',
      entrypoint,
      '--target=bun',
      '--format=esm',
      '--minify',
      `--outfile=${output}`,
    ]);
    if (result.exitCode !== 0) throw new Error('Could not bundle the Omnirush tool plugin');
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
