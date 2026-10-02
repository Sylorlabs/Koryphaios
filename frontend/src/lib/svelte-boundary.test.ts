import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import BoundaryHarness from './components/__fixtures__/BoundaryHarness.svelte';
import NestedBoundaryHarness from './components/__fixtures__/NestedBoundaryHarness.svelte';
import NoBoundaryHarness from './components/__fixtures__/NoBoundaryHarness.svelte';

/**
 * `<svelte:boundary>` is the only thing that stops a throwing `$effect` from
 * taking the whole app down.
 *
 * Svelte's `update_reaction` catches an effect error and routes it through
 * `handle_error` → `invoke_error_boundary`, which walks up the effect tree
 * looking for a boundary. If it finds none it re-throws. That throw lands in
 * `flush_queued_effects`, whose `while (i < length) { update_effect(...) }` loop
 * has no try/catch — so the rethrow aborts the loop and **every effect still
 * queued behind the failing one is silently skipped**. Pending renders never
 * commit, controls stop responding, and the view stays frozen on its loading
 * state: exactly the "indexes forever and freezes all buttons" report.
 *
 * The subtle trap is that a boundary alone is not enough. `Boundary.error()`
 * starts with:
 *
 *     if (!this.#props.onerror && !this.#props.failed) throw error;
 *
 * so a `<svelte:boundary>` with neither `onerror` nor a `failed` snippet is a
 * no-op that re-throws just as if it were absent. Both halves are pinned below.
 */

/** Strips HTML and block comments so prose that merely *mentions* a boundary is ignored. */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function listSvelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return [];
      return listSvelteFiles(join(directory, entry.name));
    }
    return entry.isFile() && entry.name.endsWith('.svelte') ? [join(directory, entry.name)] : [];
  });
}

interface BoundaryBlock {
  openingTag: string;
  body: string;
}

function findBoundaries(source: string): BoundaryBlock[] {
  const boundaries: BoundaryBlock[] = [];
  const openTag = /<svelte:boundary\b/g;
  let match: RegExpExecArray | null;

  while ((match = openTag.exec(source)) !== null) {
    const tagEnd = source.indexOf('>', match.index);
    if (tagEnd === -1) break;

    const closeIndex = source.indexOf('</svelte:boundary>', tagEnd);
    boundaries.push({
      openingTag: source.slice(match.index, tagEnd + 1),
      body: source.slice(tagEnd, closeIndex === -1 ? source.length : closeIndex),
    });
  }

  return boundaries;
}

/** A boundary that can actually contain an error. */
function isProtective(boundary: BoundaryBlock): boolean {
  return /onerror\s*=/.test(boundary.openingTag) || /\{#snippet\s+failed\b/.test(boundary.body);
}

afterEach(cleanup);

describe('svelte:boundary containment', () => {
  it('contains an $effect throw and lets the rest of the reactive flush finish', async () => {
    render(BoundaryHarness, { props: { message: 'effect exploded' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('contained: effect exploded');

    // The probe sits outside the boundary and its effect was queued *behind* the
    // throwing effect. "pending" here would mean the flush aborted.
    expect(screen.getByTestId('sibling-probe').textContent).toBe('ran');

    // Controls outside the boundary stay live, so the user is not trapped.
    const sibling = screen.getByRole('button', { name: /^sibling/ });
    expect(sibling.textContent).toContain('sibling 0');
    await fireEvent.click(sibling);
    expect(sibling.textContent).toContain('sibling 1');
  });

  it('recovers the subtree when the failed snippet calls reset', async () => {
    const { rerender } = render(BoundaryHarness, {
      props: { shouldThrow: true, message: 'effect exploded' },
    });
    expect(screen.getByRole('alert').textContent).toContain('contained: effect exploded');

    // Clear the cause of the failure, then let the user's "reset" re-run the
    // main branch instead of leaving them stuck on the error screen forever.
    await rerender({ shouldThrow: false, message: 'effect exploded' });
    await fireEvent.click(screen.getByRole('button', { name: 'reset boundary' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('content recovered')).toBeTruthy();
  });

  it('is not vacuous: without a boundary the same throw aborts the flush', () => {
    // Mount flushes synchronously, so the escaped error surfaces here.
    expect(() => render(NoBoundaryHarness, { props: { message: 'effect exploded' } })).toThrow(
      'effect exploded',
    );

    // The probe's effect never ran, and never will — the frozen state from the
    // bug report, reproduced on demand.
    expect(screen.getByTestId('sibling-probe').textContent).toBe('pending');
  });

  it('contains a throw from deeper in the tree, like the app-root boundary', () => {
    // `invoke_error_boundary` walks `effect.parent` upward, so containment must
    // not depend on the failing effect being a direct child. The real
    // `+layout.svelte` boundary wraps `{@render children()}`, i.e. the whole
    // route subtree, which is exactly this shape.
    render(NestedBoundaryHarness, { props: { message: 'effect exploded' } });

    expect(screen.getByRole('alert').textContent).toContain('contained: effect exploded');
    expect(screen.getByTestId('sibling-probe').textContent).toBe('ran');
  });
});

describe('svelte:boundary coverage', () => {
  // Reads every .svelte file under src/, so its cost scales with the codebase
  // rather than with the assertion. The 5s default is tight enough that
  // full-suite parallelism can starve it into a bogus timeout.
  it('never ships a boundary that cannot contain an error', { timeout: 30_000 }, () => {
    const offenders = listSvelteFiles(join(process.cwd(), 'src'))
      .map((path) => ({
        path: relative(process.cwd(), path),
        boundaries: findBoundaries(stripComments(readFileSync(path, 'utf8'))),
      }))
      .filter(({ boundaries }) => boundaries.some((boundary) => !isProtective(boundary)))
      .map(({ path }) => path);

    expect(
      offenders,
      'A <svelte:boundary> with neither `onerror` nor a `failed` snippet re-throws instead of containing, so it protects nothing. Add a `failed` snippet.',
    ).toEqual([]);
  });

  it('keeps the app root wrapped in a boundary with a failed snippet', () => {
    const layout = stripComments(
      readFileSync(join(process.cwd(), 'src/routes/+layout.svelte'), 'utf8'),
    );
    const boundaries = findBoundaries(layout);

    expect(boundaries.length, 'src/routes/+layout.svelte has no <svelte:boundary>').toBeGreaterThan(
      0,
    );
    expect(
      boundaries.some(isProtective),
      'The app-root boundary needs a `failed` snippet, otherwise any effect throw freezes the whole app.',
    ).toBe(true);
  });

  it('keeps the Notes panel wrapped so a Notes crash cannot kill the chat shell', () => {
    const shell = stripComments(
      readFileSync(join(process.cwd(), 'src/lib/components/shell/AppShell.svelte'), 'utf8'),
    );
    const notesBoundaries = findBoundaries(shell).filter((boundary) =>
      boundary.body.includes('NotesPanelComponent'),
    );

    expect(
      notesBoundaries.length,
      'The Notes panel is not wrapped in a <svelte:boundary>; a Notes crash takes the chat feed down with it.',
    ).toBeGreaterThan(0);
    expect(notesBoundaries.some(isProtective)).toBe(true);
  });
});
