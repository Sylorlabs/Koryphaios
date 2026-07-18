<script lang="ts">
  import { Plus, Save, Trash2, FileText, X, StickyNote } from 'lucide-svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

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

  const CARD_COLORS = ['#8b7ec8', '#6b9bd1', '#5ec4a0', '#d4845c', '#c47fd0', '#e8a85a'];

  // ── Canvas document state ───────────────────────────────────────────────────
  let cards = $state<CanvasCard[]>([]);
  let edges = $state<CanvasEdge[]>([]);
  let canvasName = $state('Untitled canvas');
  let canvasNoteId = $state<string | null>(null);
  let dirty = $state(false);

  // ── Viewport (pan / zoom) ───────────────────────────────────────────────────
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let boardEl = $state<HTMLDivElement | undefined>(undefined);

  function uid(): string {
    return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.floor(performance.now())}`;
  }

  function toBoard(clientX: number, clientY: number): { x: number; y: number } {
    const rect = boardEl!.getBoundingClientRect();
    return { x: (clientX - rect.left - tx) / scale, y: (clientY - rect.top - ty) / scale };
  }

  // ── Card / edge creation ────────────────────────────────────────────────────
  function addCard(noteId?: string, text = 'New card') {
    const center = boardEl
      ? toBoard(boardEl.getBoundingClientRect().left + boardEl.clientWidth / 2, boardEl.getBoundingClientRect().top + boardEl.clientHeight / 2)
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
    dirty = true;
  }

  function removeCard(id: string) {
    cards = cards.filter((c) => c.id !== id);
    edges = edges.filter((e) => e.from !== id && e.to !== id);
    dirty = true;
  }

  function removeEdge(id: string) {
    edges = edges.filter((e) => e.id !== id);
    dirty = true;
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
        dirty = true;
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
      if (target && target.id !== from && !edges.some((ed) => ed.from === from && ed.to === target.id)) {
        edges.push({ id: uid(), from, to: target.id });
        dirty = true;
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

  let savedCanvases = $derived(
    notesStore.notes.filter((n) => (n.tags ?? []).includes(CANVAS_TAG)),
  );

  function serialize(): string {
    return JSON.stringify({ v: 1, name: canvasName, cards, edges }, null, 0);
  }

  async function save() {
    const content = serialize();
    if (canvasNoteId) {
      await notesStore.updateNote(canvasNoteId, { title: canvasName, content, tags: [CANVAS_TAG] });
    } else {
      const note = await notesStore.createNote({
        title: canvasName,
        content,
        tags: [CANVAS_TAG],
        folderPath: '/canvases',
      });
      if (note) canvasNoteId = note.id;
    }
    dirty = false;
    toastStore.success('Canvas saved');
  }

  function loadCanvas(noteId: string) {
    const note = notesStore.notes.find((n) => n.id === noteId);
    if (!note) return;
    try {
      const doc = JSON.parse(note.content);
      cards = Array.isArray(doc.cards) ? doc.cards : [];
      edges = Array.isArray(doc.edges) ? doc.edges : [];
      canvasName = doc.name ?? note.title;
      canvasNoteId = note.id;
      scale = 1;
      tx = 0;
      ty = 0;
      dirty = false;
    } catch {
      toastStore.error('Could not parse this canvas');
    }
  }

  function newCanvas() {
    cards = [];
    edges = [];
    canvasName = 'Untitled canvas';
    canvasNoteId = null;
    scale = 1;
    tx = 0;
    ty = 0;
    dirty = false;
  }

  // Note picker for "add note card"
  let showNotePicker = $state(false);
  let notePickerQuery = $state('');
  let notePickerResults = $derived(
    notesStore.notes
      .filter((n) => !(n.tags ?? []).includes(CANVAS_TAG))
      .filter((n) => !notePickerQuery || n.title.toLowerCase().includes(notePickerQuery.toLowerCase()))
      .slice(0, 8),
  );

  let autoOpenedDemoCanvas = $state(false);
  $effect(() => {
    // Notes seed asynchronously in the website demo. Waiting for the reactive
    // collection avoids an empty canvas caused by mounting before that seed.
    if (!autoOpenedDemoCanvas && savedCanvases.length > 0) {
      loadCanvas(savedCanvases[0].id);
      autoOpenedDemoCanvas = true;
    }
  });
</script>

<div class="relative w-full h-full overflow-hidden" style="background: var(--color-surface-1);">
  <!-- Toolbar -->
  <div class="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2">
    <input
      bind:value={canvasName}
      oninput={() => (dirty = true)}
      class="h-8 rounded-md border px-3 text-xs"
      style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary); width: 160px;"
      placeholder="Canvas name"
    />
    <button type="button" class="canvas-btn" onclick={() => addCard()}>
      <Plus size={12} /> Card
    </button>
    <button type="button" class="canvas-btn" onclick={() => (showNotePicker = !showNotePicker)}>
      <StickyNote size={12} /> Note card
    </button>
    <button type="button" class="canvas-btn" onclick={save} title="Save canvas">
      <Save size={12} /> Save{dirty ? ' •' : ''}
    </button>
    <button type="button" class="canvas-btn" onclick={newCanvas}>New</button>
    {#if savedCanvases.length > 0}
      <select
        class="h-8 rounded-md border px-2 text-xs"
        style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
        onchange={(e) => loadCanvas((e.currentTarget as HTMLSelectElement).value)}
        value={canvasNoteId ?? ''}
      >
        <option value="" disabled>Open canvas…</option>
        {#each savedCanvases as c (c.id)}
          <option value={c.id}>{c.title}</option>
        {/each}
      </select>
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
      />
      {#each notePickerResults as n (n.id)}
        <button
          type="button"
          class="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-white/5 flex items-center gap-1.5"
          style="color: var(--color-text-primary);"
          onclick={() => { addCard(n.id); showNotePicker = false; }}
        >
          <FileText size={12} /> {n.title}
        </button>
      {:else}
        <div class="text-xs px-2 py-1.5" style="color: var(--color-text-muted);">No notes</div>
      {/each}
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
    <div class="absolute top-0 left-0 origin-top-left" style="transform: translate({tx}px, {ty}px) scale({scale});">
      <!-- Edges (SVG overlay in board coords) -->
      <svg class="absolute top-0 left-0 overflow-visible pointer-events-none" style="width: 1px; height: 1px;">
        {#each edges as edge (edge.id)}
          {@const g = edgeGeom(edge)}
          {#if g}
            <line
              x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}
              stroke="rgba(139,126,200,0.6)" stroke-width={2 / scale}
              class="pointer-events-auto cursor-pointer"
              role="button" tabindex="-1"
              onpointerdown={(e) => { e.stopPropagation(); removeEdge(edge.id); }}
            />
          {/if}
        {/each}
        {#if tempEdge}
          <line x1={tempEdge.x1} y1={tempEdge.y1} x2={tempEdge.x2} y2={tempEdge.y2} stroke="rgba(139,126,200,0.9)" stroke-width={2 / scale} stroke-dasharray="4 3" />
        {/if}
      </svg>

      <!-- Cards -->
      {#each cards as card (card.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="absolute rounded-lg border shadow-lg select-none flex flex-col"
          style="left: {card.x}px; top: {card.y}px; width: {card.w}px; height: {card.h}px;
                 background: var(--color-surface-2); border-color: {card.color}; border-left-width: 3px;"
          onpointerdown={(e) => onCardPointerDown(e, card)}
        >
          <div class="flex items-center justify-between px-2 py-1 cursor-move" style="border-bottom: 1px solid var(--color-border);">
            <span class="text-[10px] uppercase tracking-wide truncate" style="color: {card.color};">
              {card.noteId ? 'Note' : 'Card'}
            </span>
            <div class="flex items-center gap-1">
              {#if card.noteId}
                <button type="button" class="opacity-60 hover:opacity-100" title="Open note"
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={() => card.noteId && onOpenNote?.(card.noteId)}>
                  <FileText size={11} />
                </button>
              {/if}
              <button type="button" class="opacity-60 hover:opacity-100" title="Delete card"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => removeCard(card.id)}>
                <X size={11} />
              </button>
            </div>
          </div>
          <textarea
            class="flex-1 resize-none bg-transparent px-2 py-1 text-xs outline-none"
            style="color: var(--color-text-primary);"
            bind:value={card.text}
            oninput={() => (dirty = true)}
            onpointerdown={(e) => e.stopPropagation()}
          ></textarea>
          <!-- connector handle -->
          <button
            type="button"
            class="absolute -right-2 top-1/2 -translate-y-1/2 rounded-full"
            style="width: 12px; height: 12px; background: {card.color}; border: 2px solid var(--color-surface-1); cursor: crosshair;"
            title="Drag to connect"
            aria-label="Connect card"
            onpointerdown={(e) => onHandlePointerDown(e, card)}
          ></button>
        </div>
      {/each}
    </div>
  </div>

  {#if cards.length === 0}
    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <div class="text-center" style="color: var(--color-text-muted);">
        <div class="text-4xl mb-3 opacity-40">▦</div>
        <div class="text-sm font-medium">Empty canvas</div>
        <div class="text-xs mt-1 opacity-70">Add a card or drop a note to start mapping ideas spatially</div>
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
