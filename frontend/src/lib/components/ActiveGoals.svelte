<script lang="ts">
  import { Target, Pause, Play, Square, Plus, ArrowUp, ArrowDown, X, Link2, ChevronDown, ChevronRight } from 'lucide-svelte';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { goalProgress, type Goal, type GoalScope } from '@koryphaios/shared';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import { formatGoalRuntime, groupGoals, isActiveGoal, pickGoalForAction, type GoalActionRequest } from '$lib/utils/goal-actions';
  import KorySelect from './KorySelect.svelte';
  import { onMount } from 'svelte';
  import { useNow } from '$lib/utils/now-signal.svelte';

  const scopeOptions = [
    { value: 'workspace', label: 'Workspace', description: 'Available from every chat' },
    { value: 'project', label: 'Project', description: 'Restricted to this project' },
    { value: 'session', label: 'This chat', description: 'Restricted to the active chat' },
  ];
  const elapsed = (ms: number) => `${Math.floor(ms / 60000)}m active`;
  let error = $state('');
  let objective = $state('');
  let scope = $state<GoalScope>('workspace');
  let composer = $state<HTMLInputElement>();
  let expanded = $state(false);
  let stopArmed = $state('');
  let activeGoals = $derived(goalStore.goals.filter((goal) => ['queued', 'planning', 'running', 'paused', 'blocked'].includes(goal.status)));

  async function create() {
    try {
      error = '';
      if (!objective.trim()) { composer?.focus(); return; }
      if (scope === 'project' && !projectStore.currentPath) throw new Error('Open a project before creating a project goal');
      if (scope === 'session' && !sessionStore.activeSessionId) throw new Error('Open a chat before creating a chat goal');
      const goal = await goalStore.create({ objective: objective.trim(), scope, projectPath: scope === 'project' ? projectStore.currentPath ?? undefined : undefined, sessionId: scope === 'session' ? sessionStore.activeSessionId ?? undefined : undefined, planningDepth: agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive' });
      objective = '';
      if (sessionStore.activeSessionId && localStorage.getItem('koryphaios-selected-model')) await drive(goal.id);
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
  }

  async function drive(goalId: string) { try { error = ''; await goalStore.drive(goalId); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function updatePriority(delta: number) { const goal = goalStore.selectedGoal; if (!goal) return; try { await goalStore.patch(goal.id, { priority: goal.priority + delta }); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function reorder(delta: number) { const goal = goalStore.selectedGoal; if (!goal) return; try { await goalStore.patch(goal.id, { sortOrder: goal.sortOrder + delta }); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function pauseOrResume() { const goal = goalStore.selectedGoal; if (!goal) return; try { error = ''; if (goal.status === 'paused' || goal.status === 'blocked') await goalStore.resume(goal.id); else await goalStore.pause(goal.id); } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  async function stopGoal(goalId: string) { if (stopArmed !== goalId) { stopArmed = goalId; return; } try { error = ''; await goalStore.stop(goalId); stopArmed = ''; } catch (err) { error = err instanceof Error ? err.message : String(err); } }
  const statusLabel = (status: string) => ({ queued: 'Starting', planning: 'Planning', running: 'Running autonomously', paused: 'Paused by you', blocked: 'Blocked — needs help' }[status] ?? status);
  onMount(() => {
    void goalStore.refresh();
    const command = (event: Event) => {
      const detail = (event as CustomEvent<string | GoalActionRequest>).detail;
      const request: GoalActionRequest = typeof detail === 'string' ? { action: detail as GoalActionRequest['action'] } : detail;
      expanded = true; error = '';
      if (request.action === 'goal_create') { objective = request.objective ?? objective; setTimeout(() => composer?.focus(), 0); return; }
      const goal = target(request);
      if (!goal) { error = request.action === 'goal_resume' ? 'No paused or blocked goal is available in this context.' : 'No eligible active goal is available in this context.'; return; }
      if (request.action === 'goal_pause') void pause(goal);
      if (request.action === 'goal_resume') void resume(goal);
      if (request.action === 'goal_prioritize') void updatePriority(goal, 1);
      if (request.action === 'goal_invoke') void (goal.status === 'paused' || goal.status === 'blocked' ? resume(goal) : drive(goal.id));
      if (request.action === 'goal_stop') void stop(goal, request.source === 'slash');
    };
    window.addEventListener('kory:goal-action', command);
    return () => { nowClock.unsubscribe(); window.removeEventListener('kory:goal-action', command); };
  });
</script>

<section class="shrink-0 border-t border-[var(--color-border)] p-3 {expanded ? 'flex min-h-[280px] max-h-[52%] flex-col' : ''}" aria-label="Active Goals">
  <div class="flex items-center gap-1">
    <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold text-[var(--color-text-secondary)]" aria-expanded={expanded} onclick={() => expanded = !expanded}>
      <Target size={14} /> Goals <span class="text-[10px] font-normal text-[var(--color-text-muted)]">{activeGoals.length || ''}</span><span class="ml-auto">{#if expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}</span>
    </button>
    <button type="button" class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]" aria-label="Hide Goals panel" title="Hide Goals panel" onclick={() => goalDisplayStore.update({ sidebar: false })}><X size={13} /></button>
  </div>
  {#if expanded}<div class="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
  <div class="space-y-1.5">
    <input bind:this={composer} aria-label="New goal" class="min-w-0 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]" placeholder="What should Koryphaios accomplish?" bind:value={objective} onkeydown={(event) => { if (event.key === 'Enter') void create(); }} />
    <div class="flex gap-1"><div class="min-w-0 flex-1"><KorySelect compact value={scope} label="Goal scope" options={scopeOptions} onchange={(value) => scope = value as GoalScope} /></div><button type="button" class="rounded-lg border border-[var(--color-border)] px-2 text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]" onclick={() => void create()} aria-label="Create goal"><Plus size={13} /></button></div>
  </div>
  {#each activeGoals as goal (goal.id)}
    <button type="button" class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]" aria-label={`Open goal: ${goal.objective}`} aria-pressed={goalStore.selectedGoalId === goal.id} onclick={() => goalStore.selectedGoalId = goal.id}>
      <div class="flex justify-between gap-2 text-xs"><span class="truncate font-medium text-[var(--color-text-primary)]">{goal.objective}</span><span class="capitalize text-[var(--color-text-muted)]">{goal.scope}</span></div>
      <div class="mt-2 h-1.5 overflow-hidden rounded bg-[var(--color-surface-3)]"><div class="h-full bg-[var(--color-accent)]" style={`width: ${goalProgress(goal)}%`}></div></div>
      <div class="mt-1 flex justify-between text-[10px] text-[var(--color-text-muted)]"><span>{goalProgress(goal)}% · {statusLabel(goal.status)}</span><span>{elapsed(goal.activeDurationMs)}</span></div>
    </button>
  {/each}
  {#if goalStore.loaded && activeGoals.length === 0}<p class="text-xs text-[var(--color-text-muted)]">No active goals yet.</p>{/if}
  {#if goalStore.selectedGoal}
    <div class="max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2 text-xs">
      <div class="mb-2 flex items-center justify-between gap-2"><div class="font-medium text-[var(--color-text-primary)]">Goal checklist</div><div class="flex gap-1"><button type="button" class="rounded border border-[var(--color-border)] p-1" aria-label="Increase goal priority" onclick={() => void updatePriority(1)}><ArrowUp size={12} /></button><button type="button" class="rounded border border-[var(--color-border)] p-1" aria-label="Move goal later" onclick={() => void reorder(1)}><ArrowDown size={12} /></button></div></div>
      {#each goalStore.selectedGoal.checklist as item (item.id)}
        <div class="border-t border-[var(--color-border)] py-1.5 text-[var(--color-text-secondary)]"><div class="flex gap-2"><span>{item.status === 'completed' ? '✓' : item.status === 'blocked' ? '!' : '○'}</span><span>{item.title}</span></div>
          {#if item.status === 'running'}<p class="mt-1 pl-5 text-[10px] text-[var(--color-accent)]">Manager is working; an independent critic will decide when this item is complete.</p>{/if}
          {#if item.evidence.length}<p class="mt-1 pl-5 text-[10px] text-[var(--color-text-muted)]">Evidence: {item.evidence[item.evidence.length - 1]?.value}</p>{/if}
        </div>
      {/each}
      <div class="mt-2 flex flex-wrap gap-1">
        {#if goalStore.selectedGoal.status === 'queued' && !goalStore.selectedGoal.execution}<button type="button" class="rounded border border-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-accent)]" onclick={() => drive(goalStore.selectedGoal!.id)}><Play size={11} class="inline" /> Start goal</button>{/if}
        {#if goalStore.selectedGoal.status === 'paused' || goalStore.selectedGoal.status === 'blocked'}<button type="button" class="rounded border border-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-accent)]" onclick={() => void pauseOrResume()}><Play size={11} class="inline" /> Resume</button>{:else if ['queued', 'planning', 'running'].includes(goalStore.selectedGoal.status)}<button type="button" class="rounded border border-[var(--color-border)] px-2 py-1 text-xs" onclick={() => void pauseOrResume()}><Pause size={11} class="inline" /> Pause</button>{/if}
        <button type="button" class="rounded border border-red-500/50 px-2 py-1 text-xs text-red-400" onclick={() => void stopGoal(goalStore.selectedGoal!.id)} onblur={() => stopArmed = ''}><Square size={10} class="inline" /> {stopArmed === goalStore.selectedGoal.id ? 'Confirm stop' : 'Stop goal'}</button>
      </div>
      <div class="mt-2 border-t border-[var(--color-border)] pt-2"><div class="flex items-center gap-1 text-[10px] font-medium text-[var(--color-text-muted)]"><Link2 size={11} /> Linked chats</div><p class="text-[10px] text-[var(--color-text-muted)]">{goalStore.selectedGoal.linkedSessionIds.length ? goalStore.selectedGoal.linkedSessionIds.join(', ') : 'None yet'}</p></div>
      {#if goalStore.selectedGoal.activity.length}<div class="mt-2 border-t border-[var(--color-border)] pt-2"><div class="text-[10px] font-medium text-[var(--color-text-muted)]">Activity</div>{#each goalStore.selectedGoal.activity.slice(-4).reverse() as event (event.id)}<p class="mt-1 text-[10px] text-[var(--color-text-muted)]">{event.message}</p>{/each}</div>{/if}
      {#if goalStore.selectedGoal.blocker}<p class="mt-2 text-amber-400">{goalStore.selectedGoal.status === 'paused' ? 'Paused: ' : 'Blocked: '}{goalStore.selectedGoal.blocker}</p>{/if}
    </div>
  {/if}
</section>
