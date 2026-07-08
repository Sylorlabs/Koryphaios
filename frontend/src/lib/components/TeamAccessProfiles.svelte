<script lang="ts">
  import { Plus, Trash2, Copy, ShieldAlert } from 'lucide-svelte';
  import { collaborationStore, type CollaborationAccessTier } from '$lib/stores/collaboration.svelte';
  import KorySelect from './KorySelect.svelte';

  interface Props { models: Array<{ id: string; provider: string; model: string; reasoningLevels: string[] }> }
  let { models }: Props = $props();
  let selectedTierId = $state('viewer');
  let newTierName = $state('');
  let joinAssignments = $state<Record<string, string>>({});
  let advanced = $state(false);
  let pendingDangerPreset = $state(false);
  const policy = $derived(collaborationStore.activeCollab?.policy);
  const selectedTier = $derived(policy?.accessTiers.find(t => t.id === selectedTierId) ?? policy?.accessTiers[0]);
  const effectiveSummary = $derived.by(() => {
    if (!selectedTier) return [];
    const p = selectedTier.permissions;
    return [
      p.submitPrompts ? (p.autoExecutePrompts && p.fullSystemAccess ? 'Prompts run automatically' : 'Prompts require host approval') : 'Prompts blocked',
      selectedTier.allowedModels.includes('*') ? 'All host models' : `${selectedTier.allowedModels.length} model${selectedTier.allowedModels.length === 1 ? '' : 's'}`,
      p.writePaths.length ? `Write: ${p.writePaths.join(', ')}` : p.readPaths.length ? 'Files are read-only' : 'No file access',
      p.commandBlocklist.includes('*') ? 'Commands blocked' : p.commandAllowlist.includes('*') ? 'All commands' : p.commandAllowlist.length ? `${p.commandAllowlist.length} allowed commands` : 'Standard command sandbox',
      p.viewSystemMessages ? 'System logs visible' : 'System logs hidden',
    ];
  });

  $effect(() => {
    if (!policy || !models.length) return;
    const catalog = models.map(model => ({ id: model.id, label: model.model, provider: model.provider, reasoningLevels: model.reasoningLevels }));
    if (JSON.stringify(policy.modelCatalog ?? []) !== JSON.stringify(catalog)) collaborationStore.updatePolicy({ modelCatalog: catalog }, true);
  });

  function saveTier(next: CollaborationAccessTier) {
    if (!policy) return;
    collaborationStore.updatePolicy({ accessTiers: policy.accessTiers.map(t => t.id === next.id ? next : t) });
  }
  function updatePermission(key: keyof CollaborationAccessTier['permissions'], value: boolean | string[]) {
    if (!selectedTier) return;
    saveTier({ ...selectedTier, permissions: { ...selectedTier.permissions, [key]: value } });
  }
  function addTier() {
    if (!policy || !newTierName.trim()) return;
    const idBase = newTierName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'custom';
    let id = idBase; let n = 2; while (policy.accessTiers.some(t => t.id === id)) id = `${idBase}-${n++}`;
    const viewer = policy.accessTiers.find(t => t.id === 'viewer') ?? policy.accessTiers[0];
    const tier: CollaborationAccessTier = { ...structuredClone(viewer), id, name: newTierName.trim(), description: 'Custom host-defined access profile.', builtin: null, color: '#a78bfa', reasoningByModel: {} };
    collaborationStore.updatePolicy({ accessTiers: [...policy.accessTiers, tier] }); selectedTierId = id; newTierName = '';
  }
  function deleteTier() {
    if (!policy || !selectedTier || selectedTier.builtin) return;
    const next = policy.accessTiers.filter(t => t.id !== selectedTier.id);
    collaborationStore.updatePolicy({ accessTiers: next, defaultTierId: policy.defaultTierId === selectedTier.id ? next[0].id : policy.defaultTierId }); selectedTierId = next[0].id;
  }
  function duplicateTier() {
    if (!policy || !selectedTier) return;
    const base = `${selectedTier.id}-copy`.slice(0, 26); let id = base; let n = 2;
    while (policy.accessTiers.some(t => t.id === id)) id = `${base}-${n++}`.slice(0, 31);
    const copy: CollaborationAccessTier = { ...structuredClone(selectedTier), id, name: `${selectedTier.name} Copy`, builtin: null };
    collaborationStore.updatePolicy({ accessTiers: [...policy.accessTiers, copy] }); selectedTierId = id;
  }

  function applyGlobalPreset(kind: 'ask' | 'allow' | 'block') {
    if (!selectedTier) return;
    if (kind === 'allow') {
      saveTier({ ...selectedTier, allowedModels: ['*'], permissions: { ...selectedTier.permissions,
        viewChat: true, viewSystemMessages: true, viewDiffs: true, viewAgentStatus: true, viewParticipants: true,
        submitPrompts: true, autoExecutePrompts: true, useTools: true, fullSystemAccess: true,
        readPaths: ['**'], writePaths: ['**'], commandAllowlist: ['*'], commandBlocklist: [],
      }}); return;
    }
    if (kind === 'block') {
      saveTier({ ...selectedTier, allowedModels: [], permissions: { ...selectedTier.permissions,
        viewChat: false, viewSystemMessages: false, viewDiffs: false, viewAgentStatus: false, viewParticipants: false,
        submitPrompts: false, autoExecutePrompts: false, useTools: false, fullSystemAccess: false,
        readPaths: [], writePaths: [], commandAllowlist: [], commandBlocklist: ['*'],
      }}); return;
    }
    saveTier({ ...selectedTier, permissions: { ...selectedTier.permissions,
      viewChat: true, viewSystemMessages: false, viewDiffs: true, viewAgentStatus: true, viewParticipants: true,
      submitPrompts: true, autoExecutePrompts: false, useTools: true, fullSystemAccess: false,
      readPaths: ['**'], writePaths: [], commandAllowlist: [], commandBlocklist: [],
    }});
  }

  function applyVisibilityPreset(kind: 'all' | 'work' | 'none') {
    if (!selectedTier) return;
    const p = selectedTier.permissions;
    saveTier({ ...selectedTier, permissions: { ...p,
      viewChat: kind !== 'none', viewDiffs: kind !== 'none', viewAgentStatus: kind !== 'none',
      viewParticipants: kind === 'all', viewSystemMessages: kind === 'all',
    }});
  }
  function applyPromptPreset(kind: 'ask' | 'allow' | 'block') {
    if (!selectedTier) return;
    saveTier({ ...selectedTier, permissions: { ...selectedTier.permissions,
      submitPrompts: kind !== 'block', autoExecutePrompts: kind === 'allow',
      fullSystemAccess: kind === 'allow' ? true : selectedTier.permissions.fullSystemAccess,
    }});
  }
  function applyFilePreset(kind: 'read' | 'project' | 'block') {
    if (!selectedTier) return;
    saveTier({ ...selectedTier, permissions: { ...selectedTier.permissions,
      readPaths: kind === 'block' ? [] : ['**'], writePaths: kind === 'project' ? ['**'] : [],
    }});
  }
  function applyCommandPreset(kind: 'readonly' | 'developer' | 'allow' | 'block') {
    if (!selectedTier) return;
    const presets = {
      readonly: { allow: ['ls','pwd','find','rg','grep','cat','head','tail','git'], block: ['rm','mv','cp','chmod','chown','sudo','curl','wget','ssh'] },
      developer: { allow: ['git','bun','npm','npx','pnpm','yarn','node','python','python3','pytest','cargo','go','make','cmake','rg','grep','ls','cat','mkdir','cp','mv'], block: ['sudo','su','ssh','scp','curl','wget','nc','nmap','rm'] },
      allow: { allow: ['*'], block: [] }, block: { allow: [], block: ['*'] },
    }[kind];
    saveTier({ ...selectedTier, permissions: { ...selectedTier.permissions, commandAllowlist: presets.allow, commandBlocklist: presets.block } });
  }
