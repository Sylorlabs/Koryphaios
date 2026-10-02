<script lang="ts">
  // Goal Mode is a steering bar, not a dashboard. The composer keeps one slim
  // row: which goal you are steering, how far along it is, how long it has run,
  // and the three controls that actually change its fate. Everything else --
  // checklist, evidence, activity, linked chats, critic gate, priority -- lives
  // in a slide-over panel that opens on demand, so nothing competes with the
  // message you are about to send.
  import Target from 'lucide-svelte/icons/target';
  import Pause from 'lucide-svelte/icons/pause';
  import Play from 'lucide-svelte/icons/play';
  import X from 'lucide-svelte/icons/x';
  import Plus from 'lucide-svelte/icons/plus';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import ArrowUp from 'lucide-svelte/icons/arrow-up';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import ArrowUpRight from 'lucide-svelte/icons/arrow-up-right';
  import Check from 'lucide-svelte/icons/check';
  import Link2 from 'lucide-svelte/icons/link-2';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import ShieldOff from 'lucide-svelte/icons/shield-off';
  import Circle from 'lucide-svelte/icons/circle';
  import CircleDot from 'lucide-svelte/icons/circle-dot';
  import CircleCheck from 'lucide-svelte/icons/circle-check';
  import CircleSlash from 'lucide-svelte/icons/circle-slash';
  import TriangleAlert from 'lucide-svelte/icons/triangle-alert';
  import { fly } from 'svelte/transition';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { goalProgress, type Goal, type GoalItemStatus } from '@koryphaios/shared';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import {
    formatGoalRuntimeLong,
    goalChatId,
    GOAL_PHASE_LABEL,
    GOAL_STATUS_LABEL,
    goalBlockerReason,
    goalPhase,
    goalSteeringAction,
    isActiveGoal,
    moveChecklistItem,
    pickGoalForAction,
    pickSteeredGoal,
    toChecklistPlan,
    type ChecklistEdit,
    type GoalActionRequest,
    type GoalPhase,
  } from '$lib/utils/goal-actions';
  import { useSecondClock } from '$lib/utils/now-signal.svelte';
  import { onDestroy } from 'svelte';

  const activityMessage = (message: string) =>
    message.includes('|') ? message.slice(message.indexOf('|') + 1) : message;

  let error = $state('');
  let open = $state(false);
  let switching = $state(false);
  let armedStopId = $state('');
  let editing = $state(false);
  let renamingId = $state('');
  let renameDraft = $state('');
  let newCheckTitle = $state('');
  let savingChecklist = $state(false);
  let now = $state(Date.now());
  const clock = useSecondClock();
  $effect(() => {
    now = clock.now;
  });
  onDestroy(() => clock.unsubscribe());

  let activeGoals = $derived(goalStore.goals.filter(isActiveGoal));
  let steered = $derived(
    pickSteeredGoal(goalStore.goals, goalStore.selectedGoalId, sessionStore.activeSessionId ?? undefined),
  );
  let steeredPhase = $derived(steered ? goalPhase(steered) : null);
  let steeringAction = $derived(steered ? goalSteeringAction(steered) : null);
  let others = $derived(activeGoals.filter((goal) => goal.id !== steered?.id));
  let progress = $derived(steered ? goalProgress(steered) : 0);
  let doneChecks = $derived(
    steered ? steered.checklist.filter((item) => item.status === 'completed').length : 0,
  );
  // What the goal is doing right now. Without this the bar is objective + metrics
  // with a wide gap between them, and the one question a user actually has --
  // "what is it working on?" -- is only answered after opening the panel.
  let currentStep = $derived(
    steered?.checklist.find((item) => item.status === 'running' || item.status === 'blocked')
      ?.title,
  );
  let steeredInThisChat = $derived(
    !!steered && goalChatId(steered) === sessionStore.activeSessionId,
  );
  let steeredCriticActive = $derived(
    steered?.execution?.sessionId
      ? (sessionStore.sessions.find((session) => session.id === steered.execution?.sessionId)
          ?.agentOverrides?.criticGateEnabled ?? agentSettingsStore.criticActive)
      : agentSettingsStore.criticActive,
  );
  // A goal is stated once. The badge, the blocker banner, and the activity log
  // all carried the same word -- a paused goal read "Paused / Paused: … /
  // Paused because …". The badge owns the state, the banner shows only the
  // reason, and the log skips the entry that merely repeats it.
  let blockerText = $derived(steered ? goalBlockerReason(steered) : '');
  let activity = $derived(
    (steered?.activity ?? [])
      .slice(-4)
      .reverse()
      .filter((event) => {
        const message = activityMessage(event.message).trim().toLowerCase();
        const reason = blockerText.toLowerCase();
        if (!reason) return true;
        return message !== reason && !message.endsWith(reason) && !reason.includes(message);
      }),
  );
  let plan = $derived(steered ? toChecklistPlan(steered) : []);
  let canEditChecks = $derived(!!steered && isActiveGoal(steered));

  const chatTitle = (id?: string) =>
    id
      ? (sessionStore.sessions.find((session) => session.id === id)?.title ?? 'Unknown chat')
      : 'Not assigned';
  // Short and scope-only. Naming the owning chat here collided with the
  // "running in this chat" line below it and read as the same fact twice.
  const scopeDescription = (goal: Goal) =>
    goal.scope === 'workspace'
      ? 'Every chat in this workspace'
      : goal.scope === 'project'
        ? `Project · ${projectDisplayName(goal.projectPath) || 'unknown project'}`
        : 'This chat only';
  const executionDescription = (goal: Goal) =>
    !goal.execution?.sessionId
      ? 'Not started yet'
      : `${GOAL_STATUS_LABEL[goal.status]} in ${
          goal.execution.sessionId === sessionStore.activeSessionId
            ? 'this chat'
            : chatTitle(goal.execution.sessionId)
        }`;
  const linkedChatNames = (goal: Goal) => goal.linkedSessionIds.map((id) => chatTitle(id));

  const PHASE_COLOR: Record<GoalPhase, string> = {
    running: 'var(--color-success)',
    paused: 'var(--color-warning)',
    going: 'var(--color-info)',
  };

  const ITEM_STATUS: Record<
    GoalItemStatus,
    { glyph: typeof Circle; color: string; label: string }
  > = {
    completed: { glyph: CircleCheck, color: 'var(--color-success)', label: 'Completed' },
    running: { glyph: CircleDot, color: 'var(--color-accent)', label: 'In progress' },
    blocked: { glyph: TriangleAlert, color: 'var(--color-error)', label: 'Blocked' },
    skipped: { glyph: CircleSlash, color: 'var(--color-text-muted)', label: 'Skipped' },
    pending: { glyph: Circle, color: 'var(--color-text-muted)', label: 'Pending' },
  };

  // The switcher is a redirect control: it takes the user to the chat running
  // the goal, then steers that goal. A goal can outlive the chat it names, so
  // only navigate to a chat the sidebar still knows about -- otherwise the
  // composer would subscribe to a session it can no longer load.
  function redirectTo(goal: Goal) {
    const chatId = goalChatId(goal);
    const chatExists = !!chatId && sessionStore.sessions.some((session) => session.id === chatId);
    if (chatId && chatExists && chatId !== sessionStore.activeSessionId) {
      sessionStore.activeSessionId = chatId;
    }
    goalStore.selectedGoalId = goal.id;
    armedStopId = '';
    error = '';
    switching = false;
  }

  function close() {
    open = false;
    switching = false;
    armedStopId = '';
    editing = false;
    renamingId = '';
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
  // Closing a goal out is irreversible, so it arms before it fires -- the same
  // two-step the slash command uses.
  async function closeOut(goal: Goal, confirmed = false) {
    if (!confirmed && armedStopId !== goal.id) {
      armedStopId = goal.id;
      error = 'Press close again to end this goal for good.';
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
      error = '';
      await goalStore.patch(goal.id, { priority: goal.priority + delta });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  async function reorder(goal: Goal, delta: number) {
    try {
      error = '';
      await goalStore.patch(goal.id, { sortOrder: goal.sortOrder + delta });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Persist a hand-edited plan. Only structure is sent; the server keeps each
   *  surviving check's status, evidence, and timestamps. */
  async function savePlan(goal: Goal, next: ChecklistEdit[]) {
    if (savingChecklist) return;
    if (!next.length) {
      error = 'A goal needs at least one check.';
      return;
    }
    if (next.some((item) => !item.title.trim())) {
      error = 'Every check needs a title.';
      return;
    }
    try {
      error = '';
      savingChecklist = true;
      await goalStore.editChecklist(
        goal.id,
        next.map((item, index) => ({
          ...item,
          title: item.title.trim(),
          order: index,
        })),
      );
      renamingId = '';
      renameDraft = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      savingChecklist = false;
    }
  }

  function addCheck(goal: Goal) {
    const title = newCheckTitle.trim();
    if (!title) return;
    newCheckTitle = '';
    void savePlan(goal, [...plan, { title, order: plan.length, dependsOn: [] }]);
  }
  function commitRename(goal: Goal, id: string) {
    const title = renameDraft.trim();
    renamingId = '';
    if (!title) {
      renameDraft = '';
      return;
    }
    if (title === plan.find((item) => item.id === id)?.title) {
      renameDraft = '';
      return;
    }
    void savePlan(
      goal,
      plan.map((item) => (item.id === id ? { ...item, title } : item)),
    );
  }
  function deleteCheck(goal: Goal, id: string) {
    const index = plan.findIndex((item) => item.id === id);
    if (index < 0) return;
    void savePlan(goal, moveChecklistItem(plan, index, plan.length - 1).slice(0, -1));
  }
  function nudgeCheck(goal: Goal, from: number, to: number) {
    void savePlan(goal, moveChecklistItem(plan, from, to));
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

  function handleAction(request: GoalActionRequest) {
    if (request.action === 'goal_create') return; // creation lives in the composer
    // A lifecycle action implies the user wants the goal on screen.
    goalDisplayStore.update({ composer: true });
    error = '';
    const goal = target(request);
    if (!goal) {
      close();
      error =
        request.action === 'goal_resume'
          ? 'No paused or blocked goal is available in this context.'
          : 'No eligible active goal is available in this context.';
      return;
    }
    switching = false;
    // `/goal` and the sidebar's goal chip only ask to see the goal; every other
    // action is a steering decision and closes the surface it was issued from.
    open = request.action === 'goal_open';
    if (open) return;
    armedStopId = '';
    if (request.action === 'goal_pause') void pause(goal);
    if (request.action === 'goal_resume') void resume(goal);
    if (request.action === 'goal_prioritize') void updatePriority(goal, 1);
    if (request.action === 'goal_invoke')
      void (goal.status === 'paused' || goal.status === 'blocked'
        ? resume(goal)
        : drive(goal.id));
    if (request.action === 'goal_stop') void closeOut(goal, request.source === 'slash');
  }

  $effect(() => {
    if (!goalStore.loaded) void goalStore.refresh();
  });

  $effect(() => {
    const command = (event: Event) => {
      const detail = (event as CustomEvent<string | GoalActionRequest>).detail;
      const request: GoalActionRequest =
        typeof detail === 'string' ? { action: detail as GoalActionRequest['action'] } : detail;
      handleAction(request);
    };
    window.addEventListener('kory:goal-action', command);
    return () => window.removeEventListener('kory:goal-action', command);
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (switching) {
      switching = false;
      return;
    }
    if (open) close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if goalDisplayStore.composer && goalStore.loaded && (activeGoals.length > 0 || error)}
  <div class="relative z-20 mb-2" role="group" aria-label="Goal Mode">
    <!-- Click-away catcher. Sits behind the panel so steering never needs a
         modal, and closes the surface on any outside press. -->
    {#if open || switching}
      <button
        type="button"
        class="fixed inset-0 z-30 cursor-default"
        style="background: transparent;"
        aria-label="Dismiss goal details"
        tabindex="-1"
        onclick={close}
      ></button>
    {/if}

    <!-- ── Slide-over detail panel ─────────────────────────────────────── -->
    {#if open && steered}
      <section
        class="absolute bottom-full left-0 z-40 mb-2 w-[min(38rem,100%)] overflow-y-auto rounded-xl border p-4 shadow-2xl"
        style="background: var(--color-surface-1); border-color: color-mix(in srgb, {steeredPhase
          ? PHASE_COLOR[steeredPhase]
          : 'var(--color-accent)'} 30%, var(--color-border)); max-height: min(62vh, 34rem);"
        aria-label="Goal details"
        transition:fly={{ y: 8, duration: 160 }}
      >
        <header class="mb-3 flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="text-[13px] leading-snug font-semibold text-[var(--color-text-primary)]">
              {steered.objective}
            </h3>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
              <span
                class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style="color: {steeredPhase ? PHASE_COLOR[steeredPhase] : 'var(--color-text-muted)'}; background: color-mix(in srgb, {steeredPhase
                  ? PHASE_COLOR[steeredPhase]
                  : 'var(--color-text-muted)'} 14%, transparent);"
              >
                <span class="status-dot" class:live={steered.status === 'running'}
                ></span>{GOAL_STATUS_LABEL[steered.status]}
              </span>
              <span>Going for {formatGoalRuntimeLong(steered, now)}</span>
              <span>· {scopeDescription(steered)}</span>
              {#if !steeredInThisChat}<span
                  >· {executionDescription(steered)}</span
                >{/if}
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
            aria-label="Collapse goal details"
            title="Close"
            onclick={close}
          >
            <ChevronDown size={15} />
          </button>
        </header>

        <!-- One line, not three. The header already names the chat this goal runs
             in, and the Critic sentence is reference copy, so it lives in the
             title rather than as a paragraph under every goal. -->
        <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-secondary)]">
          <span class="flex items-center gap-1.5">
            {#if steeredCriticActive}<ShieldCheck size={12} /> Critic quality gate on{:else}<ShieldOff
                size={12}
              /> Critic quality gate off{/if}
          </span>
          {#if steered.status === 'running'}
            <span
              class="text-[var(--color-text-muted)]"
              title={steeredCriticActive
                ? 'The manager is working. The Critic quality-gates completion and blocker claims.'
                : 'The manager can submit evidence, but completion and blocker claims pause until the Critic is enabled.'}
            >
              {steeredCriticActive ? 'The Critic is checking this work' : 'No Critic on this work'}
            </span>
          {/if}
        </div>

        {#if blockerText}
          <p
            class="mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[11px]"
            style="color: var(--color-warning); background: var(--color-warning-bg);"
          >
            <TriangleAlert size={13} class="mt-px shrink-0" />
            <!-- The status badge above already says Paused/Blocked, so this line
                 carries only the reason. -->
            <span>{blockerText}</span>
          </p>
        {/if}

        <div aria-label="Goal progress" class="mb-3">
          <div class="mb-1.5 flex items-baseline justify-between gap-2">
            <span class="text-[11px] font-medium text-[var(--color-text-secondary)]">Checks</span>
            <span class="text-[11px] tabular-nums text-[var(--color-text-muted)]"
              >{progress}% · {doneChecks}/{steered.checklist.length} done</span
            >
          </div>
          <div class="h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
            <div
              class="h-full rounded-full transition-[width] duration-300"
              style="width: {progress}%; background: {steeredPhase
                ? PHASE_COLOR[steeredPhase]
                : 'var(--color-accent)'};"
            ></div>
          </div>
        </div>

        <ul class="mb-3" aria-label="Goal checklist">
          {#each steered.checklist as item, index (item.id)}
            {@const meta = ITEM_STATUS[item.status]}
            {@const Glyph = meta.glyph}
            <li
              class="group/check flex items-start gap-2 border-t border-[var(--color-border)] py-1.5 text-[11px] text-[var(--color-text-secondary)] first:border-t-0"
            >
              <Glyph size={13} class="mt-px shrink-0" style="color: {meta.color};" />
              <span class="min-w-0 flex-1">
                {#if editing && renamingId === item.id}
                  <input
                    class="check-input"
                    aria-label="Rename check"
                    bind:value={renameDraft}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') commitRename(steered, item.id);
                      if (event.key === 'Escape') {
                        renamingId = '';
                        renameDraft = '';
                      }
                    }}
                    onblur={() => commitRename(steered, item.id)}
                  />
                {:else}
                  <span class="block break-words">{item.title}</span>
                {/if}
                <span class="sr-only">{meta.label}</span>
                {#if item.evidence.length}
                  <span class="mt-0.5 block break-words text-[10px] text-[var(--color-text-muted)]">
                    {item.evidence[item.evidence.length - 1]?.value}
                  </span>
                {/if}
              </span>
              {#if editing}
                {#if renamingId !== item.id}
                  <span class="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      class="icon-button h-5 w-5"
                      aria-label="Rename check: {item.title}"
                      title="Rename"
                      disabled={savingChecklist}
                      onclick={() => {
                        renamingId = item.id;
                        renameDraft = item.title;
                      }}><Pencil size={11} /></button
                    >
                    <button
                      type="button"
                      class="icon-button h-5 w-5"
                      aria-label="Move check up: {item.title}"
                      title="Move up"
                      disabled={index === 0 || savingChecklist}
                      onclick={() => nudgeCheck(steered, index, index - 1)}><ArrowUp size={11} /></button
                    >
                    <button
                      type="button"
                      class="icon-button h-5 w-5"
                      aria-label="Move check down: {item.title}"
                      title="Move down"
                      disabled={index === steered.checklist.length - 1 || savingChecklist}
                      onclick={() => nudgeCheck(steered, index, index + 1)}><ArrowDown
                        size={11} /></button
                    >
                    <button
                      type="button"
                      class="icon-button h-5 w-5"
                      style="color: var(--color-error);"
                      aria-label="Delete check: {item.title}"
                      title="Delete"
                      disabled={item.status === 'running' || savingChecklist}
                      onclick={() => deleteCheck(steered, item.id)}><Trash2 size={11} /></button
                    >
                  </span>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>

        {#if canEditChecks}
          {#if editing}
            <form
              class="mb-3 flex items-center gap-1.5"
              onsubmit={(event) => {
                event.preventDefault();
                addCheck(steered);
              }}
            >
              <input
                class="check-input flex-1"
                aria-label="New check"
                placeholder="Add a check"
                bind:value={newCheckTitle}
              />
              <button
                type="submit"
                class="steer-button"
                disabled={savingChecklist || !newCheckTitle.trim()}
                onclick={() => addCheck(steered)}><Plus size={12} /> Add</button
              >
              <button
                type="button"
                class="icon-button"
                aria-label="Done editing checks"
                title="Done"
                onclick={() => {
                  editing = false;
                  renamingId = '';
                  newCheckTitle = '';
                }}><Check size={13} /></button
              >
            </form>
          {:else}
            <button
              type="button"
              class="mb-3 text-[11px] text-[var(--color-text-muted)] underline-offset-2 transition-colors hover:text-[var(--color-text-primary)] hover:underline"
              onclick={() => (editing = true)}
            >
              Edit checks
            </button>
          {/if}
        {/if}

        {#if isActiveGoal(steered)}
          <div class="mb-3 flex flex-wrap items-center gap-1.5">
            <!-- One combined lifecycle control. Start / Resume share the play
                 glyph because they do the same thing; only a running goal shows
                 the pause glyph, which is the only state that can be paused. -->
            {#if steeringAction === 'pause'}
              <button
                type="button"
                class="steer-button"
                onclick={() => void pause(steered)}><Pause size={12} /> Pause</button
              >
            {:else if steeringAction === 'resume'}
              <button
                type="button"
                class="steer-button"
                style="color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-border));"
                onclick={() => void resume(steered)}><Play size={12} /> Resume</button
              >
            {:else if steeringAction === 'start'}
              <button
                type="button"
                class="steer-button"
                onclick={() => void drive(steered.id)}><Play size={12} /> Start</button
              >
            {/if}
            <button
              type="button"
              class="steer-button {armedStopId === steered.id
                ? ''
                : 'text-[var(--color-text-muted)]'}"
              style={armedStopId === steered.id
                ? 'color: var(--color-error); border-color: color-mix(in srgb, var(--color-error) 50%, var(--color-border)); background: var(--color-error-bg);'
                : ''}
              onclick={() => void closeOut(steered)}
            >
              <X size={12} />
              {armedStopId === steered.id ? 'Confirm close out' : 'Close out'}
            </button>
            <span class="ml-auto flex items-center gap-1">
              <button
                type="button"
                class="icon-button"
                aria-label="Raise goal priority"
                title="Raise priority"
                onclick={() => void updatePriority(steered, 1)}><ArrowUp size={12} /></button
              >
              <button
                type="button"
                class="icon-button"
                aria-label="Send goal later in the queue"
                title="Send later in the queue"
                onclick={() => void reorder(steered, 1)}><ArrowDown size={12} /></button
              >
            </span>
          </div>
        {/if}

        {#if steered.linkedSessionIds.length}
          <div class="border-t border-[var(--color-border)] pt-2">
            <div class="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-[var(--color-text-muted)]">
              <Link2 size={11} /> Chats used by this goal
            </div>
            <p class="break-words text-[10px] text-[var(--color-text-muted)]">
              {linkedChatNames(steered).join(', ')}
            </p>
          </div>
        {/if}

        {#if activity.length}
          <div class="mt-2 border-t border-[var(--color-border)] pt-2">
            <div class="mb-1 text-[10px] font-medium text-[var(--color-text-muted)]">
              Recent activity
            </div>
            <ul class="space-y-0.5">
              {#each activity as event (event.id)}
                <li class="text-[10px] text-[var(--color-text-muted)]">
                  {activityMessage(event.message)}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </section>
    {/if}

    <!-- ── Goal switcher ────────────────────────────────────────────────── -->
    {#if switching}
      <div
        class="absolute bottom-full left-0 z-40 mb-2 max-h-72 w-[min(24rem,80vw)] overflow-y-auto rounded-lg border p-1 shadow-xl"
        style="background: var(--color-surface-2); border-color: var(--color-border);"
        role="menu"
        aria-label="Switch goal"
        transition:fly={{ y: 6, duration: 140 }}
      >
        {#each ['running', 'paused', 'going'] as phase (phase)}
          {@const bucket = activeGoals.filter((goal) => goalPhase(goal) === phase)}
          {#if bucket.length}
            <div class="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide" style="color: {PHASE_COLOR[
                phase as GoalPhase
              ]};">
              {GOAL_PHASE_LABEL[phase as GoalPhase]}
            </div>
            {#each bucket as goal (goal.id)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={goal.id === steered?.id}
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--color-surface-3)]"
                aria-label={`Open goal in its chat: ${goal.objective} — ${GOAL_PHASE_LABEL[goalPhase(goal)]}, ${formatGoalRuntimeLong(goal, now)} going`}
                title={goal.objective}
                onclick={() => redirectTo(goal)}
              >
                <span
                  class="status-dot"
                  class:live={goal.status === 'running'}
                  style="background: {PHASE_COLOR[goalPhase(goal)]};"
                ></span>
                <span class="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]"
                  >{goal.objective}</span
                >
                <span class="shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]"
                  >{formatGoalRuntimeLong(goal, now)}</span
                >
                {#if goalChatId(goal) !== sessionStore.activeSessionId}<ArrowUpRight
                    size={11}
                    class="shrink-0 text-[var(--color-text-muted)]"
                  />{/if}
                {#if goal.id === steered?.id}<Check size={12} class="shrink-0 text-[var(--color-accent)]" />{/if}
              </button>
            {/each}
          {/if}
        {/each}
        <button
          type="button"
          role="menuitem"
          class="mt-1 flex w-full items-center gap-2 border-t border-[var(--color-border)] px-2 py-1.5 text-left text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
          onclick={() => {
            switching = false;
            window.dispatchEvent(new CustomEvent('kory:goal-action', { detail: 'goal_create' }));
          }}
        >
          <Target size={12} /> New goal
        </button>
      </div>
    {/if}

    <!-- ── Steering bar ─────────────────────────────────────────────────── -->
    <!-- Sits above the click-away catcher on purpose. The bar is how you steer
         while the panel is open, so a full-screen catcher that swallowed its
         clicks would make Pause / Resume / Close unusable the moment anyone
         looked at the details. -->
    <div
      class="relative z-40 flex items-center gap-2 rounded-lg border px-2 py-1.5"
      style="background: var(--color-surface-1); border-color: color-mix(in srgb, {steeredPhase
        ? PHASE_COLOR[steeredPhase]
        : 'var(--color-accent)'} 30%, var(--color-border));"
    >
      {#if steered}
        <Target size={13} class="shrink-0 text-[var(--color-text-muted)]" />
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--color-surface-3)]"
          aria-haspopup="menu"
          aria-expanded={switching}
          aria-label={`Open goal in its chat: ${steered.objective} — ${steeredPhase
            ? GOAL_PHASE_LABEL[steeredPhase]
            : ''}, ${formatGoalRuntimeLong(steered, now)} going`}
          title={steered.objective}
          onclick={() => {
            error = '';
            switching = !switching;
            open = false;
          }}
        >
          <span
            class="status-dot shrink-0"
            class:live={steered.status === 'running'}
            style="background: {steeredPhase ? PHASE_COLOR[steeredPhase] : 'var(--color-text-muted)'};"
          ></span>
          <span
            class="max-w-[min(20rem,40vw)] truncate text-[12px] text-[var(--color-text-primary)]"
            >{steered.objective}</span
          >
          {#if currentStep}
            <span
              aria-hidden="true"
              class="hidden max-w-[18rem] truncate text-[11px] text-[var(--color-text-muted)] lg:inline"
              >· {currentStep}</span
            >
          {/if}
          {#if others.length}
            <span
              class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]"
              style="background: var(--color-surface-3);"
              >+{others.length} more</span
            >
          {/if}
          <ChevronDown size={12} class="shrink-0 text-[var(--color-text-muted)]" />
        </button>

        <span class="min-w-2 flex-1" aria-hidden="true"></span>

        <span class="hidden h-3 w-px shrink-0 sm:block" style="background: var(--color-border);"
        ></span>

        <span class="hidden items-center gap-1.5 sm:flex" aria-label="Goal progress">
          <span
            class="h-1 w-12 overflow-hidden rounded-full sm:w-16"
            style="background: var(--color-surface-3);"
          >
            <span
              class="block h-full rounded-full transition-[width] duration-300"
              style="width: {progress}%; background: {steeredPhase
                ? PHASE_COLOR[steeredPhase]
                : 'var(--color-accent)'};"
            ></span>
          </span>
          <span class="tabular-nums text-[10px] text-[var(--color-text-muted)]">{progress}%</span>
        </span>

        <span
          class="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]"
          aria-label="Time going"
          >{formatGoalRuntimeLong(steered, now)}</span
        >

        {#if steeringAction}
          <button
            type="button"
            class="steer-button shrink-0"
            style={steeringAction === 'pause'
              ? ''
              : 'color: var(--color-accent); border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));'}
            aria-label={steeringAction === 'pause'
              ? 'Pause goal'
              : steeringAction === 'resume'
                ? 'Resume goal'
                : 'Start goal'}
            title={steeringAction === 'pause'
              ? 'Pause'
              : steeringAction === 'resume'
                ? 'Resume'
                : 'Start'}
            onclick={() => {
              if (!steered) return;
              if (steeringAction === 'pause') void pause(steered);
              else if (steeringAction === 'resume') void resume(steered);
              else void drive(steered.id);
            }}
          >
            {#if steeringAction === 'pause'}<Pause size={12} />{:else}<Play size={12} />{/if}
            <span class="hidden md:inline"
              >{steeringAction === 'pause' ? 'Pause' : steeringAction === 'resume' ? 'Resume' : 'Start'}</span
            >
          </button>
        {/if}

        <button
          type="button"
          class="icon-button shrink-0 {armedStopId === steered.id
            ? 'text-[var(--color-error)]'
            : ''}"
          style={armedStopId === steered.id
            ? 'border-color: color-mix(in srgb, var(--color-error) 50%, var(--color-border)); background: var(--color-error-bg);'
            : ''}
          aria-label={armedStopId === steered.id ? 'Confirm close goal' : 'Close goal'}
          title={armedStopId === steered.id ? 'Press again to close for good' : 'Close goal'}
          onclick={() => void closeOut(steered)}
        >
          <X size={12} />
        </button>

        <button
          type="button"
          class="icon-button shrink-0"
          aria-label={open ? 'Collapse goal details' : 'Expand goal details'}
          aria-expanded={open}
          title={open ? 'Hide details' : 'Details'}
          onclick={() => {
            error = '';
            open = !open;
            switching = false;
          }}
        >
          {#if open}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
        </button>
      {/if}
    </div>

    {#if error}
      <p
        class="mt-1.5 rounded-md px-2 py-1 text-[11px]"
        style="color: var(--color-error); background: var(--color-error-bg);"
        role="alert">{error}</p
      >
    {/if}
  </div>
{/if}

<style>
  /* One live-status dot for the whole surface. The pulse is the only motion in
     Goal Mode: it says "still working" without a second timer label. */
  .status-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--color-text-muted);
  }

  .status-dot.live {
    box-shadow: 0 0 0 0 currentColor;
    animation: goal-pulse 2s var(--ease-in-out, ease-in-out) infinite;
  }

  @keyframes goal-pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.45;
      transform: scale(0.82);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-dot.live {
      animation: none;
    }
  }

  .steer-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    transition:
      background-color var(--duration-fast, 100ms) var(--ease-out, ease),
      border-color var(--duration-fast, 100ms) var(--ease-out, ease);
  }

  .steer-button:hover {
    background: var(--color-surface-3);
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
    transition: background-color var(--duration-fast, 100ms) var(--ease-out, ease);
  }

  .icon-button:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }

  .icon-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .icon-button:disabled:hover {
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
  }

  .check-input {
    width: 100%;
    padding: 3px 6px;
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    background: var(--color-surface-0);
    color: var(--color-text-primary);
    font-size: 11px;
  }

  .check-input::placeholder {
    color: var(--color-text-muted);
  }

  .steer-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
