<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { 
    Search, 
    Zap, 
    Plus, 
    Settings, 
    Sidebar, 
    Layout, 
    SunMoon, 
    Trash2,
    FileCode,
    FolderOpen,
    Command
  } from 'lucide-svelte';
  import { getModKeyName } from '$lib/utils/platform';

  let { 
    open = $bindable(false), 
    onAction 
  }: { 
    open: boolean; 
    onAction: (action: string) => void 
  } = $props();

  let query = $state('');
  let selectedIndex = $state(0);
  let inputRef = $state<HTMLInputElement>();

  type Action = {
    id: string;
    label: string;
    description: string;
    icon: any;
    shortcut?: string;
    category: string;
  };

  const actions: Action[] = [
    { id: 'new_project', label: 'New Project', description: 'Create a new project workspace', icon: Plus, shortcut: 'P', category: 'Project' },
    { id: 'new_session', label: 'New Session', description: 'Start a fresh conversation', icon: Plus, shortcut: 'N', category: 'Session' },
    { id: 'open_project_file', label: 'Import Project', description: 'Load project from a local file', icon: FileCode, category: 'Project' },
    { id: 'open_project_folder', label: 'Open Project From Folder', description: 'Load project from a folder on your computer', icon: FolderOpen, category: 'Project' },
    { id: 'save_snapshot', label: 'Export Snapshot', description: 'Save current session as .kory.json', icon: FileCode, category: 'Project' },
    { id: 'session_compact', label: 'Compact Session', description: 'Request an implementation-focused session summary', icon: FileCode, category: 'Session' },
    { id: 'toggle_sidebar', label: 'Toggle Sidebar', description: 'Show or hide the session sidebar', icon: Sidebar, shortcut: 'B', category: 'View' },
    { id: 'toggle_zen_mode', label: 'Toggle Zen Mode', description: 'Focus on the conversation', icon: Layout, shortcut: 'Shift+Z', category: 'View' },
    { id: 'toggle_theme', label: 'Switch Theme', description: 'Open quick theme preset picker', icon: SunMoon, category: 'View' },
    { id: 'toggle_yolo', label: 'Toggle YOLO Mode', description: 'Bypass all confirmation dialogs', icon: Zap, shortcut: 'Y', category: 'System' },
    { id: 'open_settings', label: 'Settings', description: 'Configure providers and preferences', icon: Settings, shortcut: ',', category: 'System' },
    { id: 'clear_feed', label: 'Clear Feed', description: 'Remove all messages from view', icon: Trash2, category: 'System' },
  ];

  let filteredActions = $derived(
    actions.filter(a => 
      a.label.toLowerCase().includes(query.toLowerCase()) || 
      a.category.toLowerCase().includes(query.toLowerCase())
    )
  );

  $effect(() => {
    if (open) {
      query = '';
      selectedIndex = 0;
      setTimeout(() => inputRef?.focus(), 10);
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      open = false;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % filteredActions.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + filteredActions.length) % filteredActions.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const action = filteredActions[selectedIndex];
      if (action) {
        onAction(action.id);
        open = false;
      }
    }
  }

  function handleAction(id: string) {
    onAction(id);
    open = false;
  }
</script>

{#if open}
  <div 
    class="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 backdrop-blur-sm"
    style="background: rgba(0,0,0,0.5);"
    transition:fade={{ duration: 150 }}
    onmousedown={() => open = false}
    role="presentation"
  >
    <div 
      class="w-full max-w-xl rounded-xl border shadow-2xl overflow-hidden flex flex-col"
      style="background: var(--color-surface-1); border-color: var(--color-border);"
      transition:fly={{ y: -20, duration: 200 }}
      onmousedown={e => e.stopPropagation()}
      role="presentation"
    >
      <div class="flex items-center gap-3 px-4 py-3 border-b" style="border-color: var(--color-border);">
        <Search size={18} style="color: var(--color-text-muted);" />
        <input
          bind:this={inputRef}
          bind:value={query}
          type="text"
          placeholder="Type a command or search..."
          class="flex-1 bg-transparent border-none outline-none text-sm"
          style="color: var(--color-text-primary);"
          onkeydown={handleKeydown}
        />
        <div class="flex items-center gap-1">
          <span class="text-[10px] px-1.5 py-0.5 rounded" style="background: var(--color-surface-3); color: var(--color-text-muted);">ESC to close</span>
        </div>
      </div>

      <div class="max-h-[60vh] overflow-y-auto p-2">
        {#if filteredActions.length === 0}
          <div class="py-12 flex flex-col items-center justify-center text-center opacity-50">
            <Command size={32} class="mb-3" />
            <p class="text-sm">No commands found for "{query}"</p>
          </div>
        {:else}
          {@const categories = [...new Set(filteredActions.map(a => a.category))]}
          {#each categories as category}
            <div class="px-2 py-1.5 text-[10px] uppercase font-bold tracking-wider" style="color: var(--color-text-muted);">{category}</div>
            {#each filteredActions.filter(a => a.category === category) as action, i}
              {@const isSelected = filteredActions.indexOf(action) === selectedIndex}
              <button
                class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors group"
                class:selected={isSelected}
                style="background: {isSelected ? 'var(--color-surface-3)' : 'transparent'};"
                onclick={() => handleAction(action.id)}
                onmouseenter={() => selectedIndex = filteredActions.indexOf(action)}
              >
                <div 
                  class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors"
                  style="background: {isSelected ? 'var(--color-surface-4)' : 'var(--color-surface-2)'};"
                >
                  <action.icon size={16} style="color: {isSelected ? 'var(--color-accent)' : 'var(--color-text-secondary)'};" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium" style="color: var(--color-text-primary);">{action.label}</div>
                  <div class="text-xs truncate" style="color: var(--color-text-muted);">{action.description}</div>
                </div>
                {#if action.shortcut}
                  <div class="flex items-center gap-0.5 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
                    <span class="text-[10px] px-1 py-0.5 rounded border" style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-muted);">{getModKeyName()}</span>
                    {#each action.shortcut.split('+') as part}
                      <span class="text-[10px] px-1 py-0.5 rounded border" style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-muted);">{part}</span>
                    {/each}
                  </div>
                {/if}
              </button>
            {/each}
          {/each}
        {/if}
      </div>

      <div class="px-4 py-2 border-t flex items-center justify-between" style="border-color: var(--color-border); background: var(--color-surface-0);">
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-1.5">
            <kbd class="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 border border-border" style="background: var(--color-surface-3); border-color: var(--color-border); color: var(--color-text-muted);">↑↓</kbd>
            <span class="text-[10px]" style="color: var(--color-text-muted);">Navigate</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 border border-border" style="background: var(--color-surface-3); border-color: var(--color-border); color: var(--color-text-muted);">↵</kbd>
            <span class="text-[10px]" style="color: var(--color-text-muted);">Select</span>
          </div>
        </div>
        <div class="text-[10px]" style="color: var(--color-text-muted);">
          Koryphaios <span class="opacity-50">v0.1.0</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .selected {
    box-shadow: inset 0 0 0 1px var(--color-border-bright);
  }
</style>
