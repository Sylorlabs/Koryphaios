<script lang="ts">
  import Target from 'lucide-svelte/icons/target';
  import Pause from 'lucide-svelte/icons/pause';
  import Play from 'lucide-svelte/icons/play';
  import Plus from 'lucide-svelte/icons/plus';
  import ArrowUp from 'lucide-svelte/icons/arrow-up';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import X from 'lucide-svelte/icons/x';
  import Link2 from 'lucide-svelte/icons/link-2';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import Square from 'lucide-svelte/icons/square';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import ShieldOff from 'lucide-svelte/icons/shield-off';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { goalProgress, type Goal, type GoalScope } from '@koryphaios/shared';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import {
    formatGoalRuntime,
    groupGoals,
    isActiveGoal,
    pickGoalForAction,
    type GoalActionRequest,
  } from '$lib/utils/goal-actions';
  import KorySelect from './KorySelect.svelte';
  import { onMount } from 'svelte';
  import { useNow } from '$lib/utils/now-signal.svelte';

  const scopeOptions = [
    { value: 'workspace', label: 'Workspace', description: 'Available from every chat' },
    { value: 'project', label: 'Project', description: 'Restricted to this project' },
    { value: 'session', label: 'This chat', description: 'Restricted to the active chat' },
  ];
  const activityMessage = (message: string) =>
    message.includes('|') ? message.slice(message.indexOf('|') + 1) : message;
  let error = $state('');
  let objective = $state('');
  let scope = $state<GoalScope>('workspace');
  let composer = $state<HTMLInputElement>();
  let expanded = $state(true);
  let showOther = $state(false);
  let armedStopId = $state('');
  let now = $state(Date.now());
  const nowClock = useNow();
  $effect(() => {
    now = nowClock.now;
  });
  let activeGoals = $derived(goalStore.goals.filter(isActiveGoal));
  let selected = $derived(goalStore.selectedGoal);
  let selectedWorkflow = $derived(
    selected?.activity
      .filter((event) => event.type === 'workflow_linked' || event.type === 'workflow_evidence')
      .at(-1),
  );
  let sections = $derived(
    groupGoals(
      goalStore.goals,
      projectStore.currentPath ?? undefined,
      sessionStore.activeSessionId ?? undefined,
    ),
  );

  const chatTitle = (id?: string) =>
    id
      ? (sessionStore.sessions.find((session) => session.id === id)?.title ?? 'Unknown chat')
      : 'Not assigned';
  const scopeDescription = (goal: Goal) =>
    goal.scope === 'workspace'
      ? 'Workspace goal · available from every chat'
      : goal.scope === 'project'
        ? `Project goal · ${projectDisplayName(goal.projectPath) || 'unknown project'}`
        : `Chat goal · owned by ${chatTitle(goal.sessionId)}`;
  const executionDescription = (goal: Goal) =>
    !goal.execution?.sessionId
      ? 'Not started in a chat yet'
      : `${goal.status === 'paused' ? 'Paused in' : goal.status === 'blocked' ? 'Blocked in' : goal.status === 'completed' ? 'Last ran in' : 'Running in'} ${goal.execution.sessionId === sessionStore.activeSessionId ? 'this chat' : chatTitle(goal.execution.sessionId)}`;
  const linkedChatNames = (goal: Goal) => goal.linkedSessionIds.map((id) => chatTitle(id));
  function openExecutionChat(goal: Goal) {
    if (goal.execution?.sessionId) sessionStore.activeSessionId = goal.execution.sessionId;
  }

  async function create() {
    try {
      error = '';
      if (!objective.trim()) {
        composer?.focus();
        return;
      }
      if (scope === 'project' && !projectStore.currentPath)
        throw new Error('Open a project before creating a project goal');
      if (scope === 'session' && !sessionStore.activeSessionId)
        throw new Error('Open a chat before creating a chat goal');
      const goal = await goalStore.create({
        objective: objective.trim(),
        scope,
        projectPath: scope === 'project' ? (projectStore.currentPath ?? undefined) : undefined,
        sessionId: scope === 'session' ? (sessionStore.activeSessionId ?? undefined) : undefined,
        planningDepth: agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive',
      });
      objective = '';
      if (agentSettingsStore.settings.automaticGoalDriving) await drive(goal.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function drive(goalId: string) {
    try {
      error = '';
      await goalStore.drive(goalId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  async function pause(goal: Goal) {
    try {
      error = '';
      await goalStore.pause(goal.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  async function resume(goal: Goal) {
    try {
      error = '';
      await goalStore.resume(goal.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  async function stop(goal: Goal, confirmed = false) {
    if (!confirmed && armedStopId !== goal.id) {
      armedStopId = goal.id;
      error = 'Press Stop again to permanently stop this goal.';
      return;
    }
    try {
      error = '';
      armedStopId = '';
      await goalStore.stop(goal.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  async function updatePriority(goal: Goal, delta: number) {
    try {
      await goalStore.patch(goal.id, { priority: goal.priority + delta });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  async function reorder(goal: Goal, delta: number) {
    try {
      await goalStore.patch(goal.id, { sortOrder: goal.sortOrder + delta });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function target(request: GoalActionRequest) {
    const goal = pickGoalForAction(
      goalStore.goals,
      goalStore.selectedGoalId,
      request.action,
      projectStore.currentPath ?? undefined,
      sessionStore.activeSessionId ?? undefined,
    );
    if (goal) goalStore.selectedGoalId = goal.id;
    return goal;
  }

  onMount(() => {
    void goalStore.refresh();
    const command = (event: Event) => {
      const detail = (event as CustomEvent<string | GoalActionRequest>).detail;
      const request: GoalActionRequest =
        typeof detail === 'string' ? { action: detail as GoalActionRequest['action'] } : detail;
      expanded = true;
      error = '';
      if (request.action === 'goal_create') {
        objective = request.objective ?? objective;
        setTimeout(() => composer?.focus(), 0);
        return;
      }
      const goal = target(request);
      if (!goal) {
        error =
          request.action === 'goal_resume'
            ? 'No paused or blocked goal is available in this context.'
            : 'No eligible active goal is available in this context.';
        return;
      }
      if (request.action === 'goal_pause') void pause(goal);
      if (request.action === 'goal_resume') void resume(goal);
      if (request.action === 'goal_prioritize') void updatePriority(goal, 1);
      if (request.action === 'goal_invoke')
        void (goal.status === 'paused' || goal.status === 'blocked'
          ? resume(goal)
          : drive(goal.id));
      if (request.action === 'goal_stop') void stop(goal, request.source === 'slash');
    };
    window.addEventListener('kory:goal-action', command);
    return () => {
      nowClock.unsubscribe();
      window.removeEventListener('kory:goal-action', command);
    };
  });
</script>

<section
  class="shrink-0 border-t border-[var(--color-border)] p-3 {expanded
    ? 'flex min-h-[280px] max-h-[52%] flex-col'
    : ''}"
  aria-label="Active Goals"
>
  <div class="flex items-center gap-1">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold text-[var(--color-text-secondary)]"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      <Target size={14} /> Goals across chats
      <span class="text-[10px] font-normal text-[var(--color-text-muted)]"
        >{activeGoals.length || ''}</span
      ><span class="ml-auto"
        >{#if expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}</span
      >
    </button>
    <button
      type="button"
      class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
      aria-label="Hide Goals panel"
      title="Hide Goals panel"
      onclick={() => goalDisplayStore.update({ sidebar: false })}><X size={13} /></button
    >
  </div>

  {#if expanded}
    <div class="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      <div
        class="space-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
      >
        <input
          bind:this={composer}
          aria-label="New goal"
          class="min-w-0 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
          placeholder="What should Koryphaios finish?"
          bind:value={objective}
          onkeydown={(event) => {
            if (event.key === 'Enter') void create();
          }}
        />
        <div class="flex gap-1">
          <div class="min-w-0 flex-1">
            <KorySelect
              compact
              value={scope}
              label="Goal scope"
              options={scopeOptions}
              onchange={(value) => (scope = value as GoalScope)}
            />
          </div>
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border)] px-2 text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
            onclick={() => void create()}
            aria-label={agentSettingsStore.settings.automaticGoalDriving
              ? 'Create and start goal'
              : 'Create goal'}><Plus size={13} /></button
          >
        </div>
        <p class="text-[10px] text-[var(--color-text-muted)]">
          {agentSettingsStore.settings.automaticGoalDriving
            ? 'Starts automatically with the selected composer model and continues until done, paused, stopped, or genuinely blocked.'
            : 'Automatic start is off. The goal will wait here until you press Start.'}
        </p>
      </div>

      {#each sections as section (section.id)}
        {#if section.goals.length > 0}
          <div class="space-y-1.5">
            {#if section.id === 'other'}
              <button
                type="button"
                class="flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                aria-expanded={showOther}
                onclick={() => (showOther = !showOther)}
                >{#if showOther}<ChevronDown size={11} />{:else}<ChevronRight
                    size={11}
                  />{/if}{section.label}<span class="ml-auto">{section.goals.length}</span></button
              >
            {:else}
              <div
                class="flex items-center text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
              >
                <span>{section.label}</span><span class="ml-auto">{section.goals.length}</span>
              </div>
            {/if}
            {#if section.id !== 'other' || showOther}
              {#each section.goals as goal (goal.id)}
                <button
                  type="button"
                  class="w-full rounded-lg border p-2 text-left transition-colors {goalStore.selectedGoalId ===
                  goal.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'}"
                  aria-label={`Open goal: ${goal.objective}`}
                  aria-pressed={goalStore.selectedGoalId === goal.id}
                  onclick={() => {
                    goalStore.selectedGoalId = goal.id;
                    armedStopId = '';
                    error = '';
                  }}
                >
                  <div class="flex justify-between gap-2 text-xs">
                    <span class="truncate font-medium text-[var(--color-text-primary)]"
                      >{goal.objective}</span
                    ><span class="capitalize text-[var(--color-text-muted)]">{goal.status}</span>
                  </div>
                  <div class="mt-2 h-1.5 overflow-hidden rounded bg-[var(--color-surface-3)]">
                    <div
                      class="h-full bg-[var(--color-accent)]"
                      style={`width: ${goalProgress(goal)}%`}
                    ></div>
                  </div>
                  <div class="mt-1 flex justify-between text-[10px] text-[var(--color-text-muted)]">
                    <span
                      >{goalProgress(goal)}% · {goal.checklist.filter(
                        (item) => item.status === 'completed',
                      ).length}/{goal.checklist.length} checks</span
                    ><span>Active {formatGoalRuntime(goal, now)}</span>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      {/each}

      {#if goalStore.loaded && activeGoals.length === 0}<p
          class="text-xs text-[var(--color-text-muted)]"
        >
          No active goals. Create one above or ask Kory to create a goal.
        </p>{/if}

      {#if selected}
        <div
          class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-xs"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="truncate font-medium text-[var(--color-text-primary)]">
                {selected.objective}
              </div>
              <div
                class="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
              >
                {#if agentSettingsStore.criticActive}<ShieldCheck size={11} /> Critic quality gate on{:else}<ShieldOff
                    size={11}
                  /> Critic quality gate off{/if}
              </div>
            </div>
            <div class="flex gap-1">
              <button
                type="button"
                class="rounded border border-[var(--color-border)] p-1"
                aria-label="Increase goal priority"
                onclick={() => void updatePriority(selected, 1)}><ArrowUp size={12} /></button
              ><button
                type="button"
                class="rounded border border-[var(--color-border)] p-1"
                aria-label="Move goal later"
                onclick={() => void reorder(selected, 1)}><ArrowDown size={12} /></button
              >
            </div>
          </div>
          <div
            class="mb-2 space-y-1 rounded-lg bg-[var(--color-surface-2)] px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]"
          >
            <p>{scopeDescription(selected)}</p>
            <div class="flex items-center justify-between gap-2">
              <span>{executionDescription(selected)}</span
              >{#if selected.execution?.sessionId && selected.execution.sessionId !== sessionStore.activeSessionId}<button
                  type="button"
                  class="shrink-0 font-medium text-[var(--color-accent)] hover:underline"
                  onclick={() => openExecutionChat(selected)}>Open chat</button
                >{/if}
            </div>
            <p>Active time · {formatGoalRuntime(selected, now)}</p>
            {#if selectedWorkflow}<p>
                Workflow · {selectedWorkflow.type === 'workflow_evidence'
                  ? 'evidence complete'
                  : 'active'} · {activityMessage(selectedWorkflow.message)}
              </p>{/if}
          </div>
          {#if selected.status === 'running'}<p
              class="mb-2 rounded bg-[var(--color-surface-2)] px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]"
            >
              {agentSettingsStore.criticActive
                ? 'Manager is working. The Critic will quality-gate completion and blocker claims.'
                : 'Manager can submit evidence, but completion and blocker claims pause until the Critic is enabled.'}
            </p>{/if}
          <div aria-label="Goal checklist">
            {#each selected.checklist as item (item.id)}
              <div
                class="border-t border-[var(--color-border)] py-1.5 text-[var(--color-text-secondary)]"
              >
                <div class="flex gap-2">
                  <span aria-hidden="true"
                    >{item.status === 'completed'
                      ? '✓'
                      : item.status === 'blocked'
                        ? '!'
                        : item.status === 'running'
                          ? '●'
                          : '○'}</span
                  ><span>{item.title}</span>
                </div>
                {#if item.evidence.length}<p
                    class="mt-1 pl-5 text-[10px] text-[var(--color-text-muted)]"
                  >
                    {item.evidence[item.evidence.length - 1]?.value}
                  </p>{/if}
              </div>
            {/each}
          </div>
          {#if isActiveGoal(selected)}
            <div class="mt-2 flex flex-wrap gap-1">
              {#if selected.status === 'paused' || selected.status === 'blocked'}<button
                  type="button"
                  class="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-3)]"
                  onclick={() => void resume(selected)}
                  ><Play size={11} class="inline" /> Resume</button
                >{:else if selected.status === 'running'}<button
                  type="button"
                  class="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-3)]"
                  onclick={() => void pause(selected)}
                  ><Pause size={11} class="inline" /> Pause</button
                >{:else}<button
                  type="button"
                  class="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-3)]"
                  onclick={() => void drive(selected.id)}
                  ><Play size={11} class="inline" /> Start</button
                >{/if}
              <button
                type="button"
                class="rounded border px-2 py-1 text-xs {armedStopId === selected.id
                  ? 'border-[var(--color-error)] text-[var(--color-error)]'
                  : 'border-[var(--color-border)]'}"
                onclick={() => void stop(selected)}
                ><Square size={10} class="inline" />
                {armedStopId === selected.id ? 'Confirm stop' : 'Stop'}</button
              >
            </div>
          {/if}
          <div class="mt-2 border-t border-[var(--color-border)] pt-2">
            <div
              class="flex items-center gap-1 text-[10px] font-medium text-[var(--color-text-muted)]"
            >
              <Link2 size={11} /> Chats used by this goal
            </div>
            <p
              class="truncate text-[10px] text-[var(--color-text-muted)]"
              title={linkedChatNames(selected).join(', ')}
            >
              {selected.linkedSessionIds.length ? linkedChatNames(selected).join(', ') : 'None yet'}
            </p>
          </div>
          {#if selected.activity.length}<div
              class="mt-2 border-t border-[var(--color-border)] pt-2"
            >
              <div class="text-[10px] font-medium text-[var(--color-text-muted)]">
                Recent activity
              </div>
              {#each selected.activity.slice(-4).reverse() as event (event.id)}<p
                  class="mt-1 text-[10px] text-[var(--color-text-muted)]"
                >
                  {activityMessage(event.message)}
                </p>{/each}
            </div>{/if}
          {#if selected.blocker}<p class="mt-2 text-[var(--color-warning)]">
              {selected.status === 'paused' ? 'Paused' : 'Blocked'}: {selected.blocker}
            </p>{/if}
        </div>
      {/if}
      {#if error}<p class="text-xs text-[var(--color-error)]" role="alert">{error}</p>{/if}
    </div>
  {/if}
</section>
