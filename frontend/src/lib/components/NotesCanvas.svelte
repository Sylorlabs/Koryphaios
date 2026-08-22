<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Plus from 'lucide-svelte/icons/plus';
  import Save from 'lucide-svelte/icons/save';
  import FileText from 'lucide-svelte/icons/file-text';
  import X from 'lucide-svelte/icons/x';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import type { Note } from '@koryphaios/shared';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { projectDisplayName, projectStore } from '$lib/stores/project.svelte';
  import { selectProjectNavigation } from '$lib/utils/project-navigation';
  import KorySelect from '$lib/components/KorySelect.svelte';
  import {
    createDraftRegistry,
    draftLifecycleAction,
    type DraftLifecycleTrigger,
  } from '$lib/utils/draft-save';

  interface Props {
    onOpenNote?: (noteId: string) => void;
  }
  let { onOpenNote }: Props = $props();

  interface CanvasCard {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    noteId?: string;
    color: string;
  }
  interface CanvasEdge {
    id: string;
    from: string;
    to: string;
  }
  interface CanvasSnapshot {
    draftId: string;
    projectPath: string;
    name: string;
    noteId: string | null;
    revision: number | null;
    cards: CanvasCard[];
    edges: CanvasEdge[];
  }

  const CARD_COLORS = ['#8b7ec8', '#6b9bd1', '#5ec4a0', '#d4845c', '#c47fd0', '#e8a85a'];

  // ── Canvas document state ───────────────────────────────────────────────────
  let cards = $state<CanvasCard[]>([]);
  let edges = $state<CanvasEdge[]>([]);
  let canvasName = $state('Untitled canvas');
  let canvasNoteId = $state<string | null>(null);
  let canvasRevision = $state<number | null>(null);
  let dirty = $state(false);
  let editVersion = 0;
  let savePromise: Promise<boolean> | null = null;
  let loadedProjectPath = $state<string | null | undefined>(undefined);
  let canvasDraftId = $state(`draft:${uid()}`);
  const draftRegistry = createDraftRegistry<CanvasSnapshot>('notes-canvas');
  let strandedCanvases = $state<CanvasSnapshot[]>(draftRegistry.list());
  let strandedCanvas = $derived(strandedCanvases[0] ?? null);
  let keyboardConnectFrom = $state<string | null>(null);

  // ── Viewport (pan / zoom) ───────────────────────────────────────────────────
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let boardEl = $state<HTMLDivElement | undefined>(undefined);

  function uid(): string {
    return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.floor(performance.now())}`;
  }

  function markDirty() {
    dirty = true;
    editVersion++;
  }

  function canvasDraftKey(snapshot: Pick<CanvasSnapshot, 'projectPath' | 'draftId'>): string {
    return `${snapshot.projectPath}\0${snapshot.draftId}`;
  }

  function refreshStrandedCanvases() {
    strandedCanvases = draftRegistry.list();
  }

  function holdCurrentCanvas(projectPath = loadedProjectPath): void {
    if (!dirty || !projectPath) return;
    const snapshot: CanvasSnapshot = {
      draftId: canvasDraftId,
      projectPath,
      name: canvasName,
      noteId: canvasNoteId,
      revision: canvasRevision,
      cards: cards.map((card) => ({ ...card })),
      edges: edges.map((edge) => ({ ...edge })),
    };
    draftRegistry.set(canvasDraftKey(snapshot), snapshot);
    refreshStrandedCanvases();
  }

  function toBoard(clientX: number, clientY: number): { x: number; y: number } {
    const rect = boardEl!.getBoundingClientRect();
    return { x: (clientX - rect.left - tx) / scale, y: (clientY - rect.top - ty) / scale };
  }

  // ── Card / edge creation ────────────────────────────────────────────────────
  function addCard(noteId?: string, text = 'New card') {
    const center = boardEl
      ? toBoard(
          boardEl.getBoundingClientRect().left + boardEl.clientWidth / 2,
          boardEl.getBoundingClientRect().top + boardEl.clientHeight / 2,
        )
      : { x: 100, y: 100 };
    const note = noteId ? notesStore.notes.find((n) => n.id === noteId) : undefined;
    // Tile new cards in a loose grid so they don't stack on top of each other.
    const i = cards.length;
    cards.push({
      id: uid(),
      x: center.x - 220 + (i % 4) * 210,
      y: center.y - 160 + Math.floor(i / 4) * 150,
      w: 180,
      h: 120,
      text: note ? note.title : text,
      noteId: note?.id,
      color: CARD_COLORS[cards.length % CARD_COLORS.length],
    });
    markDirty();
  }

  function removeCard(id: string) {
    cards = cards.filter((c) => c.id !== id);
    edges = edges.filter((e) => e.from !== id && e.to !== id);
    markDirty();
  }

  function removeEdge(id: string) {
    edges = edges.filter((e) => e.id !== id);
    markDirty();
  }

  // ── Pointer interaction ─────────────────────────────────────────────────────
  type Mode =
    | { kind: 'none' }
    | { kind: 'pan'; startX: number; startY: number; tx0: number; ty0: number }
    | { kind: 'card'; id: string; offX: number; offY: number }
    | { kind: 'connect'; from: string; cx: number; cy: number };
  let mode: Mode = $state({ kind: 'none' });

  function onBoardPointerDown(e: PointerEvent) {
    // Background pan only (cards/handles stop propagation).
    if (e.button !== 0) return;
    boardEl?.setPointerCapture(e.pointerId);
    mode = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: tx, ty0: ty };
  }

  function onCardPointerDown(e: PointerEvent, card: CanvasCard) {
    e.stopPropagation();
    boardEl?.setPointerCapture(e.pointerId);
    const p = toBoard(e.clientX, e.clientY);
    mode = { kind: 'card', id: card.id, offX: p.x - card.x, offY: p.y - card.y };
  }

  function onHandlePointerDown(e: PointerEvent, card: CanvasCard) {
    e.stopPropagation();
    boardEl?.setPointerCapture(e.pointerId);
    const p = toBoard(e.clientX, e.clientY);
    mode = { kind: 'connect', from: card.id, cx: p.x, cy: p.y };
  }

  function onPointerMove(e: PointerEvent) {
    const m = mode; // capture so narrowing survives inside closures
    if (m.kind === 'pan') {
      tx = m.tx0 + (e.clientX - m.startX);
      ty = m.ty0 + (e.clientY - m.startY);
    } else if (m.kind === 'card') {
      const p = toBoard(e.clientX, e.clientY);
      const card = cards.find((c) => c.id === m.id);
      if (card) {
        card.x = p.x - m.offX;
        card.y = p.y - m.offY;
        markDirty();
      }
    } else if (m.kind === 'connect') {
      const p = toBoard(e.clientX, e.clientY);
      mode = { ...m, cx: p.x, cy: p.y };
    }
  }

  function cardAtPoint(bx: number, by: number): CanvasCard | undefined {
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      if (bx >= c.x && bx <= c.x + c.w && by >= c.y && by <= c.y + c.h) return c;
    }
    return undefined;
  }

  function onPointerUp(e: PointerEvent) {
    const m = mode;
    if (m.kind === 'connect') {
      const p = toBoard(e.clientX, e.clientY);
      const target = cardAtPoint(p.x, p.y);
      const from = m.from;
      if (
        target &&
        target.id !== from &&
        !edges.some((ed) => ed.from === from && ed.to === target.id)
      ) {
        edges.push({ id: uid(), from, to: target.id });
        markDirty();
      }
    }
    mode = { kind: 'none' };
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = boardEl!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(3, Math.max(0.2, scale * factor));
    const bx = (sx - tx) / scale;
    const by = (sy - ty) / scale;
    scale = next;
    tx = sx - bx * scale;
    ty = sy - by * scale;
  }

  // The in-progress "rubber band" line while dragging a connector.
  let tempEdge = $derived.by(() => {
    const m = mode;
    if (m.kind !== 'connect') return null;
    const a = cards.find((c) => c.id === m.from);
    if (!a) return null;
    return { x1: a.x + a.w / 2, y1: a.y + a.h / 2, x2: m.cx, y2: m.cy };
  });

  function edgeGeom(edge: CanvasEdge): { x1: number; y1: number; x2: number; y2: number } | null {
    const a = cards.find((c) => c.id === edge.from);
    const b = cards.find((c) => c.id === edge.to);
    if (!a || !b) return null;
    return { x1: a.x + a.w / 2, y1: a.y + a.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h / 2 };
  }

  // ── Persistence ─────────────────────────────────────────────────────────────
  // A canvas is stored as a note tagged 'canvas' whose content is the JSON doc.
  const CANVAS_TAG = 'canvas';

  let savedCanvases = $derived(notesStore.notes.filter((n) => (n.tags ?? []).includes(CANVAS_TAG)));

  function serialize(): string {
    return JSON.stringify({ v: 1, name: canvasName, cards, edges }, null, 0);
  }

  async function save(
    announce = true,
    expectedRevision = canvasRevision ?? undefined,
  ): Promise<boolean> {
    if (!dirty && canvasNoteId) return true;
    if (loadedProjectPath !== projectStore.currentPath) return false;
    if (savePromise) {
      const pending = savePromise;
      const success = await pending;
      if (!success) return false;
      return dirty && !notesStore.conflict ? save(announce) : true;
    }

    const version = editVersion;
    const content = serialize();
    const title = canvasName.trim() || 'Untitled canvas';
    const existingId = canvasNoteId;
    savePromise = (async () => {
      let saved = false;
      if (existingId) {
        const note = await notesStore.updateNote(existingId, {
          title,
          content,
          tags: [CANVAS_TAG],
          expectedRevision,
        });
        if (note) {
          canvasRevision = note.revision;
          saved = true;
        }
      } else {
        const note = await notesStore.createNote({
          title,
          content,
          tags: [CANVAS_TAG],
          folderPath: '/canvases',
        });
        if (note) {
          canvasNoteId = note.id;
          canvasRevision = note.revision;
          saved = true;
        }
      }
      if (!saved) return false;
      if (version === editVersion) dirty = false;
      if (announce) toastStore.success('Canvas saved');
      return true;
    })().finally(() => {
      savePromise = null;
    });
    return savePromise;
  }

  async function persistCanvas(trigger: DraftLifecycleTrigger): Promise<boolean> {
    if (trigger !== 'explicit' && savePromise) {
      const success = await savePromise;
      if (!success) return false;
    }
    const action = draftLifecycleAction({
      trigger,
      dirty,
      autosaveEnabled: notesStore.settings.autosaveEnabled,
      sameScope: loadedProjectPath === projectStore.currentPath,
    });
    if (action === 'block') return false;
    if (action === 'save') return save(trigger === 'explicit');
    if (action === 'hold') holdCurrentCanvas();
    return true;
  }

  function resetCanvasState() {
    cards = [];
    edges = [];
    canvasName = 'Untitled canvas';
    canvasNoteId = null;
    canvasRevision = null;
    scale = 1;
    tx = 0;
    ty = 0;
    dirty = false;
    canvasDraftId = `draft:${uid()}`;
    keyboardConnectFrom = null;
  }

  function isSafeCanvasColor(value: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(value);
  }

  function applyCanvasDocument(note: Pick<Note, 'id' | 'title' | 'content' | 'revision'>): boolean {
    try {
      const doc = JSON.parse(note.content) as Record<string, unknown>;
      const parsedCards = Array.isArray(doc.cards)
        ? doc.cards.filter(
            (card): card is CanvasCard =>
              Boolean(card) &&
              typeof card === 'object' &&
              typeof card.id === 'string' &&
              typeof card.x === 'number' &&
              Number.isFinite(card.x) &&
              Math.abs(card.x) <= 1_000_000 &&
              typeof card.y === 'number' &&
              Number.isFinite(card.y) &&
              Math.abs(card.y) <= 1_000_000 &&
              typeof card.w === 'number' &&
              card.w >= 80 &&
              card.w <= 1200 &&
              typeof card.h === 'number' &&
              card.h >= 60 &&
              card.h <= 1200 &&
              typeof card.text === 'string' &&
              card.text.length <= 100_000 &&
              typeof card.color === 'string' &&
              isSafeCanvasColor(card.color),
          )
        : [];
      const cardIds = new Set(parsedCards.map((card) => card.id));
      const parsedEdges = Array.isArray(doc.edges)
        ? doc.edges.filter(
            (edge): edge is CanvasEdge =>
              Boolean(edge) &&
              typeof edge === 'object' &&
              typeof edge.id === 'string' &&
              typeof edge.from === 'string' &&
              typeof edge.to === 'string' &&
              cardIds.has(edge.from) &&
              cardIds.has(edge.to),
          )
        : [];
      cards = parsedCards.slice(0, 2000);
      edges = parsedEdges.slice(0, 5000);
      canvasName =
        typeof doc.name === 'string' && doc.name.trim()
          ? doc.name.trim().slice(0, 200)
          : note.title.slice(0, 200);
      canvasNoteId = note.id;
      canvasRevision = note.revision;
      canvasDraftId = `note:${note.id}`;
      scale = 1;
      tx = 0;
      ty = 0;
      dirty = false;
      notesStore.clearConflict();
      notesStore.clearError();
      return true;
    } catch (err: unknown) {
      console.debug(
        'Failed to parse canvas JSON:',
        err instanceof Error ? err.message : String(err),
      );
      toastStore.error('Could not parse this canvas');
      return false;
    }
  }

  async function loadCanvas(noteId: string) {
    if (!(await persistCanvas('navigation'))) return;
    const note = await notesStore.readNote(noteId);
    if (note) applyCanvasDocument(note);
  }

  async function newCanvas() {
    if (!(await persistCanvas('navigation'))) return;
    resetCanvasState();
  }

  // Note picker for "add note card"
  let showNotePicker = $state(false);
  let notePickerQuery = $state('');
  let notePickerResults = $derived(
    notesStore.notes
      .filter((n) => !(n.tags ?? []).includes(CANVAS_TAG))
      .filter(
        (n) => !notePickerQuery || n.title.toLowerCase().includes(notePickerQuery.toLowerCase()),
      )
      .slice(0, 8),
  );

  function toggleKeyboardConnection(cardId: string) {
    if (!keyboardConnectFrom) {
      keyboardConnectFrom = cardId;
      toastStore.info('Connection started. Activate the connector on another card to finish.');
      return;
    }
    const from = keyboardConnectFrom;
    keyboardConnectFrom = null;
    if (from !== cardId && !edges.some((edge) => edge.from === from && edge.to === cardId)) {
      edges.push({ id: uid(), from, to: cardId });
      markDirty();
    }
  }

  function handleCardKeydown(event: KeyboardEvent, card: CanvasCard) {
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 50 : 10;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') card.x -= step;
    if (event.key === 'ArrowRight') card.x += step;
    if (event.key === 'ArrowUp') card.y -= step;
    if (event.key === 'ArrowDown') card.y += step;
    markDirty();
  }

  async function recoverStrandedCanvas() {
    const snapshot = strandedCanvas;
    if (!snapshot) return;
    const selection = await selectProjectNavigation(snapshot.projectPath);
    if (!selection.ok) {
      toastStore.error(selection.error);
      return;
    }
    await tick();
    await notesStore.fetchNotes();
    if (projectStore.currentPath !== snapshot.projectPath) return;
    canvasName = snapshot.name;
    canvasNoteId = snapshot.noteId;
    canvasRevision = snapshot.revision;
    canvasDraftId = snapshot.draftId;
    cards = snapshot.cards.map((card) => ({ ...card }));
    edges = snapshot.edges.map((edge) => ({ ...edge }));
    editVersion++;
    dirty = true;
    draftRegistry.delete(canvasDraftKey(snapshot));
    refreshStrandedCanvases();
    toastStore.info(`Recovered the unsaved canvas “${snapshot.name}”`);
  }

  function discardStrandedCanvas() {
    const snapshot = strandedCanvas;
    if (!snapshot) return;
    if (!confirm(`Discard the unsaved canvas “${snapshot.name}”?`)) return;
    draftRegistry.delete(canvasDraftKey(snapshot));
    refreshStrandedCanvases();
    toastStore.info('Discarded the held canvas draft');
  }

  function loadRemoteCanvas() {
    const remote = notesStore.conflict?.remote;
    if (!remote || remote.id !== canvasNoteId) return;
    applyCanvasDocument(remote);
  }

  function keepLocalCanvas() {
    const remote = notesStore.conflict?.remote;
    if (!remote || remote.id !== canvasNoteId) return;
    notesStore.clearConflict();
    notesStore.clearError();
    void save(true, remote.revision);
  }

  async function retryCanvas() {
    notesStore.clearError();
    if (dirty) {
      await save();
      return;
    }
    if (!canvasNoteId) return;
    const note = await notesStore.readNote(canvasNoteId);
    if (note) applyCanvasDocument(note);
  }

  $effect(() => {
    const projectPath = projectStore.currentPath;
    if (projectPath === loadedProjectPath) return;
    const previousProjectPath = loadedProjectPath;
    if (previousProjectPath !== undefined && previousProjectPath !== null && dirty) {
      holdCurrentCanvas(previousProjectPath);
    }
    loadedProjectPath = projectPath;
    resetCanvasState();
  });

  $effect(() => {
    if (
      !dirty ||
      !notesStore.settings.autosaveEnabled ||
      loadedProjectPath !== projectStore.currentPath
    ) {
      return;
    }
    const timer = setTimeout(
      () => void persistCanvas('autosave'),
      Math.max(250, notesStore.settings.autosaveDelayMs),
    );
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!dirty && strandedCanvases.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  function handleWindowKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void persistCanvas('explicit');
    } else if (event.key === 'Escape') {
      showNotePicker = false;
      keyboardConnectFrom = null;
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') void persistCanvas('visibility-hidden');
  }

  onMount(() => {
    window.addEventListener('keydown', handleWindowKeydown);
    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleWindowKeydown);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    void persistCanvas('destroy');
  });

  let autoOpenedDemoCanvas = $state(false);
  $effect(() => {
    // Notes seed asynchronously in the website demo. Waiting for the reactive
    // collection avoids an empty canvas caused by mounting before that seed.
    if (!autoOpenedDemoCanvas && savedCanvases.length > 0) {
      void loadCanvas(savedCanvases[0].id);
      autoOpenedDemoCanvas = true;
    }
  });
</script>

<div class="relative w-full h-full overflow-hidden" style="background: var(--color-surface-1);">
  <!-- Toolbar -->
  <div class="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2">
    <input
      bind:value={canvasName}
      oninput={markDirty}
      class="h-8 rounded-md border px-3 text-xs"
      style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary); width: 160px;"
      placeholder="Canvas name"
      aria-label="Canvas name"
    />
    <button type="button" class="canvas-btn" onclick={() => addCard()}>
      <Plus size={12} /> Card
    </button>
    <button
      type="button"
      class="canvas-btn"
      onclick={() => (showNotePicker = !showNotePicker)}
      aria-expanded={showNotePicker}
    >
      <StickyNote size={12} /> Note card
    </button>
    <button
      type="button"
      class="canvas-btn"
      onclick={() => void persistCanvas('explicit')}
      title="Save canvas"
    >
      <Save size={12} /> Save{dirty ? ' •' : ''}
    </button>
    <button type="button" class="canvas-btn" onclick={() => void newCanvas()}>New</button>
    {#if savedCanvases.length > 0}
      <div class="w-48">
        <KorySelect
          compact
          value={canvasNoteId ?? ''}
          options={savedCanvases.map((canvas) => ({ value: canvas.id, label: canvas.title }))}
          label="Open canvas"
          placeholder="Open canvas…"
          onchange={(value) => void loadCanvas(value)}
        />
      </div>
    {/if}
  </div>

  {#if showNotePicker}
    <div
      class="absolute top-14 left-3 z-30 w-64 rounded-lg border p-2 shadow-xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
    >
      <input
        bind:value={notePickerQuery}
        class="w-full h-8 rounded-md border px-2 text-xs mb-2"
        style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text-primary);"
        placeholder="Search notes…"
        aria-label="Search notes for canvas"
      />
      {#each notePickerResults as n (n.id)}
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-primary);"
          onclick={() => {
            addCard(n.id);
            showNotePicker = false;
          }}
        >
          <FileText size={12} />
          {n.title}
        </button>
      {:else}
        <div class="text-xs px-2 py-1.5" style="color: var(--color-text-muted);">No notes</div>
      {/each}
    </div>
  {/if}

  {#if strandedCanvas}
    <div
      class="absolute left-1/2 top-16 z-40 flex w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border bg-[var(--color-surface-1)] p-3 shadow-xl"
      style="border-color: color-mix(in srgb, var(--color-warning) 35%, var(--color-border));"
      role="alert"
    >
      <p class="min-w-52 flex-1 text-xs leading-5 text-[var(--color-text-secondary)]">
        Unsaved canvas “{strandedCanvas.name}” is held from {projectDisplayName(
          strandedCanvas.projectPath,
        )}. It was preserved without writing to disk.
        {#if strandedCanvases.length > 1}
          {strandedCanvases.length - 1} more held canvas {strandedCanvases.length === 2
            ? 'draft is'
            : 'drafts are'} queued behind it.
        {/if}
      </p>
      <button
        type="button"
        class="rounded-lg px-2.5 py-1.5 text-xs font-semibold hover:brightness-110"
        style="background: var(--color-warning); color: var(--color-surface-0);"
        onclick={() => void recoverStrandedCanvas()}>Return and recover</button
      >
      <button
        type="button"
        class="rounded-lg border border-[var(--color-warning)]/35 px-2.5 py-1.5 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
        onclick={discardStrandedCanvas}>Discard</button
      >
    </div>
  {/if}

  {#if !strandedCanvas && notesStore.conflict?.noteId === canvasNoteId}
    <div
      class="absolute left-1/2 top-16 z-40 flex w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border bg-[var(--color-surface-1)] p-3 shadow-xl"
      style="border-color: color-mix(in srgb, var(--color-warning) 35%, var(--color-border)); background: var(--color-warning-bg);"
      role="alert"
    >
      <AlertTriangle size={16} class="shrink-0 text-[var(--color-warning)]" />
      <p class="min-w-52 flex-1 text-xs leading-5 text-[var(--color-text-primary)]">
        This canvas changed elsewhere. Your local map is still intact.
      </p>
      <button
        type="button"
        class="rounded-lg border border-[var(--color-warning)]/35 px-2.5 py-1.5 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
        onclick={loadRemoteCanvas}>Load newer canvas</button
      >
      <button
        type="button"
        class="rounded-lg px-2.5 py-1.5 text-xs font-semibold hover:brightness-110"
        style="background: var(--color-warning); color: var(--color-surface-0);"
        onclick={keepLocalCanvas}>Keep my canvas</button
      >
    </div>
  {:else if !strandedCanvas && notesStore.error}
    <div
      class="absolute left-1/2 top-16 z-40 flex w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border p-3 shadow-xl"
      style="border-color: color-mix(in srgb, var(--color-error) 35%, var(--color-border)); background: var(--color-error-bg);"
      role="alert"
    >
      <AlertTriangle size={16} class="shrink-0 text-[var(--color-error)]" />
      <p class="min-w-52 flex-1 text-xs leading-5 text-[var(--color-text-primary)]">
        {notesStore.error}
      </p>
      <button
        type="button"
        class="rounded-lg border border-[var(--color-error)]/35 px-2.5 py-1.5 text-xs text-[var(--color-error)] hover:bg-[var(--color-error-bg)]"
        onclick={() => void retryCanvas()}>Retry</button
      >
    </div>
  {/if}

  <div class="absolute top-3 right-3 z-20 text-[11px]" style="color: var(--color-text-muted);">
    {cards.length} cards · {edges.length} links · scroll to zoom, drag bg to pan
  </div>

  <!-- Board -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={boardEl}
    class="absolute inset-0 touch-none"
    style="cursor: {mode.kind === 'pan' ? 'grabbing' : 'grab'};"
    onpointerdown={onBoardPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onwheel={onWheel}
  >
    <div
      class="absolute top-0 left-0 origin-top-left"
      style="transform: translate({tx}px, {ty}px) scale({scale});"
    >
      <!-- Edges (SVG overlay in board coords) -->
      <svg
        class="absolute top-0 left-0 overflow-visible pointer-events-none"
        style="width: 1px; height: 1px;"
      >
        {#each edges as edge (edge.id)}
          {@const g = edgeGeom(edge)}
          {#if g}
            <line
              x1={g.x1}
              y1={g.y1}
              x2={g.x2}
              y2={g.y2}
              stroke="var(--color-accent)"
              stroke-opacity="0.6"
              stroke-width={2 / scale}
              class="pointer-events-auto cursor-pointer"
              role="button"
              tabindex="0"
              aria-label="Delete canvas connection"
              onpointerdown={(e) => {
                e.stopPropagation();
                removeEdge(edge.id);
              }}
              onkeydown={(event) => {
                if (event.key === 'Enter' || event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  removeEdge(edge.id);
                }
              }}
            />
          {/if}
        {/each}
        {#if tempEdge}
          <line
            x1={tempEdge.x1}
            y1={tempEdge.y1}
            x2={tempEdge.x2}
            y2={tempEdge.y2}
            stroke="var(--color-accent)"
            stroke-opacity="0.9"
            stroke-width={2 / scale}
            stroke-dasharray="4 3"
          />
        {/if}
      </svg>

      <!-- Cards -->
      {#each cards as card (card.id)}
        <div
          class="absolute rounded-lg border shadow-lg select-none flex flex-col"
          style="left: {card.x}px; top: {card.y}px; width: {card.w}px; height: {card.h}px;
                 background: var(--color-surface-2); border-color: {card.color}; border-left-width: 3px;"
        >
          <div
            class="flex items-center justify-between px-2 py-1 cursor-move"
            style="border-bottom: 1px solid var(--color-border);"
          >
            <button
              type="button"
              class="min-w-0 flex-1 cursor-move truncate text-left text-[10px] uppercase tracking-wide"
              style="color: {card.color};"
              title="Drag to move. Use the arrow keys for precise movement."
              aria-label="Move canvas card: {card.text.slice(0, 80) || 'Untitled'}"
              onpointerdown={(event) => onCardPointerDown(event, card)}
              onkeydown={(event) => handleCardKeydown(event, card)}
            >
              {card.noteId ? 'Note' : 'Card'}
            </button>
            <div class="flex items-center gap-1">
              {#if card.noteId}
                <button
                  type="button"
                  class="opacity-60 hover:opacity-100"
                  title="Open note"
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => card.noteId && onOpenNote?.(card.noteId)}
                >
                  <FileText size={11} />
                </button>
              {/if}
              <button
                type="button"
                class="opacity-60 hover:opacity-100"
                title="Delete card"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => removeCard(card.id)}
              >
                <X size={11} />
              </button>
            </div>
          </div>
          <textarea
            class="flex-1 resize-none bg-transparent px-2 py-1 text-xs outline-none"
            style="color: var(--color-text-primary);"
            bind:value={card.text}
            oninput={markDirty}
            onpointerdown={(e) => e.stopPropagation()}
            aria-label="Card text"
          ></textarea>
          <!-- connector handle -->
          <button
            type="button"
            class="absolute -right-2 top-1/2 -translate-y-1/2 rounded-full"
            style="width: 12px; height: 12px; background: {card.color}; border: 2px solid var(--color-surface-1); cursor: crosshair;"
            title="Drag to connect"
            aria-label={keyboardConnectFrom
              ? 'Finish keyboard connection on this card'
              : 'Connect this card'}
            onpointerdown={(e) => onHandlePointerDown(e, card)}
            onclick={(event) => {
              if (event.detail === 0) toggleKeyboardConnection(card.id);
            }}
          ></button>
        </div>
      {/each}
    </div>
  </div>

  {#if cards.length === 0}
    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <div class="text-center" style="color: var(--color-text-muted);">
        <StickyNote size={36} class="mx-auto mb-3 opacity-40" />
        <div class="text-sm font-medium">Empty canvas</div>
        <div class="text-xs mt-1 opacity-70">
          Add a card or drop a note to start mapping ideas spatially
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .canvas-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    font-size: 11px;
    transition: background 0.15s;
  }
  .canvas-btn:hover {
    background: var(--color-surface-3);
  }
</style>
