<script lang="ts">
  import { Target, Pause, Play, Check, Plus, ArrowUp, ArrowDown, X, Link2, ChevronDown, ChevronRight } from 'lucide-svelte';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { goalProgress, type GoalScope } from '@koryphaios/shared';
  import { projectStore } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import KorySelect from './KorySelect.svelte';
  import { onMount } from 'svelte';

  const scopeOptions = [
    { value: 'workspace', label: 'Workspace', description: 'Available from every chat' },
    { value: 'project', label: 'Project', description: 'Restricted to this project' },
    { value: 'session', label: 'This chat', description: 'Restricted to the active chat' },
  ];
  const elapsed = (ms: number) => `${Math.floor(ms / 60000)}m active`;
  let evidence = $state<Record<string, string>>({});
  let error = $state('');
  let objective = $state('');
  let scope = $state<GoalScope>('workspace');
  let composer = $state<HTMLInputElement>();
  let expanded = $state(false);

  async function create() {
    try {
      error = '';
      if (!objective.trim()) { composer?.focus(); return; }
      if (scope === 'project' && !projectStore.currentPath) throw new Error('Open a project before creating a project goal');
      if (scope === 'session' && !sessionStore.activeSessionId) throw new Error('Open a chat before creating a session goal');
      const goal = await goalStore.create({ objective: objective.trim(), scope, projectPath: scope === 'project' ? projectStore.currentPath ?? undefined : undefined, sessionId: scope === 'session' ? sessionStore.activeSessionId ?? undefined : undefined, planningDepth: agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive' });
      objective = '';
      if (agentSettingsStore.settings.automaticGoalDriving && sessionStore.activeSessionId && localStorage.getItem('koryphaios-selected-model')) await drive(goal.id);
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
  }
  async function drive(goalId: string) { try { error = ''; await goalStore.drive(goalId); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function complete(goalId: string, itemId: string) { try { error = ''; const value = evidence[itemId]?.trim(); if (!value) throw new Error('Attach concrete verification evidence before completing this item'); const goal = await goalStore.completeItem(goalId, itemId, value); evidence = { ...evidence, [itemId]: '' }; if (agentSettingsStore.settings.automaticGoalDriving && goal.checklist.some((entry) => entry.status === 'pending')) await drive(goalId); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function finalize(goalId: string) { try { error = ''; await goalStore.finalize(goalId); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function updatePriority(delta: number) { const goal = goalStore.selectedGoal; if (!goal) return; try { await goalStore.patch(goal.id, { priority: goal.priority + delta }); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function reorder(delta: number) { const goal = goalStore.selectedGoal; if (!goal) return; try { await goalStore.patch(goal.id, { sortOrder: goal.sortOrder + delta }); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function pauseOrResume() { const goal = goalStore.selectedGoal; if (!goal) return; try { await goalStore.patch(goal.id, { status: goal.status === 'paused' || goal.status === 'blocked' ? 'queued' : 'paused', blocker: null }); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  onMount(() => {
    void goalStore.refresh();
    const command = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      const goal = goalStore.selectedGoal;
      if (action === 'goal_create') { expanded = true; setTimeout(() => composer?.focus(), 0); }
      if (action === 'goal_open') { if (!goalStore.selectedGoalId) goalStore.selectedGoalId = goalStore.goals[0]?.id ?? ''; expanded = true; }
      if (action === 'goal_pause' && goal && goal.status !== 'paused') void pauseOrResume();
      if (action === 'goal_resume' && goal?.status === 'paused') void pauseOrResume();
      if (action === 'goal_prioritize') void updatePriority(1);
      if (action === 'goal_invoke' && goal) void drive(goal.id);
    };
    window.addEventListener('kory:goal-action', command);
    return () => window.removeEventListener('kory:goal-action', command);
  });
</script>

<section class="shrink-0 border-t border-[var(--color-border)] p-3" aria-label="Active Goals">
  <button type="button" class="flex w-full items-center gap-2 text-left text-xs font-semibold text-[var(--color-text-secondary)]" aria-expanded={expanded} onclick={() => expanded = !expanded}>
    <Target size={14} /> Goals <span class="text-[10px] font-normal text-[var(--color-text-muted)]">{goalStore.goals.filter((goal) => ['queued', 'planning', 'running', 'paused', 'blocked'].includes(goal.status)).length || ''}</span><span class="ml-auto">{#if expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}</span>
  </button>
  {#if expanded}<div class="mt-2 space-y-2">
  <div class="space-y-1.5">
    <input bind:this={composer} aria-label="New goal" class="min-w-0 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]" placeholder="What should Koryphaios accomplish?" bind:value={objective} onkeydown={(event) => { if (event.key === 'Enter') void create(); }} />
    <div class="flex gap-1"><div class="min-w-0 flex-1"><KorySelect compact value={scope} label="Goal scope" options={scopeOptions} onchange={(value) => scope = value as GoalScope} /></div><button type="button" class="rounded-lg border border-[var(--color-border)] px-2 text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]" onclick={() => void create()} aria-label="Create goal"><Plus size={13} /></button></div>
  </div>
  {#each goalStore.goals.filter((goal) => ['queued', 'planning', 'running', 'paused', 'blocked'].includes(goal.status)) as goal (goal.id)}
    <button type="button" class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]" aria-label={`Open goal: ${goal.objective}`} aria-pressed={goalStore.selectedGoalId === goal.id} onclick={() => goalStore.selectedGoalId = goal.id}>
      <div class="flex justify-between gap-2 text-xs"><span class="truncate font-medium text-[var(--color-text-primary)]">{goal.objective}</span><span class="capitalize text-[var(--color-text-muted)]">{goal.scope}</span></div>
      <div class="mt-2 h-1.5 overflow-hidden rounded bg-[var(--color-surface-3)]"><div class="h-full bg-[var(--color-accent)]" style={`width: ${goalProgress(goal)}%`}></div></div>
      <div class="mt-1 flex justify-between text-[10px] text-[var(--color-text-muted)]"><span>{goalProgress(goal)}% · {goal.status}</span><span>{elapsed(goal.activeDurationMs)}</span></div>
    </button>
  {/each}
  {#if goalStore.loaded && goalStore.goals.filter((goal) => ['queued', 'planning', 'running', 'paused', 'blocked'].includes(goal.status)).length === 0}<p class="text-xs text-[var(--color-text-muted)]">No active goals yet.</p>{/if}
  {#if goalStore.selectedGoal}
    <div class="max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2 text-xs">
      <div class="mb-2 flex items-center justify-between gap-2"><div class="font-medium text-[var(--color-text-primary)]">Goal checklist</div><div class="flex gap-1"><button type="button" class="rounded border border-[var(--color-border)] p-1" aria-label="Increase goal priority" onclick={() => void updatePriority(1)}><ArrowUp size={12} /></button><button type="button" class="rounded border border-[var(--color-border)] p-1" aria-label="Move goal later" onclick={() => void reorder(1)}><ArrowDown size={12} /></button></div></div>
      {#each goalStore.selectedGoal.checklist as item (item.id)}
        <div class="border-t border-[var(--color-border)] py-1.5 text-[var(--color-text-secondary)]"><div class="flex gap-2"><span>{item.status === 'completed' ? '✓' : item.status === 'blocked' ? '!' : '○'}</span><span>{item.title}</span></div>
          {#if item.status === 'running'}<div class="mt-1 flex gap-1"><input aria-label={`Verified evidence for ${item.title}`} class="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-1.5 py-1 text-xs text-[var(--color-text-primary)]" placeholder="Command, artifact, or check result" bind:value={evidence[item.id]} /><button type="button" class="rounded border border-[var(--color-border)] px-1.5" onclick={() => complete(goalStore.selectedGoal!.id, item.id)} aria-label={`Complete ${item.title} with verified evidence`}><Check size={12} /></button></div>{/if}
          {#if item.evidence.length}<p class="mt-1 pl-5 text-[10px] text-[var(--color-text-muted)]">Evidence: {item.evidence[item.evidence.length - 1]?.value}</p>{/if}
        </div>
      {/each}
      <div class="mt-2 flex flex-wrap gap-1"><button type="button" class="rounded border border-[var(--color-border)] px-2 py-1 text-xs" onclick={() => drive(goalStore.selectedGoal!.id)}><Play size={11} class="inline" /> Ask manager</button><button type="button" class="rounded border border-[var(--color-border)] px-2 py-1 text-xs" onclick={() => void pauseOrResume()}><Pause size={11} class="inline" /> {goalStore.selectedGoal.status === 'paused' ? 'Resume' : 'Pause'}</button><button type="button" class="rounded border border-[var(--color-border)] px-2 py-1 text-xs" onclick={() => finalize(goalStore.selectedGoal!.id)}>Finalize</button></div>
      <div class="mt-2 border-t border-[var(--color-border)] pt-2"><div class="flex items-center gap-1 text-[10px] font-medium text-[var(--color-text-muted)]"><Link2 size={11} /> Linked chats</div><p class="text-[10px] text-[var(--color-text-muted)]">{goalStore.selectedGoal.linkedSessionIds.length ? goalStore.selectedGoal.linkedSessionIds.join(', ') : 'None yet'}</p></div>
      {#if goalStore.selectedGoal.activity.length}<div class="mt-2 border-t border-[var(--color-border)] pt-2"><div class="text-[10px] font-medium text-[var(--color-text-muted)]">Activity</div>{#each goalStore.selectedGoal.activity.slice(-4).reverse() as event (event.id)}<p class="mt-1 text-[10px] text-[var(--color-text-muted)]">{event.message}</p>{/each}</div>{/if}
      {#if goalStore.selectedGoal.blocker}<p class="mt-2 text-amber-400">Blocked: {goalStore.selectedGoal.blocker}</p>{/if}
    </div>
  {/if}
  {#if error}<p class="text-xs text-red-400" role="alert">{error}</p>{/if}
  </div>{/if}
</section>
