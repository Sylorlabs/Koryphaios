import type { Checklist, ChecklistItemStatus, ChecklistScope } from '@koryphaios/shared';
import { checklistProgress } from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { browser } from '$app/environment';
import { sessionStore } from './sessions.svelte';
import { projectStore } from './project.svelte';

let checklists = $state<Checklist[]>([]);
let loaded = $state(false);
let error = $state('');
// Bumped on every local write so a reload cannot clobber a checklist that a
// live event or a user action landed while the GET was still in flight.
let revision = 0;
const revisions = new Map<string, number>();

async function request(path: string, init?: RequestInit): Promise<Checklist> {
  const res = await apiFetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.error ?? 'Checklist request failed');
  return data.data as Checklist;
}

/** One upsert point, so a change made by the user and one made by an agent land
 *  in the same list in the same way. */
function upsert(checklist: Checklist): Checklist {
  checklists = checklists.some((entry) => entry.id === checklist.id)
    ? checklists.map((entry) => (entry.id === checklist.id ? checklist : entry))
    : [checklist, ...checklists];
  revisions.set(checklist.id, ++revision);
  return checklist;
}

async function refresh() {
  if (!browser) return;
  error = '';
  const startedAt = revision;
  try {
    const res = await apiFetch(apiUrl('/api/checklists'));
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(data?.error ?? 'Checklist request failed');
    // Keep anything written locally after the request went out: the panel opens
    // on mount, so a live checklist often arrives before this GET resolves and
    // replacing the array would make it vanish mid-read.
    const fresh = (data.data as Checklist[]).filter(
      (checklist) => (revisions.get(checklist.id) ?? 0) <= startedAt,
    );
    const localDuringLoad = checklists.filter(
      (checklist) => (revisions.get(checklist.id) ?? 0) > startedAt,
    );
    checklists = [...localDuringLoad, ...fresh];
    loaded = true;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Checklist request failed';
  }
}

async function create(input: {
  title: string;
  items?: string[];
  scope?: ChecklistScope;
  projectPath?: string;
  sessionId?: string;
}) {
  const sessionId = input.sessionId ?? sessionStore.activeSessionId ?? undefined;
  return upsert(
    await request('/api/checklists', {
      method: 'POST',
      // A list started from a chat belongs to that chat. Workspace scope is
      // reachable from every chat by design, so leaving it as the default made
      // a plan the user opened in one chat turn up in all of them.
      body: JSON.stringify({
        ...input,
        ...(sessionId ? { sessionId } : {}),
        scope: input.scope ?? (sessionId ? 'session' : 'workspace'),
      }),
    }),
  );
}

/** Replace the plan. Existing items keep their state because the server reads
 *  status from disk rather than from this payload. */
async function editItems(id: string, items: { id?: string; title: string; order?: number }[]) {
  return upsert(
    await request(`/api/checklists/${id}/items`, {
      method: 'PATCH',
      body: JSON.stringify({ items }),
    }),
  );
}

async function addItems(id: string, titles: string[]) {
  return upsert(
    await request(`/api/checklists/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ items: titles, sessionId: sessionStore.activeSessionId }),
    }),
  );
}

async function setItemStatus(id: string, itemId: string, status: ChecklistItemStatus) {
  return upsert(
    await request(`/api/checklists/${id}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, sessionId: sessionStore.activeSessionId }),
    }),
  );
}

async function rename(id: string, title: string) {
  return upsert(
    await request(`/api/checklists/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  );
}

async function setArchived(id: string, archived: boolean) {
  return upsert(
    await request(`/api/checklists/${id}`, { method: 'PATCH', body: JSON.stringify({ archived }) }),
  );
}

async function remove(id: string) {
  const res = await apiFetch(apiUrl(`/api/checklists/${id}`), { method: 'DELETE' });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.error ?? 'Could not delete checklist');
  checklists = checklists.filter((entry) => entry.id !== id);
  revisions.set(id, ++revision);
}

/** Wrap a mutation so a failed request surfaces its message instead of silently
 *  leaving the list looking like it saved. */
async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    error = '';
    return await run();
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
    return undefined;
  }
}

function handleUpdated(payload: { checklist?: Checklist; deletedId?: string }) {
  if (payload.deletedId) {
    checklists = checklists.filter((entry) => entry.id !== payload.deletedId);
    revisions.set(payload.deletedId, ++revision);
    return;
  }
  if (payload.checklist) upsert(payload.checklist);
}

/** Lists this chat should see: its own, plus its project's.
 *
 * Checklists are chat-local. A list opened in one chat must never appear in
 * another, so `workspace` scope is deliberately not docked here: that scope
 * exists for lists an agent writes with an explicit opt-in, and docking it in
 * every chat was how a plan drafted in one conversation leaked into all of
 * them. Project checklists belong to the checkout they were written in rather
 * than to whichever chat happens to be open.
 */
function visible(): Checklist[] {
  const sessionId = sessionStore.activeSessionId;
  const projectPath = projectStore.currentPath;
  return checklists.filter((checklist) => {
    if (checklist.scope === 'session') return !!sessionId && checklist.sessionId === sessionId;
    if (checklist.scope === 'project')
      return !!projectPath && checklist.projectPath === projectPath;
    return false;
  });
}

export const checklistStore = {
  get checklists() {
    return checklists;
  },
  get loaded() {
    return loaded;
  },
  get error() {
    return error;
  },
  get visible() {
    return visible();
  },
  get active() {
    return visible().filter((checklist) => !checklist.archivedAt);
  },
  get(id: string) {
    return checklists.find((entry) => entry.id === id);
  },
  progress(checklist: Checklist) {
    return checklistProgress(checklist);
  },
  refresh,
  create: (input: Parameters<typeof create>[0]) => guard(() => create(input)),
  editItems: (id: string, items: Parameters<typeof editItems>[1]) =>
    guard(() => editItems(id, items)),
  addItems: (id: string, titles: string[]) => guard(() => addItems(id, titles)),
  setItemStatus: (id: string, itemId: string, status: ChecklistItemStatus) =>
    guard(() => setItemStatus(id, itemId, status)),
  rename: (id: string, title: string) => guard(() => rename(id, title)),
  setArchived: (id: string, archived: boolean) => guard(() => setArchived(id, archived)),
  remove: (id: string) => guard(() => remove(id)),
  handleUpdated,
};
