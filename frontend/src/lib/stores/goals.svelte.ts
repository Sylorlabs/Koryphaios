import type { Goal, GoalScope } from '@koryphaios/shared';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { browser } from '$app/environment';
import { sessionStore } from './sessions.svelte';

let goals = $state<Goal[]>([]);
let selectedGoalId = $state('');
let loaded = false;
async function refresh() {
  if (!browser) return;
  const res = await apiFetch(apiUrl('/api/goals'));
  const data = await res.json().catch(() => null);
  if (data?.ok) {
    goals = data.data;
    loaded = true;
  }
}
async function create(input: {
  objective: string;
  scope: GoalScope;
  projectPath?: string;
  sessionId?: string;
  planningDepth?: 'minimal' | 'adaptive' | 'structured';
}) {
  const res = await apiFetch(apiUrl('/api/goals'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? 'Could not create goal');
  goals = goals.some((g) => g.id === data.data.id)
    ? goals.map((g) => (g.id === data.data.id ? data.data : g))
    : [...goals, data.data];
  selectedGoalId = data.data.id;
  return data.data as Goal;
}
async function patch(
  id: string,
  input: Omit<Partial<Goal>, 'blocker'> & { blocker?: string | null },
) {
  const res = await apiFetch(apiUrl(`/api/goals/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? 'Could not update goal');
  goals = goals.map((g) => (g.id === id ? data.data : g));
  return data.data as Goal;
}
async function drive(
  id: string,
  options: {
    provider?: string;
    model?: string;
    reasoningLevel?: string;
    instructions?: string;
    remotePlanApproved?: boolean;
  } = {},
) {
  const sessionId = sessionStore.activeSessionId;
  if (!sessionId) throw new Error('Open a chat before driving a goal');
  const model =
    options.model ??
    (browser ? (localStorage.getItem('koryphaios-selected-model') ?? undefined) : undefined);
  const provider = options.provider ?? model?.split(':')[0];
  if (!provider || !model)
    throw new Error('Select a provider model in the composer before driving a goal');
  const res = await apiFetch(apiUrl(`/api/goals/${id}/drive`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      provider,
      model,
      reasoningLevel: options.reasoningLevel,
      instructions: options.instructions,
      remotePlanApproved: options.remotePlanApproved,
    }),
  });
  const data = await res.json();
  if (data.data) goals = goals.map((g) => (g.id === id ? data.data : g));
  if (!data.ok) throw new Error(data.error ?? 'Could not drive goal');
  return data;
}
async function completeItem(goalId: string, itemId: string, value: string) {
  const res = await apiFetch(apiUrl(`/api/goals/${goalId}/checklist/${itemId}/complete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'check', value }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? 'Could not record evidence');
  goals = goals.map((g) => (g.id === goalId ? data.data : g));
  return data.data as Goal;
}
async function finalize(id: string) {
  const res = await apiFetch(apiUrl(`/api/goals/${id}/finalize`), { method: 'POST' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? 'Goal is not ready to complete');
  goals = goals.map((g) => (g.id === id ? data.data : g));
  return data.data as Goal;
}
async function lifecycle(id: string, action: 'pause' | 'resume' | 'stop') {
  const res = await apiFetch(apiUrl(`/api/goals/${id}/${action}`), { method: 'POST' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? `Could not ${action} goal`);
  goals = goals.map((g) => (g.id === id ? data.data : g));
  return data.data as Goal;
}
function handleUpdated(payload: { goal?: Goal; deletedId?: string }) {
  if (payload.deletedId) {
    goals = goals.filter((g) => g.id !== payload.deletedId);
    if (selectedGoalId === payload.deletedId) selectedGoalId = '';
    return { isNew: false, managerCreated: false };
  }
  if (!payload.goal) return { isNew: false, managerCreated: false };
  const isNew = !goals.some((g) => g.id === payload.goal!.id);
  goals = isNew
    ? [...goals, payload.goal]
    : goals.map((g) => (g.id === payload.goal!.id ? payload.goal! : g));
  return {
    isNew,
    managerCreated:
      isNew && payload.goal.activity.some((event) => event.type === 'manager_created'),
  };
}
export const goalStore = {
  get goals() {
    return goals;
  },
  get selectedGoalId() {
    return selectedGoalId;
  },
  set selectedGoalId(value: string) {
    selectedGoalId = value;
  },
  get selectedGoal() {
    return goals.find((g) => g.id === selectedGoalId);
  },
  get loaded() {
    return loaded;
  },
  refresh,
  create,
  patch,
  drive,
  completeItem,
  finalize,
  pause: (id: string) => lifecycle(id, 'pause'),
  resume: (id: string) => lifecycle(id, 'resume'),
  stop: (id: string) => lifecycle(id, 'stop'),
  handleUpdated,
};
