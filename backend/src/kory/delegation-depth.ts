import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Delegation depth bounds how far a worker may fan out. The manager is depth 0;
 * a worker it starts runs at depth 1 and may delegate once more; that
 * sub-worker runs at depth 2 and cannot delegate further. Depth travels with
 * the async context rather than through every pipeline signature, so the
 * worker's ToolContext can read it where it is built.
 */
export const MAX_DELEGATION_DEPTH = 2;

const depthStorage = new AsyncLocalStorage<{ depth: number }>();

/** Depth of the agent whose code is currently running (0 outside any worker). */
export function currentDelegationDepth(): number {
  return depthStorage.getStore()?.depth ?? 0;
}

/** Run `fn` as an agent at `depth`. Work it schedules inherits that depth, so
 *  detached callbacks must re-enter at depth 0 when they start a manager turn. */
export function runAtDelegationDepth<T>(depth: number, fn: () => T): T {
  return depthStorage.run({ depth: Math.max(0, Math.floor(depth)) }, fn);
}

/** Whether an agent at `depth` may start a sub-agent. */
export function canDelegateAtDepth(depth: number): boolean {
  return depth < MAX_DELEGATION_DEPTH;
}
