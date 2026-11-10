import type { AppContext } from '../context';

type ContextAccessor = () => AppContext;

let accessor: ContextAccessor | null = null;

/**
 * Registered by `context.ts` at module load.
 *
 * Call sites must not reach for `await import('../context')` instead: the
 * context graph closes a cycle (context → manager → … → this module), and
 * `bun build --compile` inlines such an import into a live binding it cannot
 * resolve. The packaged binary then fails every affected route at runtime with
 * `__INVALID__REF__ is not defined` while the unbundled dev server works.
 */
export function installContextAccessor(fn: ContextAccessor): void {
  accessor = fn;
}

/** The same instance `getContext()` returns, without a dynamic import. */
export function getInstalledContext(): AppContext {
  if (!accessor) {
    throw new Error('AppContext accessor not installed. Import context before resolving it.');
  }
  return accessor();
}
