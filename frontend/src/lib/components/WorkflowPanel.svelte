<script lang="ts">
  import { onMount } from 'svelte';
  import { CheckCircle2, Circle, Play, ShieldCheck, Square, Workflow, X } from 'lucide-svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';

  type Stage = { id: string; label: string; description: string; requiresEvidence: boolean };
  type Definition = { id: string; name: string; description: string; autoStartSafe: boolean; stages: Stage[] };
  type Run = { id: string; workflowId: string; sessionId: string; task: string; status: 'running' | 'blocked' | 'completed' | 'stopped'; stageIndex: number; evidence: Array<{ stageId: string; value: string; createdAt: number }>; blocker?: string };
  type Draft = Definition & { goalId: string; goalItemId: string; status: 'draft' | 'activated'; activatedScope?: 'project' | 'personal' };

  interface Props { open: boolean; sessionId?: string; initialTask?: string; onclose: () => void; onchange?: () => void; }
  let { open, sessionId, initialTask = '', onclose, onchange }: Props = $props();
  let definitions = $state<Definition[]>([]);
  let runs = $state<Run[]>([]);
  let drafts = $state<Draft[]>([]);
  let selectedId = $state('design-quality');
  let task = $state('');
  let evidence = $state('');
  let loading = $state(false);
  let selectedRun = $derived(runs.find((run) => run.status === 'running' || run.status === 'blocked'));
  let selectedDefinition = $derived(definitions.find((definition) => definition.id === selectedId));

  async function refresh() {
    if (!sessionId) return;
    loading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/agent/workflows?sessionId=${encodeURIComponent(sessionId)}`));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Unable to load workflows');
      definitions = data.data.definitions;
      drafts = data.data.drafts ?? [];
      runs = data.data.runs;
      if (!selectedId && definitions[0]) selectedId = definitions[0].id;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Unable to load workflows');
    } finally { loading = false; }
  }

  $effect(() => { if (open) { task = initialTask || task; void refresh(); } });
  onMount(() => { if (open) void refresh(); });

  async function start() {
    if (!sessionId || !task.trim()) return;
    const res = await apiFetch(apiUrl('/api/agent/workflows/start'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: selectedId, sessionId, task: task.trim() }) });
    const data = await res.json();
    if (!res.ok || !data.ok) return toastStore.error(data.error ?? 'Unable to start workflow');
    evidence = '';
    await refresh();
    onchange?.();
    toastStore.success('Workflow attached to this task');
  }

  async function advance(block = false) {
    if (!selectedRun || !evidence.trim()) return;
    const res = await apiFetch(apiUrl(`/api/agent/workflows/${selectedRun.id}/advance`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ evidence: evidence.trim(), block }) });
    const data = await res.json();
    if (!res.ok || !data.ok) return toastStore.error(data.error ?? 'Unable to update workflow');
    evidence = '';
    await refresh();
    onchange?.();
  }

  async function stop() {
    if (!selectedRun) return;
    const res = await apiFetch(apiUrl(`/api/agent/workflows/${selectedRun.id}/stop`), { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) return toastStore.error(data.error ?? 'Unable to stop workflow');
    await refresh();
    onchange?.();
  }

  async function activate(draft: Draft, scope: 'project' | 'personal') {
    const res = await apiFetch(apiUrl(`/api/agent/workflows/drafts/${draft.id}/activate`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
    const data = await res.json();
    if (!res.ok || !data.ok) return toastStore.error(data.error ?? 'Unable to activate workflow draft');
    await refresh();
    toastStore.success(`Workflow activated for ${scope === 'project' ? 'this project' : 'your personal library'}`);
  }
</script>

{#if open}
  <div class="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-3 sm:items-center" role="presentation" onclick={(event) => event.currentTarget === event.target && onclose()}>
    <dialog open class="flex max-h-[min(720px,calc(100vh-1.5rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-0 shadow-2xl" aria-label="Workflows">
      <header class="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]"><Workflow size={18} /></div>
        <div class="min-w-0 flex-1"><h2 class="text-sm font-semibold text-[var(--color-text-primary)]">Task workflows</h2><p class="mt-0.5 text-xs text-[var(--color-text-muted)]">Reusable host-owned stages. They guide this task; they never create or complete a Goal.</p></div>
        <button type="button" class="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]" onclick={onclose} aria-label="Close workflows"><X size={16} /></button>
      </header>
      <div class="min-h-0 overflow-y-auto p-5">
        {#if drafts.some((draft) => draft.status === 'draft')}
          <section class="mb-4 rounded-xl border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/[0.06] p-4" aria-labelledby="workflow-drafts-title">
            <div class="flex items-start gap-2"><ShieldCheck size={16} class="mt-0.5 shrink-0 text-[var(--color-warning)]" /><div><h3 id="workflow-drafts-title" class="text-xs font-semibold text-[var(--color-text-primary)]">Goal-created workflow drafts</h3><p class="mt-1 text-[11px] text-[var(--color-text-muted)]">Inactive until you approve a scope. Activation never adds permissions or executable commands.</p></div></div>
            <div class="mt-3 space-y-2">
              {#each drafts.filter((draft) => draft.status === 'draft') as draft (draft.id)}
                <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"><div class="text-xs font-semibold text-[var(--color-text-primary)]">{draft.name}</div><p class="mt-1 text-[11px] text-[var(--color-text-muted)]">{draft.description} · {draft.stages.length} evidence-gated stages</p><div class="mt-3 flex flex-wrap gap-2"><button type="button" class="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-[11px] font-medium text-white" onclick={() => void activate(draft, 'project')}>Activate for project</button><button type="button" class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]" onclick={() => void activate(draft, 'personal')}>Activate personally</button></div></div>
              {/each}
            </div>
          </section>
        {/if}
        {#if selectedRun}
          {@const definition = definitions.find((item) => item.id === selectedRun.workflowId)}
          {@const stage = definition?.stages[selectedRun.stageIndex]}
          <div class="rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/[0.05] p-4">
            <div class="flex items-start gap-3"><div class="min-w-0 flex-1"><div class="text-xs font-semibold text-[var(--color-text-primary)]">{definition?.name ?? selectedRun.workflowId}</div><div class="mt-1 text-xs text-[var(--color-text-muted)]">{selectedRun.task}</div></div><button type="button" class="rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-text-muted)] hover:text-[var(--color-error)]" title="Stop workflow" onclick={() => void stop()}><Square size={14} /></button></div>
            <ol class="mt-4 space-y-2">
              {#each definition?.stages ?? [] as item, index (item.id)}
                <li class="flex gap-2 text-xs {index === selectedRun.stageIndex ? 'text-[var(--color-text-primary)]' : index < selectedRun.stageIndex ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-muted)]/60'}"><span class="mt-0.5 shrink-0">{#if index < selectedRun.stageIndex}<CheckCircle2 size={14} class="text-[var(--color-success)]" />{:else}<Circle size={14} />{/if}</span><span><strong>{item.label}</strong>{#if index === selectedRun.stageIndex}<span class="block pt-0.5 text-[var(--color-text-secondary)]">{item.description}</span>{/if}</span></li>
              {/each}
            </ol>
            {#if selectedRun.status === 'blocked'}<p class="mt-3 rounded-lg bg-[var(--color-warning)]/10 p-2 text-xs text-[var(--color-warning)]">Blocked: {selectedRun.blocker}</p>{/if}
            {#if stage && selectedRun.status === 'running'}
              <div class="mt-4"><label class="text-[11px] font-medium text-[var(--color-text-secondary)]" for="workflow-evidence">Evidence for {stage.label}</label><textarea id="workflow-evidence" bind:value={evidence} rows="3" placeholder="What was inspected, built, rendered, tested, or found?" class="mt-1.5 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"></textarea><div class="mt-2 flex justify-end gap-2"><button type="button" class="rounded-lg px-3 py-2 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10" onclick={() => void advance(true)}>Report blocker</button><button type="button" disabled={!evidence.trim()} class="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40" onclick={() => void advance(false)}>Record & continue</button></div></div>
            {/if}
          </div>
        {:else}
          <div class="grid gap-3 sm:grid-cols-[0.9fr_1.1fr]">
            <div class="space-y-2">{#each definitions as definition (definition.id)}<button type="button" class="w-full rounded-xl border p-3 text-left transition-colors {selectedId === definition.id ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/[0.07]' : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'}" onclick={() => selectedId = definition.id}><div class="text-xs font-semibold text-[var(--color-text-primary)]">{definition.name}</div><p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{definition.description}</p></button>{/each}</div>
            <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"><h3 class="text-xs font-semibold text-[var(--color-text-primary)]">Attach to this task</h3><p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">Kory records each stage’s evidence. This does not change tool permissions or start Goal Mode.</p><label class="mt-4 block text-[11px] font-medium text-[var(--color-text-secondary)]" for="workflow-task">Task</label><textarea id="workflow-task" bind:value={task} rows="5" placeholder="What should this workflow help accomplish?" class="mt-1.5 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"></textarea><button type="button" disabled={!task.trim() || loading} class="mt-3 inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40" onclick={() => void start()}><Play size={14} fill="currentColor" /> Start {selectedDefinition?.name ?? 'workflow'}</button></div>
          </div>
        {/if}
      </div>
    </dialog>
  </div>
{/if}