</script>

{#if policy && selectedTier}
  <div class="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6 space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div><h4 class="text-sm font-bold text-[var(--color-text-primary)]">Access profiles</h4><p class="mt-1 text-[11px] text-[var(--color-text-muted)]">Profiles are enforced at the relay before data or prompts reach a client.</p></div>
      <div class="flex rounded-xl border p-1" style="border-color:var(--color-border);background:var(--color-surface-1)"><button type="button" onclick={() => advanced=false} class="rounded-lg px-3 py-1.5 text-[10px] font-bold {advanced ? 'text-[var(--color-text-muted)]' : 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'}">Basic</button><button type="button" onclick={() => advanced=true} class="rounded-lg px-3 py-1.5 text-[10px] font-bold {advanced ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}">Advanced</button></div>
    </div>

    {#if advanced}<div class="flex gap-2"><input bind:value={newTierName} maxlength="40" placeholder="New custom profile name" class="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)]" /><button type="button" onclick={addTier} disabled={!newTierName.trim()} class="flex items-center gap-2 rounded-xl bg-[var(--color-accent)] px-3 py-2 text-xs font-bold text-[var(--color-surface-0)] disabled:opacity-40"><Plus size={14} /> Create profile</button><button type="button" onclick={duplicateTier} class="rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs font-bold">Duplicate selected</button></div>{/if}

    <label class="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Hosted session name<input value={policy.sessionName} maxlength="80" onchange={(e) => collaborationStore.updatePolicy({ sessionName: e.currentTarget.value })} placeholder="Design review, Release room…" class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm font-semibold normal-case tracking-normal text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" /></label>

    <div class="flex gap-2 overflow-x-auto pb-1">
      {#each policy.accessTiers as tier (tier.id)}
        <button type="button" onclick={() => selectedTierId = tier.id} class="shrink-0 rounded-xl border px-4 py-2 text-left {selectedTier.id === tier.id ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'border-[var(--color-border)] bg-[var(--color-surface-1)]'}"><span class="block text-xs font-bold">{tier.name}</span><span class="text-[9px] uppercase text-[var(--color-text-muted)]">{tier.builtin ?? 'custom'}</span></button>
      {/each}
    </div>

    <div class="rounded-2xl border border-[var(--color-accent)]/25 p-4" style="background:color-mix(in srgb,var(--color-accent) 6%,var(--color-surface-1))">
      <div class="flex flex-wrap items-start justify-between gap-3"><div><div class="text-xs font-bold text-[var(--color-text-primary)]">Effective access · {selectedTier.name}</div><div class="mt-1 text-[10px] text-[var(--color-text-muted)]">This is what a person assigned to this profile actually receives.</div></div><button type="button" onclick={() => collaborationStore.createInvite(selectedTier.id)} class="rounded-xl bg-[var(--color-accent)]/10 px-3 py-2 text-[10px] font-bold text-[var(--color-accent)]"><Copy size={12} class="mr-1 inline"/> Copy invite</button></div>
      <div class="mt-3 flex flex-wrap gap-2">{#each effectiveSummary as item}<span class="rounded-lg border px-2.5 py-1.5 text-[10px]" style="border-color:var(--color-border);background:var(--color-surface-1);color:var(--color-text-secondary)">{item}</span>{/each}</div>
    </div>

    <div class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
      <div class="mb-3"><div class="text-xs font-bold text-[var(--color-text-primary)]">Whole-profile presets</div><div class="mt-1 text-[10px] text-[var(--color-text-muted)]">A clear starting point. You can customize every category afterward.</div></div>
      <div class="grid gap-2 sm:grid-cols-3">
        <button type="button" onclick={() => applyGlobalPreset('ask')} class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left"><span class="block text-xs font-bold text-amber-300">Ask all</span><span class="mt-1 block text-[10px] text-[var(--color-text-muted)]">Host approves every task before tools run</span></button>
        <button type="button" onclick={() => pendingDangerPreset=true} class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-left"><span class="block text-xs font-bold text-emerald-300">Allow all</span><span class="mt-1 block text-[10px] text-[var(--color-text-muted)]">Full models, tools, commands, and project access</span></button>
        <button type="button" onclick={() => applyGlobalPreset('block')} class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left"><span class="block text-xs font-bold text-red-300">Block all</span><span class="mt-1 block text-[10px] text-[var(--color-text-muted)]">No visibility, prompts, tools, files, or commands</span></button>
      </div>
    </div>
    {#if pendingDangerPreset}<div class="rounded-2xl border border-red-500/40 bg-red-500/10 p-4"><div class="flex items-start gap-3"><ShieldAlert size={19} class="mt-0.5 shrink-0 text-red-400"/><div class="flex-1"><div class="text-xs font-bold text-red-300">Grant unrestricted control to {selectedTier.name}?</div><p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">Anyone assigned this profile can run prompts automatically with every host model, tool, command, and writable project path. Only use this for people you fully trust.</p><div class="mt-3 flex gap-2"><button type="button" onclick={() => { applyGlobalPreset('allow'); pendingDangerPreset=false; }} class="rounded-lg bg-red-500 px-3 py-2 text-[10px] font-bold text-white">I understand, grant full control</button><button type="button" onclick={() => pendingDangerPreset=false} class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-[10px] font-bold">Cancel</button></div></div></div></div>{/if}

    {#if advanced}<div class="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
      <div class="space-y-4">
        <div class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 space-y-3">
          <div class="flex gap-3"><input value={selectedTier.name} disabled={!!selectedTier.builtin} onchange={(e) => saveTier({ ...selectedTier, name: e.currentTarget.value })} class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-bold disabled:opacity-70" /><input type="color" value={selectedTier.color} onchange={(e) => saveTier({ ...selectedTier, color: e.currentTarget.value })} class="h-9 w-11 rounded-lg border border-[var(--color-border)] bg-transparent" /></div>
          <textarea value={selectedTier.description} onchange={(e) => saveTier({ ...selectedTier, description: e.currentTarget.value })} rows="2" class="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs"></textarea>
          <div class="flex gap-2"><button type="button" onclick={() => collaborationStore.createInvite(selectedTier.id)} class="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)]/10 px-3 py-2 text-xs font-bold text-[var(--color-accent)]"><Copy size={13} /> Copy {selectedTier.name} invite</button>{#if !selectedTier.builtin}<button type="button" onclick={deleteTier} class="rounded-xl bg-red-500/10 px-3 text-red-400"><Trash2 size={14} /></button>{/if}</div>
        </div>
        <div class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
          <div class="mb-3 text-xs font-bold">Model access</div>
          <button
            type="button"
            role="switch"
            aria-checked={selectedTier.allowedModels.includes('*')}
            onclick={() => saveTier({
              ...selectedTier,
              allowedModels: selectedTier.allowedModels.includes('*') ? [] : ['*'],
            })}
            class="mb-2 flex w-full items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 text-left text-[11px] transition-colors hover:bg-[var(--color-surface-3)]"
          >
            <span class="font-semibold text-[var(--color-text-primary)]">All host models</span>
            <span
              class="h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors"
              style="background:{selectedTier.allowedModels.includes('*') ? 'var(--color-accent)' : 'var(--color-surface-4)'}"
              aria-hidden="true"
            >
              <span
                class="block h-4 w-4 rounded-full transition-transform"
                style="background:var(--color-surface-0);transform:translateX({selectedTier.allowedModels.includes('*') ? '16px' : '0'})"
              ></span>
            </span>
          </button>
            <div class="max-h-72 space-y-1 overflow-y-auto">
              {#each models as item (item.id)}
                {@const modelEnabled = selectedTier.allowedModels.includes('*') || selectedTier.allowedModels.includes(item.id)}
                <div class="rounded-lg p-2 hover:bg-[var(--color-surface-3)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={modelEnabled}
                    aria-label={`${item.model} model access`}
                    onclick={() => {
                      const current = selectedTier.allowedModels.includes('*')
                        ? models.map(model => model.id)
                        : selectedTier.allowedModels;
                      saveTier({
                        ...selectedTier,
                        allowedModels: modelEnabled
                          ? current.filter(id => id !== item.id)
                          : [...new Set([...current, item.id])],
                      });
                    }}
                    class="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                  >
                    <span class="truncate">{item.model} <span class="text-[var(--color-text-muted)]">· {item.provider}</span></span>
                    <span
                      class="h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors"
                      style="background:{modelEnabled ? 'var(--color-accent)' : 'var(--color-surface-4)'}"
                      aria-hidden="true"
                    >
                      <span
                        class="block h-3 w-3 rounded-full transition-transform"
                        style="background:var(--color-surface-0);transform:translateX({modelEnabled ? '12px' : '0'})"
                      ></span>
                    </span>
                  </button>
                  {#if (selectedTier.allowedModels.includes('*') || selectedTier.allowedModels.includes(item.id)) && item.reasoningLevels.length}
                    <div class="ml-5 mt-2 flex flex-wrap gap-1">
                      {#each item.reasoningLevels as level}
                        <button type="button" onclick={() => { const current = selectedTier.reasoningByModel[item.id] ?? []; saveTier({ ...selectedTier, reasoningByModel: { ...selectedTier.reasoningByModel, [item.id]: current.includes(level) ? current.filter(v => v !== level) : [...current, level] } }); }} class="rounded-md border px-2 py-1 text-[9px] uppercase {selectedTier.reasoningByModel[item.id]?.includes(level) ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}">{level}</button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 space-y-4">
          <div class="text-xs font-bold">Category presets</div>
          <div><div class="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Visibility</div><div class="flex flex-wrap gap-2"><button onclick={() => applyVisibilityPreset('all')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px] hover:bg-[var(--color-surface-3)]">Everything</button><button onclick={() => applyVisibilityPreset('work')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px] hover:bg-[var(--color-surface-3)]">Work only</button><button onclick={() => applyVisibilityPreset('none')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px] hover:bg-[var(--color-surface-3)]">Hidden</button></div></div>
          <div><div class="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Prompts and execution</div><div class="flex flex-wrap gap-2"><button onclick={() => applyPromptPreset('ask')} class="rounded-lg border border-amber-500/30 px-3 py-1.5 text-[10px] text-amber-300">Ask host</button><button onclick={() => applyPromptPreset('allow')} class="rounded-lg border border-emerald-500/30 px-3 py-1.5 text-[10px] text-emerald-300">Auto-run</button><button onclick={() => applyPromptPreset('block')} class="rounded-lg border border-red-500/30 px-3 py-1.5 text-[10px] text-red-300">Block</button></div></div>
          <div><div class="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Files</div><div class="flex flex-wrap gap-2"><button onclick={() => applyFilePreset('read')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px]">Read only</button><button onclick={() => applyFilePreset('project')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px]">Project edit</button><button onclick={() => applyFilePreset('block')} class="rounded-lg border border-red-500/30 px-3 py-1.5 text-[10px] text-red-300">No files</button></div></div>
          <div><div class="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Commands</div><div class="flex flex-wrap gap-2"><button onclick={() => applyCommandPreset('readonly')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px]">Read only</button><button onclick={() => applyCommandPreset('developer')} class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[10px]">Developer</button><button onclick={() => applyCommandPreset('allow')} class="rounded-lg border border-emerald-500/30 px-3 py-1.5 text-[10px] text-emerald-300">Allow all</button><button onclick={() => applyCommandPreset('block')} class="rounded-lg border border-red-500/30 px-3 py-1.5 text-[10px] text-red-300">Block all</button></div></div>
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          {#each [
            ['viewChat','View chats'],['viewSystemMessages','View system/log messages'],['viewDiffs','View code changes'],['viewAgentStatus','View agent status'],['viewParticipants','View participants'],['submitPrompts','Submit prompts'],['useTools','Use agent tools'],['autoExecutePrompts','Auto-execute prompts'],['fullSystemAccess','Full system access']
          ] as item}
            <button type="button" role="switch" aria-checked={(selectedTier.permissions as any)[item[0]]} onclick={() => updatePermission(item[0] as any, !(selectedTier.permissions as any)[item[0]])} class="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-left text-[11px]"><span>{item[1]}</span><span class="h-4 w-7 rounded-full p-0.5" style="background:{(selectedTier.permissions as any)[item[0]] ? 'var(--color-accent)' : 'var(--color-surface-4)'}"><span class="block h-3 w-3 rounded-full bg-white" style="transform:translateX({(selectedTier.permissions as any)[item[0]] ? '12px' : '0'})"></span></span></button>
          {/each}
        </div>
        {#if selectedTier.permissions.autoExecutePrompts && !selectedTier.permissions.fullSystemAccess}<div class="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-300"><ShieldAlert size={16} class="shrink-0" /> Auto-execution stays disabled until Full system access is enabled. Restricted prompts require host approval.</div>{/if}
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Readable paths<textarea value={selectedTier.permissions.readPaths.join('\n')} onchange={(e) => updatePermission('readPaths', e.currentTarget.value.split('\n').map(v => v.trim()).filter(Boolean))} placeholder="src/**&#10;docs/**" rows="5" class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 font-mono text-xs normal-case"></textarea></label>
          <label class="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Writable paths<textarea value={selectedTier.permissions.writePaths.join('\n')} onchange={(e) => updatePermission('writePaths', e.currentTarget.value.split('\n').map(v => v.trim()).filter(Boolean))} placeholder="src/components/**" rows="5" class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 font-mono text-xs normal-case"></textarea></label>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Command allowlist<span class="mt-1 block font-normal normal-case">Executable names or wildcards. Empty allows the normal Koryphaios sandbox.</span><textarea value={(selectedTier.permissions.commandAllowlist ?? []).join('\n')} onchange={(e) => updatePermission('commandAllowlist', e.currentTarget.value.split('\n').map(v => v.trim()).filter(Boolean))} placeholder="git&#10;bun&#10;npm&#10;cargo" rows="5" class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 font-mono text-xs normal-case"></textarea></label>
          <label class="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Command blocklist<span class="mt-1 block font-normal normal-case">Always wins over the allowlist.</span><textarea value={(selectedTier.permissions.commandBlocklist ?? []).join('\n')} onchange={(e) => updatePermission('commandBlocklist', e.currentTarget.value.split('\n').map(v => v.trim()).filter(Boolean))} placeholder="rm&#10;sudo&#10;curl&#10;ssh" rows="5" class="mt-2 w-full rounded-xl border border-red-500/20 bg-[var(--color-surface-1)] p-3 font-mono text-xs normal-case"></textarea></label>
        </div>
      </div>
    </div>{/if}

    <div class="grid gap-4 border-t border-[var(--color-border)] pt-5 md:grid-cols-2">
      <label class="text-xs font-bold">Code join behavior<div class="mt-2"><KorySelect value={policy.joinMode} label="Code join behavior" options={[{ value:'approval', label:'Host must approve each person' },{ value:'auto', label:'Automatically admit with default profile' }]} onchange={(value) => collaborationStore.updatePolicy({ joinMode: value as 'approval'|'auto' })} /></div></label>
      <label class="text-xs font-bold">Default profile for join code<div class="mt-2"><KorySelect value={policy.defaultTierId} label="Default profile for join code" options={policy.accessTiers.map(tier => ({ value:tier.id, label:tier.name }))} onchange={(value) => collaborationStore.updatePolicy({ defaultTierId: value })} /></div></label>
    </div>

    {#if collaborationStore.pendingJoins.length}<div class="space-y-2 border-t border-[var(--color-border)] pt-5"><div class="text-xs font-bold text-amber-400">Waiting for host approval</div>{#each collaborationStore.pendingJoins as join (join.guestId)}<div class="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--color-surface-1)] p-3"><span class="min-w-32 flex-1 text-xs font-bold">{join.name}</span><div class="w-48"><KorySelect compact value={joinAssignments[join.guestId] || policy.defaultTierId} label={`Access profile for ${join.name}`} options={policy.accessTiers.map(tier => ({ value:tier.id, label:tier.name }))} onchange={(value) => joinAssignments = { ...joinAssignments, [join.guestId]: value }} /></div><button onclick={() => collaborationStore.decideJoin(join.guestId, true, joinAssignments[join.guestId] || policy.defaultTierId)} class="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-400">Admit</button><button onclick={() => collaborationStore.decideJoin(join.guestId, false)} class="rounded-lg bg-red-500/10 px-3 py-2 text-xs font-bold text-red-400">Reject</button></div>{/each}</div>{/if}
    {#if collaborationStore.participants.length}<div class="space-y-2 border-t border-[var(--color-border)] pt-5"><div class="text-xs font-bold">Connected people</div>{#each collaborationStore.participants as person (person.guestId)}<div class="flex items-center gap-3 rounded-xl bg-[var(--color-surface-1)] p-3"><span class="flex-1 text-xs font-bold">{person.name}</span><div class="w-48"><KorySelect compact value={person.tierId} label={`Access profile for ${person.name}`} options={policy.accessTiers.map(tier => ({ value:tier.id, label:tier.name }))} onchange={(value) => collaborationStore.assignTier(person.guestId, value)} /></div></div>{/each}</div>{/if}
  </div>
{/if}
