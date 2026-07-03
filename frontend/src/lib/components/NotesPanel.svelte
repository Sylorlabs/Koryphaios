<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    Search, Plus, StickyNote, Share2, Folder, FolderOpen,
    Pin, PinOff, BookOpen, Paperclip, Trash2, X, ChevronRight,
    ChevronDown, Save, FileText, Image, Download, Tag, RefreshCw, Eye, Code2
  } from 'lucide-svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { projectStore } from '$lib/stores/project.svelte';
  import NotesGraph from './NotesGraph.svelte';
  import type { NoteWithLinks, NoteAttachment } from '@koryphaios/shared';

  // ── State ──────────────────────────────────────────────────────────────────
  let activeView = $state<'editor' | 'preview' | 'graph'>('editor');
  let titleInput = $state('');
  let folderInput = $state('');
  let contentInput = $state('');
  let tagsInput = $state('');
  let tags = $state<string[]>([]);
  let pinned = $state(false);
  let includeInContext = $state(false);
  let isDirty = $state(false);
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchQuery = $state('');
  let expandedFolders = $state<Set<string>>(new Set(['/']));
  let dragOver = $state(false);
  let editorAreaEl = $state<HTMLDivElement | undefined>(undefined);
  let titleInputEl = $state<HTMLInputElement | undefined>(undefined);
  let contentAreaEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let folderSuggestions = $state<string[]>([]);
  let showFolderSuggestions = $state(false);
  let lastOpenedNoteId = $state<string | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  let filteredNotes = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const folder = notesStore.selectedFolder;
    return notesStore.notes.filter((n) => {
      const inFolder =
        folder === '/'
          ? true
          : n.folderPath === folder || n.folderPath.startsWith(folder + '/');
      const matchesQuery =
        !q ||
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q));
      return inFolder && matchesQuery;
    });
  });

  let currentNote = $derived(notesStore.currentNote);
  let attachments = $derived(currentNote?.attachments ?? []);
  let htmlPreview = $derived.by(() => {
    if (currentNote?.format !== 'html') return '';
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'">`;
    return /<head[\s>]/i.test(contentInput)
      ? contentInput.replace(/<head([^>]*)>/i, `<head$1>${csp}`)
      : `${csp}${contentInput}`;
  });

  // ── Load on mount ─────────────────────────────────────────────────────────
  onMount(() => {
    void Promise.all([notesStore.fetchNotes(), notesStore.fetchFolderTree()]);
    window.addEventListener('keydown', handleGlobalKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleGlobalKeydown);
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  });

  $effect(() => {
    const projectPath = projectStore.currentPath;
    if (projectPath) void Promise.all([notesStore.fetchNotes(), notesStore.fetchFolderTree(), notesStore.fetchGraph()]);
  });

  // ── Sync editor when current note changes ─────────────────────────────────
  $effect(() => {
    const note = notesStore.currentNote;
    if (note) {
      titleInput = note.title;
      folderInput = note.folderPath;
      contentInput = note.content;
      tags = [...(note.tags ?? [])];
      pinned = note.pinned;
      includeInContext = note.includeInContext;
      isDirty = false;
      if (note.id !== lastOpenedNoteId) {
        lastOpenedNoteId = note.id;
        activeView = note.format === 'html' ? 'preview' : 'editor';
      }
    }
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  function handleGlobalKeydown(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 's') {
      e.preventDefault();
      void saveCurrentNote();
    }
  }

  // ── Note CRUD ─────────────────────────────────────────────────────────────
  async function openNote(id: string) {
    await notesStore.fetchNote(id);
    activeView = notesStore.currentNote?.format === 'html' ? 'preview' : 'editor';
  }

  async function createNewNote() {
    const note = await notesStore.createNote({
      title: 'Untitled',
      content: '',
      folderPath: notesStore.selectedFolder !== '/' ? notesStore.selectedFolder : (notesStore.settings.defaultFolderPath ?? '/'),
      tags: [],
      pinned: false,
      includeInContext: false,
    });
    if (note) {
      await notesStore.fetchNote(note.id);
      activeView = 'editor';
      await tick();
      titleInputEl?.focus();
      titleInputEl?.select();
    }
  }

  async function saveCurrentNote() {
    const note = notesStore.currentNote;
    if (!note) return;
    await notesStore.updateNote(note.id, {
      title: titleInput.trim() || 'Untitled',
      content: contentInput,
      folderPath: folderInput || '/',
      tags,
      pinned,
      includeInContext,
    });
    isDirty = false;
    // Refresh graph if in graph view
    if (activeView === 'graph') await notesStore.fetchGraph();
  }

  async function deleteCurrentNote() {
    const note = notesStore.currentNote;
    if (!note) return;
    if (!confirm(`Delete "${note.title}"? This cannot be undone.`)) return;
    await notesStore.deleteNote(note.id);
  }

  // ── Autosave ──────────────────────────────────────────────────────────────
  function scheduleAutosave() {
    isDirty = true;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      void saveCurrentNote();
    }, 1500);
  }

  // ── Tags ──────────────────────────────────────────────────────────────────
  function handleTagsKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagsInput.replace(/,$/, '').trim());
    } else if (e.key === 'Backspace' && !tagsInput && tags.length > 0) {
      tags = tags.slice(0, -1);
      scheduleAutosave();
    }
  }

  function addTag(t: string) {
    const clean = t.trim().toLowerCase().replace(/\s+/g, '-');
    if (clean && !tags.includes(clean)) {
      tags = [...tags, clean];
      scheduleAutosave();
    }
    tagsInput = '';
  }

  function removeTag(t: string) {
    tags = tags.filter((x) => x !== t);
    scheduleAutosave();
  }

  // ── Folder autocomplete ───────────────────────────────────────────────────
  function collectAllFolderPaths(nodes: typeof notesStore.folderTree, acc: string[] = []): string[] {
    for (const n of nodes) {
      acc.push(n.path);
      collectAllFolderPaths(n.children, acc);
    }
    return acc;
  }

  function handleFolderInput() {
    isDirty = true;
    const q = folderInput.toLowerCase();
    const allPaths = collectAllFolderPaths(notesStore.folderTree);
    folderSuggestions = q
      ? allPaths.filter((p) => p.toLowerCase().includes(q) && p !== folderInput)
      : [];
    showFolderSuggestions = folderSuggestions.length > 0;
  }

  // ── File attachment drag-drop ─────────────────────────────────────────────
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const note = notesStore.currentNote;
    if (!note) {
      toastStore.error('Open a note first to attach files');
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const file of files) {
      const attachment = await notesStore.uploadAttachment(note.id, file);
      if (attachment) {
        // Insert embed at cursor in textarea
        const embedText =
          attachment.mimeType.startsWith('image/')
            ? `![[${attachment.filename}]]`
            : `[[${attachment.filename}]]`;
        insertAtCursor(contentAreaEl, embedText);
        scheduleAutosave();
      }
    }
  }

  function insertAtCursor(el: HTMLTextAreaElement | undefined, text: string) {
    if (!el) return;
    const start = el.selectionStart ?? contentInput.length;
    const end = el.selectionEnd ?? contentInput.length;
    contentInput =
      contentInput.slice(0, start) + text + contentInput.slice(end);
    tick().then(() => {
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  }

  // ── Folder tree helpers ───────────────────────────────────────────────────
  function toggleFolder(path: string) {
    if (expandedFolders.has(path)) {
      expandedFolders.delete(path);
    } else {
      expandedFolders.add(path);
    }
    expandedFolders = new Set(expandedFolders);
  }

  // ── Graph view ────────────────────────────────────────────────────────────
  async function switchToGraph() {
    activeView = 'graph';
    await notesStore.fetchGraph();
  }

  function handleGraphNodeClick(noteId: string) {
    activeView = 'editor';
    void openNote(noteId);
  }

  // ── Attachment helpers ─────────────────────────────────────────────────────
  function attachmentSrc(a: NoteAttachment): string {
    return apiUrl(`/api/notes/attachments/${a.id}`);
  }

  async function handleFileInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const note = notesStore.currentNote;
    if (!note || !input.files?.length) return;
    for (const file of Array.from(input.files)) {
      const attachment = await notesStore.uploadAttachment(note.id, file);
      if (attachment) {
        const embedText = attachment.mimeType.startsWith('image/')
          ? `![[${attachment.filename}]]`
          : `[[${attachment.filename}]]`;
        insertAtCursor(contentAreaEl, embedText);
        scheduleAutosave();
      }
    }
    input.value = '';
  }
</script>

<div class="flex h-full min-h-0 min-w-0" style="background: var(--color-surface-1);">
  <!-- ── Left sidebar ──────────────────────────────────────────────────────── -->
  <aside
    class="shrink-0 border-r flex flex-col min-h-0"
    style="width: 280px; border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b shrink-0" style="border-color: var(--color-border);">
      <div class="flex items-center gap-2">
        <StickyNote size={15} style="color: var(--color-accent);" />
        <span class="text-sm font-semibold" style="color: var(--color-text-primary);">Notes</span>
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => void notesStore.syncProjectDocuments()}
          title="Re-index project Markdown and HTML"
          aria-label="Re-index project documents"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={switchToGraph}
          title="Graph view"
          aria-label="Graph view"
        >
          <Share2 size={13} />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-secondary);"
          onclick={createNewNote}
          title="New note"
          aria-label="New note"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="px-3 py-2 shrink-0">
      <div class="relative flex items-center">
        <Search size={12} class="absolute left-2.5 pointer-events-none" style="color: var(--color-text-muted);" />
        <input
          type="text"
          placeholder="Search notes..."
          class="w-full h-7 rounded-lg border pl-7 pr-3 text-xs"
          style="
            background: var(--color-surface-2);
            border-color: var(--color-border);
            color: var(--color-text-primary);
          "
          bind:value={searchQuery}
          oninput={() => {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
              void notesStore.setSearchQuery(searchQuery);
            }, 300);
          }}
        />
      </div>
    </div>

    <!-- Folder tree -->
    {#if notesStore.folderTree.length > 0}
      <div class="shrink-0 px-2 pb-1">
        <div class="text-[10px] font-semibold uppercase tracking-widest px-2 mb-1" style="color: var(--color-text-muted);">Folders</div>
        {#snippet folderNode(node: typeof notesStore.folderTree[0], depth: number)}
          <div style="padding-left: {depth * 12}px;">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: {notesStore.selectedFolder === node.path ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
              onclick={() => {
                void notesStore.selectFolder(node.path);
                if (node.children.length > 0) toggleFolder(node.path);
              }}
            >
              {#if node.children.length > 0}
                {#if expandedFolders.has(node.path)}
                  <ChevronDown size={10} />
                  <FolderOpen size={11} />
                {:else}
                  <ChevronRight size={10} />
                  <Folder size={11} />
                {/if}
              {:else}
                <span class="w-[10px]"></span>
                <Folder size={11} />
              {/if}
              <span class="truncate">{node.name}</span>
              {#if node.noteCount > 0}
                <span class="ml-auto text-[10px] opacity-50">{node.noteCount}</span>
              {/if}
            </button>
            {#if expandedFolders.has(node.path) && node.children.length > 0}
              {#each node.children as child (child.path)}
                {@render folderNode(child, depth + 1)}
              {/each}
            {/if}
          </div>
        {/snippet}

        <!-- Root folder -->
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: {notesStore.selectedFolder === '/' ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
          onclick={() => void notesStore.selectFolder('/')}
        >
          <Folder size={11} />
          <span>All Notes</span>
          <span class="ml-auto text-[10px] opacity-50">{notesStore.notes.length}</span>
        </button>
        {#each notesStore.folderTree as node (node.path)}
          {@render folderNode(node, 1)}
        {/each}
      </div>
    {/if}

    <!-- Tag filters -->
    {#if notesStore.notes.some((n) => n.tags.length > 0)}
      {@const allTags = [...new Set(notesStore.notes.flatMap((n) => n.tags))].slice(0, 15)}
      <div class="shrink-0 px-3 pb-2">
        <div class="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style="color: var(--color-text-muted);">Tags</div>
        <div class="flex flex-wrap gap-1">
          {#each allTags as tag (tag)}
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--color-surface-4)]"
              style="background: var(--color-surface-3); color: var(--color-text-secondary);"
              onclick={() => { searchQuery = tag; void notesStore.setSearchQuery(tag); }}
            >
              <Tag size={8} />
              {tag}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Note list -->
    <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
      {#if notesStore.isLoading}
        <div class="flex items-center justify-center py-8">
          <div class="text-xs" style="color: var(--color-text-muted);">Loading...</div>
        </div>
      {:else if filteredNotes.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center px-4">
          <StickyNote size={24} class="opacity-20 mb-2" style="color: var(--color-text-muted);" />
          <div class="text-xs" style="color: var(--color-text-muted);">
            {searchQuery ? 'No matching notes' : 'No notes yet'}
          </div>
          <button
            type="button"
            class="mt-3 text-xs px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-accent);"
            onclick={createNewNote}
          >
            + New note
          </button>
        </div>
      {:else}
        {#each filteredNotes as note (note.id)}
          <button
            type="button"
            class="w-full text-left rounded-xl px-3 py-2.5 mb-1 transition-colors border border-transparent"
            style="
              background: {notesStore.currentNote?.id === note.id ? 'var(--color-surface-3)' : 'transparent'};
              border-color: {notesStore.currentNote?.id === note.id ? 'var(--color-border)' : 'transparent'};
            "
            onclick={() => void openNote(note.id)}
          >
            <div class="flex items-start gap-2 min-w-0">
              {#if note.pinned}
                <Pin size={10} class="mt-0.5 shrink-0" style="color: var(--color-accent);" />
              {:else}
                <FileText size={10} class="mt-0.5 shrink-0 opacity-40" style="color: var(--color-text-muted);" />
              {/if}
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs font-medium" style="color: var(--color-text-primary);">{note.title}</div>
                {#if note.content}
                  <div class="truncate text-[10px] mt-0.5" style="color: var(--color-text-muted);">
                    {note.content.slice(0, 60).replace(/\n/g, ' ')}
                  </div>
                {/if}
                {#if note.tags.length > 0}
                  <div class="flex flex-wrap gap-0.5 mt-1">
                    {#each note.tags.slice(0, 3) as tag (tag)}
                      <span
                        class="rounded px-1 py-0 text-[9px]"
                        style="background: var(--color-surface-3); color: var(--color-text-muted);"
                      >{tag}</span>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  <!-- ── Main area ───────────────────────────────────────────────────────────── -->
  <div class="flex-1 min-h-0 min-w-0 flex flex-col">
    <!-- Tab bar -->
    <div
      class="flex items-center gap-1 px-4 py-2 border-b shrink-0"
      style="border-color: var(--color-border); background: var(--color-surface-0);"
    >
      <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style="
          background: {activeView === 'editor' ? 'var(--color-surface-3)' : 'transparent'};
          color: {activeView === 'editor' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};
        "
        onclick={() => { activeView = 'editor'; }}
      >
        <FileText size={12} />
        Editor
      </button>
      {#if currentNote?.format === 'html'}
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style="background: {activeView === 'preview' ? 'var(--color-surface-3)' : 'transparent'}; color: {activeView === 'preview' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};"
          onclick={() => { activeView = 'preview'; }}
          title="Sandboxed HTML preview"
        >
          <Eye size={12} />
          Preview
        </button>
      {/if}
      <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style="
          background: {activeView === 'graph' ? 'var(--color-surface-3)' : 'transparent'};
          color: {activeView === 'graph' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};
        "
        onclick={switchToGraph}
      >
        <Share2 size={12} />
        Graph
      </button>

      {#if (activeView === 'editor' || activeView === 'preview') && currentNote}
        <!-- Note actions -->
        <div class="ml-auto flex items-center gap-1">
          <!-- Pin toggle -->
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: {pinned ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
            onclick={() => { pinned = !pinned; scheduleAutosave(); }}
            title={pinned ? 'Unpin note' : 'Pin note'}
          >
            {#if pinned}<Pin size={12} />{:else}<PinOff size={12} />{/if}
          </button>

          <!-- Include in context toggle -->
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: {includeInContext ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
            onclick={() => { includeInContext = !includeInContext; scheduleAutosave(); }}
            title={includeInContext ? 'Remove from agent context' : 'Include in agent context'}
          >
            <BookOpen size={12} />
            <span class="text-[10px]">{includeInContext ? 'In context' : 'Add to context'}</span>
          </button>

          <!-- Save -->
          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
            style="
              background: {isDirty ? 'var(--color-accent)' : 'var(--color-surface-3)'};
              color: {isDirty ? 'var(--color-surface-0)' : 'var(--color-text-muted)'};
            "
            onclick={() => void saveCurrentNote()}
            title="Save (Ctrl+S)"
          >
            <Save size={12} />
            {isDirty ? 'Save' : 'Saved'}
          </button>

          <!-- Delete -->
          <button
            type="button"
            class="p-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-muted);"
            onclick={() => void deleteCurrentNote()}
            title="Delete note"
          >
            <Trash2 size={12} />
          </button>
        </div>
      {/if}
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-hidden">
      {#if activeView === 'graph'}
        <NotesGraph onNodeClick={handleGraphNodeClick} />
      {:else if activeView === 'preview' && currentNote?.format === 'html'}
        <div class="h-full flex flex-col" style="background: var(--color-surface-1);">
          <div class="flex items-center gap-2 px-4 py-2 border-b text-[11px]" style="border-color: var(--color-border); color: var(--color-text-muted);">
            <Code2 size={12} />
            Sandboxed preview — CSS and embedded media work; scripts, forms, navigation, and network requests are blocked.
          </div>
          <iframe
            class="flex-1 w-full border-0 bg-white"
            title="HTML note preview"
            sandbox=""
            referrerpolicy="no-referrer"
            srcdoc={htmlPreview}
          ></iframe>
        </div>
      {:else if currentNote}
        <!-- Editor view -->
        <div
          bind:this={editorAreaEl}
          class="h-full overflow-y-auto flex flex-col"
          style="background: var(--color-surface-1);"
          ondragover={handleDragOver}
          ondragleave={handleDragLeave}
          ondrop={handleDrop}
          role="region"
          aria-label="Note editor"
        >
          {#if dragOver}
            <div
              class="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed pointer-events-none"
              style="border-color: var(--color-accent); background: rgba(213,178,97,0.08);"
            >
              <div class="text-sm font-medium" style="color: var(--color-accent);">Drop files to attach</div>
            </div>
          {/if}

          <div class="max-w-3xl mx-auto w-full px-8 pt-8 pb-4 flex flex-col gap-4">
            <!-- Title -->
            <input
              bind:this={titleInputEl}
              type="text"
              placeholder="Note title..."
              class="w-full bg-transparent border-none outline-none text-2xl font-bold"
              style="color: var(--color-text-primary); font-family: var(--font-family-sans, inherit);"
              bind:value={titleInput}
              disabled={Boolean(currentNote.sourcePath)}
              oninput={scheduleAutosave}
            />

            {#if currentNote.sourcePath}
              <div class="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs" style="border-color: var(--color-border); background: var(--color-surface-2); color: var(--color-text-secondary);">
                <FileText size={12} style="color: var(--color-accent);" />
                <span class="font-mono truncate">{currentNote.sourcePath}</span>
                <span class="ml-auto shrink-0 text-[10px] uppercase tracking-wider" style="color: var(--color-text-muted);">live project file</span>
              </div>
            {/if}

            <!-- Metadata row -->
            <div class="flex flex-wrap items-center gap-3">
              <!-- Folder path -->
              <div class="relative flex items-center gap-1.5">
                <Folder size={12} style="color: var(--color-text-muted);" />
                <input
                  type="text"
                  placeholder="/"
                  class="bg-transparent border-none outline-none text-xs"
                  style="color: var(--color-text-secondary); width: 140px;"
                  bind:value={folderInput}
                  disabled={Boolean(currentNote.sourcePath)}
                  oninput={handleFolderInput}
                  onblur={() => { showFolderSuggestions = false; scheduleAutosave(); }}
                />
                {#if showFolderSuggestions}
                  <div
                    class="absolute top-full left-0 z-20 mt-1 rounded-lg border shadow-xl overflow-hidden"
                    style="background: var(--color-surface-2); border-color: var(--color-border); min-width: 160px;"
                  >
                    {#each folderSuggestions.slice(0, 6) as sug (sug)}
                      <button
                        type="button"
                        class="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-3)] transition-colors"
                        style="color: var(--color-text-secondary);"
                        onmousedown={() => {
                          folderInput = sug;
                          showFolderSuggestions = false;
                          isDirty = true;
                        }}
                      >{sug}</button>
                    {/each}
                  </div>
                {/if}
              </div>

              <!-- Tags -->
              <div class="flex items-center flex-wrap gap-1">
                <Tag size={11} style="color: var(--color-text-muted);" />
                {#each tags as tag (tag)}
                  <span
                    class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
                    style="background: var(--color-surface-3); color: var(--color-text-secondary);"
                  >
                    {tag}
                    <button
                      type="button"
                      onclick={() => removeTag(tag)}
                      class="hover:text-red-400 ml-0.5"
                      aria-label="Remove tag"
                    >
                      <X size={8} />
                    </button>
                  </span>
                {/each}
                <input
                  type="text"
                  placeholder="Add tag…"
                  class="bg-transparent border-none outline-none text-xs"
                  style="color: var(--color-text-muted); width: 80px;"
                  bind:value={tagsInput}
                  onkeydown={handleTagsKeydown}
                  onblur={() => { if (tagsInput.trim()) addTag(tagsInput); }}
                />
              </div>
            </div>

            <!-- Divider -->
            <div class="border-t" style="border-color: var(--color-border);"></div>

            <!-- Content textarea -->
            <textarea
              bind:this={contentAreaEl}
              class="w-full min-h-[400px] bg-transparent border-none outline-none resize-none text-sm leading-relaxed font-mono"
              style="color: var(--color-text-primary); font-family: var(--font-mono, monospace);"
              placeholder="Start writing... Use [[Note Title]] to link notes."
              bind:value={contentInput}
              oninput={scheduleAutosave}
              onblur={() => { if (isDirty) void saveCurrentNote(); }}
            ></textarea>

            <!-- Attachments -->
            {#if attachments.length > 0 || true}
              <div class="border-t pt-4" style="border-color: var(--color-border);">
                <div class="flex items-center justify-between mb-3">
                  <div class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest" style="color: var(--color-text-muted);">
                    <Paperclip size={11} />
                    Attachments
                  </div>
                  <label
                    class="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] cursor-pointer transition-colors hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-muted);"
                    title="Upload file"
                  >
                    <Plus size={10} />
                    Add
                    <input
                      type="file"
                      class="hidden"
                      multiple
                      onchange={handleFileInputChange}
                    />
                  </label>
                </div>

                {#if attachments.length === 0}
                  <div
                    class="border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-6 text-xs"
                    style="border-color: var(--color-border); color: var(--color-text-muted);"
                  >
                    <Paperclip size={18} class="opacity-30 mb-1" />
                    Drag & drop files here
                  </div>
                {:else}
                  <div class="grid grid-cols-3 gap-2">
                    {#each attachments as att (att.id)}
                      <div
                        class="group relative rounded-lg border overflow-hidden"
                        style="border-color: var(--color-border); background: var(--color-surface-2);"
                      >
                        {#if att.mimeType.startsWith('image/')}
                          <img
                            src={attachmentSrc(att)}
                            alt={att.filename}
                            class="w-full h-20 object-cover"
                          />
                        {:else}
                          <div class="flex flex-col items-center justify-center py-4">
                            <FileText size={20} style="color: var(--color-text-muted);" />
                          </div>
                        {/if}
                        <div class="p-1.5">
                          <div class="text-[10px] truncate" style="color: var(--color-text-secondary);">{att.filename}</div>
                        </div>
                        <!-- Actions overlay -->
                        <div class="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <a
                            href={attachmentSrc(att)}
                            download={att.filename}
                            class="p-1 rounded bg-black/60 hover:bg-black/80 transition-colors"
                            title="Download"
                          >
                            <Download size={10} style="color: white;" />
                          </a>
                          <button
                            type="button"
                            class="p-1 rounded bg-black/60 hover:bg-red-500/80 transition-colors"
                            onclick={() => {
                              const note = notesStore.currentNote;
                              if (note) void notesStore.deleteAttachment(note.id, att.id);
                            }}
                            title="Delete"
                          >
                            <X size={10} style="color: white;" />
                          </button>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Backlinks -->
            {#if currentNote && currentNote.backlinks && currentNote.backlinks.length > 0}
              <div class="border-t pt-4" style="border-color: var(--color-border);">
                <div class="text-xs font-semibold uppercase tracking-widest mb-2" style="color: var(--color-text-muted);">
                  Backlinks ({currentNote.backlinks.length})
                </div>
                <div class="space-y-1">
                  {#each currentNote.backlinks as backlinkId (backlinkId)}
                    {@const backNote = notesStore.notes.find((n) => n.id === backlinkId)}
                    {#if backNote}
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
                        style="color: var(--color-text-secondary);"
                        onclick={() => void openNote(backlinkId)}
                      >
                        <FileText size={11} style="color: var(--color-text-muted);" />
                        {backNote.title}
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Outlinks -->
            {#if currentNote && currentNote.outlinks && currentNote.outlinks.length > 0}
              <div class="border-t pt-4 pb-8" style="border-color: var(--color-border);">
                <div class="text-xs font-semibold uppercase tracking-widest mb-2" style="color: var(--color-text-muted);">
                  Outlinks ({currentNote.outlinks.length})
                </div>
                <div class="space-y-1">
                  {#each currentNote.outlinks as outlinkId (outlinkId)}
                    {@const outNote = notesStore.notes.find((n) => n.id === outlinkId)}
                    {#if outNote}
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--color-surface-3)]"
                        style="color: var(--color-text-secondary);"
                        onclick={() => void openNote(outlinkId)}
                      >
                        <FileText size={11} style="color: var(--color-text-muted);" />
                        {outNote.title}
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <!-- Empty state: no note selected -->
        <div class="flex-1 flex flex-col items-center justify-center h-full" style="background: var(--color-surface-1);">
          <div class="text-center max-w-xs">
            <StickyNote size={48} class="mx-auto mb-4 opacity-20" style="color: var(--color-text-muted);" />
            <div class="text-sm font-medium mb-1" style="color: var(--color-text-secondary);">No note selected</div>
            <div class="text-xs mb-4" style="color: var(--color-text-muted);">
              Pick a note from the list or create a new one.
            </div>
            <button
              type="button"
              class="px-4 py-2 rounded-xl text-xs font-semibold transition-colors"
              style="background: rgba(213,178,97,0.12); color: var(--color-accent); border: 1px solid rgba(213,178,97,0.25);"
              onclick={createNewNote}
            >
              + New Note
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
