import type { Checklist, ChecklistItemStatus, ChecklistScope } from '@koryphaios/shared';
import { checklistProgress } from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { browser } from '$app/environment';
import { sessionStore } from './sessions.svelte';

let checklists = $state<Checklist[]>([]);
let loaded = $state(false);
let error = $state('');

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
  return checklist;
}

async function refresh() {
  if (!browser) return;
  const res = await apiFetch(apiUrl('/api/checklists'));
  const data = await res.json().catch(() => null);
  if (data?.ok) {
    checklists = data.data;
    loaded = true;
  }
}

async function create(input: {
  title: string;
  items?: string[];
  scope?: ChecklistScope;
  projectPath?: string;
  sessionId?: string;
}) {
  return upsert(
    await request('/api/checklists', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionStore.activeSessionId, ...input }),
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
    return;
  }
  if (payload.checklist) upsert(payload.checklist);
}

/** Lists this chat should see: workspace-wide, plus the ones scoped to it. */
function visible(): Checklist[] {
  const sessionId = sessionStore.activeSessionId;
  return checklists.filter(
    (checklist) =>
      checklist.scope === 'workspace' ||
      (checklist.scope === 'session' && checklist.sessionId === sessionId),
  );
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
