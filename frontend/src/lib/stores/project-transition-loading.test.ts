import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A project-scoped store that clears its loading flag **only** when the request
 * still owns the current scope can strand the UI forever.
 *
 * The reported bug ("going to notes then going to bases indexes forever") had
 * two faces, and this is the second one. `note-bases.svelte.ts` cleared
 * `_loading` with `if (scopeStillCurrent(request)) _loading = false`. When the
 * project disappeared — `projectStore.markUnavailable()` nulls `currentPath`
 * without bumping the generation — no newer request took over, so nothing ever
 * cleared the flag. The spinner stayed on with no error, and therefore no Retry
 * control: the user had no way out.
 *
 * `beginProjectTransition()` is the store-level escape hatch, and it must reset
 * the flag. The other project-scoped stores already did (`notes.svelte.ts`
 * clears `_isLoading`/`_isIndexing`, `memory.svelte.ts` clears
 * `state.isLoading`); the Bases store was the one that did not.
 *
 * The reset is often one call away (`beginProjectTransition()` → `clear()`), so
 * the check follows local function calls rather than only reading the
 * transition body verbatim.
 */

const STORES_DIR = join(process.cwd(), 'src/lib/stores');

/** Matches `_loading = false`, `_isLoading = false`, `state.isLoading = false`. */
const CLEARS_LOADING = /loading\s*=\s*false/i;
const SETS_LOADING = /loading\s*=\s*true/i;

function storeFiles(): { path: string; source: string }[] {
  return readdirSync(STORES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.svelte.ts'))
    .map((entry) => ({
      path: join(STORES_DIR, entry.name),
      source: readFileSync(join(STORES_DIR, entry.name), 'utf8'),
    }));
}

/**
 * Body of a top-level or nested `function <name>(...)`, found by brace matching
 * from its opening `{`. Indentation-based slicing would not work: the
 * declaration is top-level in some stores and nested inside a factory in others.
 */
function functionBody(source: string, name: string): string | null {
  const start = source.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (start === -1) return null;

  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }

  return null;
}

function calledNames(body: string): string[] {
  return [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
}

/**
 * True if this body clears a loading flag, following local function calls (e.g.
 * `clear()`) to a bounded depth so delegation is not a false negative.
 */
function clearsLoading(source: string, body: string, visited = new Set<string>()): boolean {
  if (CLEARS_LOADING.test(body)) return true;

  for (const name of calledNames(body)) {
    if (visited.has(name)) continue;
    visited.add(name);

    const called = functionBody(source, name);
    if (called !== null && clearsLoading(source, called, visited)) return true;
  }

  return false;
}

describe('project-transition loading reset', () => {
  it('every project-scoped store clears its loading flag on project transition', () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const { path, source } of storeFiles()) {
      const transition = functionBody(source, 'beginProjectTransition');
      if (transition === null) continue;

      // A store with no loading flag has nothing to reset.
      if (!SETS_LOADING.test(source)) continue;
      checked += 1;

      if (!clearsLoading(source, transition)) offenders.push(relative(process.cwd(), path));
    }

    expect(checked, 'No project-scoped stores were checked — the guard is vacuous').toBeGreaterThan(
      0,
    );
    expect(
      offenders,
      'These stores manage a loading flag but do not clear it in beginProjectTransition(), so a lost project scope can strand the view on a spinner with no error and no Retry. Reset the flag there.',
    ).toEqual([]);
  });

  it('is not vacuous: it resolves a delegated clear', () => {
    // The Bases store clears via `beginProjectTransition()` -> `clear()`, so the
    // guard only passes it because it follows the call.
    const source = readFileSync(join(STORES_DIR, 'note-bases.svelte.ts'), 'utf8');
    const transition = functionBody(source, 'beginProjectTransition');

    expect(transition).not.toBeNull();
    expect(transition).not.toMatch(CLEARS_LOADING);
    expect(clearsLoading(source, transition as string)).toBe(true);
  });
});
