/**
 * ToolCallIdentity
 *
 * Gives every tool call an app-owned id and maps provider-native ids onto it.
 * See docs/architecture/transcript-integrity.md (Invariant 2) and
 * outputs/t3code-teardown.md B5.
 *
 * Native ids come from each adapter. They can repeat across turns and across
 * providers, and some CLIs omit them, so they are evidence and never identity.
 * Each table is scoped by (sessionId, agentId): one agent's `read` never matches
 * another agent's `read`.
 *
 * - issueCall(): a call that is still awaiting its result is re-announced by
 *   adapters (tool_use_start, then tool_use_stop, with the same native id). A
 *   re-announcement reuses that call's app id. Otherwise the call gets a fresh one.
 * - resolveResult(): the result goes to the call awaiting that native id. A
 *   repeated result goes to the most recent call with that id. A result with no
 *   known call gets a fresh id, so its output stays visible as an orphan.
 */

import { nanoid } from 'nanoid';

/** Bound on remembered native ids per agent. Settled entries are evicted oldest-first. */
const MAX_REMEMBERED_NATIVE_IDS = 1024;

interface Lane {
  /** Native id -> app id of the call that is still awaiting its result. */
  awaiting: Map<string, string>;
  /** Native id -> most recently issued app id for it. */
  latest: Map<string, string>;
}

export interface ToolCallRef {
  appId: string;
  /** The provider-native id, present only when one was supplied. */
  nativeRef?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function freshId(): string {
  return `tc_${nanoid(12)}`;
}

export class ToolCallIdentity {
  private readonly lanes = new Map<string, Lane>();

  private lane(sessionId: string, agentId: string): Lane {
    const key = `${sessionId}\u0000${agentId}`;
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { awaiting: new Map(), latest: new Map() };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  issueCall(sessionId: string, agentId: string, nativeId: unknown): ToolCallRef {
    const native = nonEmpty(nativeId);
    if (!native) return { appId: freshId() };
    const lane = this.lane(sessionId, agentId);
    const awaiting = lane.awaiting.get(native);
    if (awaiting) return { appId: awaiting, nativeRef: native };
    const appId = freshId();
    lane.awaiting.set(native, appId);
    lane.latest.delete(native);
    lane.latest.set(native, appId);
    this.evict(lane);
    return { appId, nativeRef: native };
  }

  resolveResult(sessionId: string, agentId: string, nativeId: unknown): ToolCallRef {
    const native = nonEmpty(nativeId);
    if (!native) return { appId: freshId() };
    const lane = this.lane(sessionId, agentId);
    const awaiting = lane.awaiting.get(native);
    if (awaiting) {
      lane.awaiting.delete(native);
      return { appId: awaiting, nativeRef: native };
    }
    const latest = lane.latest.get(native);
    if (latest) return { appId: latest, nativeRef: native };
    // Orphan: no call with this native id in this scope. Keep the output visible under its own id.
    return { appId: freshId(), nativeRef: native };
  }

  /** Drop remembered ids for one agent of a session, or for every agent when `agentId` is omitted. */
  forget(sessionId: string, agentId?: string): void {
    if (agentId !== undefined) {
      this.lanes.delete(`${sessionId}\u0000${agentId}`);
      return;
    }
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.lanes.keys()]) {
      if (key.startsWith(prefix)) this.lanes.delete(key);
    }
  }

  private evict(lane: Lane): void {
    if (lane.latest.size <= MAX_REMEMBERED_NATIVE_IDS) return;
    for (const native of lane.latest.keys()) {
      if (lane.latest.size <= MAX_REMEMBERED_NATIVE_IDS) break;
      if (lane.awaiting.has(native)) continue;
      lane.latest.delete(native);
    }
  }
}
