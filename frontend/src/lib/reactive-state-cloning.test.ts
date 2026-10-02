import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Svelte 5 stores `$state` values as native `Proxy` objects, and nested
 * properties are proxied too. `structuredClone` throws `DataCloneError` on a
 * proxy, so cloning reactive state — even indirectly, e.g. an object read out
 * of a store getter — fails at runtime.
 *
 * That failure is easy to miss: inside an `$effect` it escapes the whole
 * reactive flush and leaves the view frozen on its loading state with every
 * control dead; inside an event handler it just kills the handler, so the
 * button silently does nothing and only the console shows the error.
 *
 * `$state.snapshot(value)` is a complete replacement: it unwraps proxies and
 * deep-copies plain objects and arrays. Runes are only available in `.svelte`
 * and `.svelte.ts`/`.svelte.js` files, which is exactly the scope this rule
 * covers.
 */
function listRuneFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return [];
      return listRuneFiles(join(directory, entry.name));
    }
    if (!entry.isFile()) return [];
    return /\.svelte(\.(ts|js))?$/.test(entry.name) ? [join(directory, entry.name)] : [];
  });
}

describe('reactive state cloning', () => {
  // Reads every .svelte/.svelte.ts file under src/, so its cost scales with the
  // codebase rather than with the assertion. The 5s default is tight enough that
  // full-suite parallelism can starve it into a bogus timeout.
  it(
    'never uses structuredClone in files that can hold reactive state',
    { timeout: 30_000 },
    () => {
      const sourceRoot = join(process.cwd(), 'src');
      const offenders = listRuneFiles(sourceRoot).filter((path) =>
        /\bstructuredClone\s*\(/.test(readFileSync(path, 'utf8')),
      );

      expect(
        offenders.map((path) => relative(process.cwd(), path)),
        'structuredClone throws DataCloneError on Svelte 5 $state proxies. Use $state.snapshot(value) instead.',
      ).toEqual([]);
    },
  );

  it('unwraps store state before cloning it into an editable draft', () => {
    // The Bases view clones the active Base definition into an editable draft.
    // It regressed once by cloning the store value directly.
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/NotesBasesWorkspace.svelte'),
      'utf8',
    );
    expect(source).toContain('$state.snapshot(active.definition)');
  });
});
