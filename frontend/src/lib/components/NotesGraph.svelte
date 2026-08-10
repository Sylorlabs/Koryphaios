<script lang="ts">
  import * as d3 from 'd3';
  import { onMount, onDestroy } from 'svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { GraphNode, GraphEdge } from '@koryphaios/shared';
  import Share2 from 'lucide-svelte/icons/share-2';

  interface Props {
    onNodeClick: (noteId: string) => void;
  }

  let { onNodeClick }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement | undefined>(undefined);
  let containerEl = $state<HTMLDivElement | undefined>(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let simulation: d3.Simulation<any, any> | null = null;
  let searchQuery = $state('');
  let showLabels = $state(true);
  let localGraph = $state(false);
  let selectedNodeId = $state<string | null>(null);
  let hoveredNodeId = $state<string | null>(null);
  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipTitle = $state('');
  let tooltipMeta = $state('');
  let performanceLayout = $state(false);

  const FOLDER_COLOR_TOKENS = [
    '--color-accent',
    '--color-info',
    '--color-success',
    '--color-warning',
    '--color-error',
    '--color-text-secondary',
  ] as const;

  const folderColorMap = new Map<string, (typeof FOLDER_COLOR_TOKENS)[number]>();
  let colorIndex = 0;

  type SimNode = d3.SimulationNodeDatum &
    GraphNode & { x: number; y: number; vx: number; vy: number };
  type SimLink = { source: SimNode; target: SimNode };

  function themeColor(token: string): string {
    if (!containerEl) return 'currentColor';
    return getComputedStyle(containerEl).getPropertyValue(token).trim() || 'currentColor';
  }

  function getFolderColorToken(folderPath: string): (typeof FOLDER_COLOR_TOKENS)[number] {
    if (!folderColorMap.has(folderPath)) {
      folderColorMap.set(folderPath, FOLDER_COLOR_TOKENS[colorIndex % FOLDER_COLOR_TOKENS.length]);
      colorIndex++;
    }
    return folderColorMap.get(folderPath)!;
  }

  function getFolderColor(folderPath: string): string {
    return themeColor(getFolderColorToken(folderPath));
  }

  function getNodeRadius(linkCount: number, includeInContext: boolean): number {
    const base = 4 + Math.sqrt(linkCount + 1) * 2.2;
    return Math.min(base + (includeInContext ? 2 : 0), 22);
  }

  function getNeighborSet(nodeId: string | null, edges: GraphEdge[]): Set<string> {
    if (!nodeId) return new Set();
    const neighbors = new Set<string>([nodeId]);
    for (const edge of edges) {
      if (edge.from === nodeId) neighbors.add(edge.to);
      if (edge.to === nodeId) neighbors.add(edge.from);
    }
    return neighbors;
  }

  // ── Canvas render state ─────────────────────────────────────────────────────
  // Canvas 2D scales to thousands of nodes where an equivalent SVG DOM janks, so
  // there is no node cap — the whole vault renders. World↔screen is a manual
  // affine transform (scale + translate) we also use for hit-testing.
  let simNodes: SimNode[] = [];
  let simLinks: SimLink[] = [];
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;

  function toWorld(sx: number, sy: number): [number, number] {
    return [(sx - tx) / scale, (sy - ty) / scale];
  }

  function getVisibleGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const { nodes, edges } = notesStore.graphData;
    if (localGraph && selectedNodeId) {
      const keep = getNeighborSet(selectedNodeId, edges);
      const filteredNodes = nodes.filter((n) => keep.has(n.id));
      const ids = new Set(filteredNodes.map((n) => n.id));
      const filteredEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
      return { nodes: filteredNodes, edges: filteredEdges };
    }
    return { nodes, edges };
  }

  function nodeAt(sx: number, sy: number): SimNode | null {
    const [wx, wy] = toWorld(sx, sy);
    // Search nearest within its radius; iterate in reverse so topmost wins.
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      const r = getNodeRadius(n.linkCount, n.includeInContext) + 3;
      const dx = n.x - wx;
      const dy = n.y - wy;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  function draw() {
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const edges = notesStore.graphData.edges;
    const focusId = hoveredNodeId ?? selectedNodeId;
    const neighbors = getNeighborSet(focusId, edges);
    const q = searchQuery.trim().toLowerCase();

    // Links
    for (const l of simLinks) {
      const s = l.source;
      const t = l.target;
      const lit = focusId && (s.id === focusId || t.id === focusId);
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const curv = Math.min(36, dist * 0.15);
      const mx = (s.x + t.x) / 2 + (-dy / dist) * curv;
      const my = (s.y + t.y) / 2 + (dx / dist) * curv;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(mx, my, t.x, t.y);
      ctx.strokeStyle = lit ? themeColor('--color-accent') : themeColor('--color-text-muted');
      ctx.globalAlpha = lit ? 0.8 : focusId ? 0.1 : 0.3;
      ctx.lineWidth = (lit ? 1.8 : 1) / scale;
      ctx.stroke();
    }

    // Nodes
    const drawLabels = showLabels && (scale >= 0.85 || simNodes.length <= 220);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of simNodes) {
      const r = getNodeRadius(n.linkCount, n.includeInContext);
      const matches = !q || n.title.toLowerCase().includes(q);
      const dim = (focusId && !neighbors.has(n.id)) || !matches;
      const color = getFolderColor(n.folderPath);
      ctx.globalAlpha = dim ? 0.14 : 1;

      // halo
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = dim ? 0.05 : 0.18;
      ctx.fill();

      // core
      ctx.globalAlpha = dim ? 0.16 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = (n.id === focusId ? 2.5 : n.includeInContext ? 2 : 1.2) / scale;
      ctx.strokeStyle = n.includeInContext
        ? themeColor('--color-warning')
        : n.id === focusId
          ? themeColor('--color-text-primary')
          : themeColor('--color-border-bright');
      ctx.stroke();

      if (drawLabels && !dim) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = themeColor('--color-text-primary');
        ctx.font = `${n.linkCount >= 3 ? '600 ' : ''}${9.5 / Math.max(scale, 0.75)}px ui-sans-serif, system-ui, sans-serif`;
        const label = n.title.length > 24 ? n.title.slice(0, 22) + '…' : n.title;
        ctx.fillText(label, n.x, n.y + r + 9 / Math.max(scale, 0.75));
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function resize() {
    if (!canvasEl || !containerEl) return;
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    width = containerEl.clientWidth || 800;
    height = containerEl.clientHeight || 600;
    canvasEl.width = Math.floor(width * dpr);
    canvasEl.height = Math.floor(height * dpr);
    canvasEl.style.width = `${width}px`;
    canvasEl.style.height = `${height}px`;
    draw();
  }

  function buildGraph() {
    if (!canvasEl || !containerEl) return;
    folderColorMap.clear();
    colorIndex = 0;
    simulation?.stop();
    resize();

    const { nodes, edges } = getVisibleGraph();
    if (!nodes.length) {
      simNodes = [];
      simLinks = [];
      draw();
      return;
    }

    const settings = notesStore.settings;
    const { chargeStrength, linkDistance, gravity } = settings.graphPhysics;

    simNodes = nodes.map((n) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * width * 0.35,
      y: height / 2 + (Math.random() - 0.5) * height * 0.35,
      vx: 0,
      vy: 0,
    }));
    const nodeById = new Map(simNodes.map((n) => [n.id, n]));
    simLinks = edges
      .filter((e) => nodeById.has(e.from) && nodeById.has(e.to))
      .map((e) => ({ source: nodeById.get(e.from)!, target: nodeById.get(e.to)! }));

    // Force simulation is attractive for normal vaults but creates sustained
    // main-thread frame drops at very large sizes. Above this boundary, place
    // every node deterministically in folder clusters and draw once. The full
    // graph remains searchable, pannable, zoomable, hoverable, and clickable.
    const STATIC_LAYOUT_THRESHOLD = 2500;
    if (simNodes.length > STATIC_LAYOUT_THRESHOLD) {
      performanceLayout = true;
      const groups = new Map<string, SimNode[]>();
      for (const node of simNodes) {
        const group = groups.get(node.folderPath) ?? [];
        group.push(node);
        groups.set(node.folderPath, group);
      }
      const entries = [...groups.values()];
      const columns = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
      const clusterGap = 260;
      const rows = Math.ceil(entries.length / columns);
      entries.forEach((group, groupIndex) => {
        const column = groupIndex % columns;
        const row = Math.floor(groupIndex / columns);
        const cx = width / 2 + (column - (columns - 1) / 2) * clusterGap;
        const cy = height / 2 + (row - (rows - 1) / 2) * clusterGap;
        group.forEach((node, index) => {
          const angle = index * 2.399963229728653;
          const radius = 10 * Math.sqrt(index);
          node.x = cx + Math.cos(angle) * radius;
          node.y = cy + Math.sin(angle) * radius;
          node.vx = 0;
          node.vy = 0;
        });
      });
      draw();
      return;
    }
    performanceLayout = false;

    // Adaptive physics: big vaults drop the (expensive) collide force, cap the
    // charge range, and settle faster so the sim reaches idle quickly — once
    // idle it stops ticking, so a large static graph costs nothing to display.
    const big = simNodes.length > 800;
    simulation = d3
      .forceSimulation(simNodes)
      .force(
        'charge',
        d3
          .forceManyBody()
          .strength(chargeStrength)
          .distanceMax(big ? 160 : 280),
      )
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(linkDistance)
          .strength(0.55),
      )
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.04))
      .force('x', d3.forceX(width / 2).strength(Math.abs(gravity) / 8000))
      .force('y', d3.forceY(height / 2).strength(Math.abs(gravity) / 8000))
      .velocityDecay(big ? 0.5 : 0.35)
      .alphaDecay(big ? 0.045 : 0.0228);
    if (!big) {
      simulation.force(
        'collide',
        d3
          .forceCollide<SimNode>()
          .radius((d) => getNodeRadius(d.linkCount, d.includeInContext) + 10),
      );
    }
    simulation.on('tick', draw);
  }

  // ── Pointer interaction (pan / zoom / node drag / hover) ────────────────────
  let dragNode: SimNode | null = null;
  let panning = false;
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
  let moved = false;

  function onPointerDown(event: PointerEvent) {
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    moved = false;
    const hit = nodeAt(sx, sy);
    canvasEl.setPointerCapture(event.pointerId);
    if (hit) {
      dragNode = hit;
      simulation?.alphaTarget(0.25).restart();
      const [wx, wy] = toWorld(sx, sy);
      hit.fx = wx;
      hit.fy = wy;
    } else {
      panning = true;
      panStart = { x: sx, y: sy, tx, ty };
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;

    if (dragNode) {
      moved = true;
      const [wx, wy] = toWorld(sx, sy);
      dragNode.fx = wx;
      dragNode.fy = wy;
      dragNode.x = wx;
      dragNode.y = wy;
      if (performanceLayout) draw();
      return;
    }
    if (panning) {
      moved = true;
      tx = panStart.tx + (sx - panStart.x);
      ty = panStart.ty + (sy - panStart.y);
      draw();
      return;
    }
    // Hover
    const hit = nodeAt(sx, sy);
    const id = hit?.id ?? null;
    if (id !== hoveredNodeId) {
      hoveredNodeId = id;
      draw();
    }
    if (hit) {
      tooltipTitle = hit.title;
      tooltipMeta = `${hit.linkCount} links · ${hit.folderPath}${hit.unresolved ? ' · unresolved' : ''}`;
      tooltipX = sx + 14;
      tooltipY = sy - 12;
      tooltipVisible = true;
    } else {
      tooltipVisible = false;
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (canvasEl) canvasEl.releasePointerCapture?.(event.pointerId);
    if (dragNode) {
      if (!event.altKey) {
        dragNode.fx = null;
        dragNode.fy = null;
      }
      simulation?.alphaTarget(0);
      const clicked = dragNode;
      dragNode = null;
      if (!moved) {
        selectedNodeId = selectedNodeId === clicked.id ? null : clicked.id;
        if (localGraph) buildGraph();
        onNodeClick(clicked.id);
        draw();
      }
      return;
    }
    panning = false;
  }

  function onWheel(event: WheelEvent) {
    if (!canvasEl) return;
    event.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(6, Math.max(0.1, scale * factor));
    // Keep the point under the cursor fixed while zooming.
    const [wx, wy] = toWorld(sx, sy);
    scale = next;
    tx = sx - wx * scale;
    ty = sy - wy * scale;
    draw();
  }

  function keyboardCandidates(): SimNode[] {
    const query = searchQuery.trim().toLowerCase();
    return simNodes.filter((node) => !query || node.title.toLowerCase().includes(query));
  }

  function selectKeyboardNode(index: number): void {
    const candidates = keyboardCandidates();
    if (!candidates.length) return;
    const normalized = (index + candidates.length) % candidates.length;
    const node = candidates[normalized];
    selectedNodeId = node.id;
    tooltipTitle = node.title;
    tooltipMeta = `${node.linkCount} links · ${node.folderPath}${node.unresolved ? ' · unresolved' : ''}`;
    // Keep keyboard navigation visible even when the graph has been panned or
    // the selected node is outside the current viewport.
    tx = width / 2 - node.x * scale;
    ty = height / 2 - node.y * scale;
    draw();
  }

  function onCanvasKeydown(event: KeyboardEvent): void {
    const candidates = keyboardCandidates();
    if (!candidates.length) return;
    const current = candidates.findIndex((node) => node.id === selectedNodeId);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectKeyboardNode(current < 0 ? 0 : current + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectKeyboardNode(current < 0 ? candidates.length - 1 : current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectKeyboardNode(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectKeyboardNode(candidates.length - 1);
    } else if ((event.key === 'Enter' || event.key === ' ') && selectedNodeId) {
      event.preventDefault();
      onNodeClick(selectedNodeId);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      scale = Math.min(6, scale * 1.2);
      draw();
    } else if (event.key === '-') {
      event.preventDefault();
      scale = Math.max(0.1, scale / 1.2);
      draw();
    } else if (event.key === '0') {
      event.preventDefault();
      resetView();
    }
  }

  let resizeObserver: ResizeObserver | null = null;
  let resizeFrame: number | null = null;

  function scheduleResize(): void {
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      resize();
    });
  }

  $effect(() => {
    // Redraw when label/search toggles change (no rebuild needed).
    void showLabels;
    void searchQuery;
    draw();
  });

  $effect(() => {
    // Canvas paint values are resolved from live theme tokens, so repaint when
    // either the preset or accent changes instead of keeping old pixel colors.
    void theme.preset;
    void theme.accent;
    requestAnimationFrame(draw);
  });

  $effect(() => {
    void notesStore.graphData;
    void localGraph;
    void selectedNodeId;
    requestAnimationFrame(() => buildGraph());
  });

  onMount(() => {
    void notesStore.fetchGraph().then(() => buildGraph());
    if (containerEl && 'ResizeObserver' in globalThis) {
      // ResizeObserver callbacks run during layout delivery. Mutating canvas
      // dimensions in the callback itself can trigger the browser's
      // undelivered-notification loop warning, so paint on the next frame and
      // coalesce bursts from panel/tab transitions.
      resizeObserver = new ResizeObserver(() => scheduleResize());
      resizeObserver.observe(containerEl);
    }
  });

  onDestroy(() => {
    simulation?.stop();
    resizeObserver?.disconnect();
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  });

  function resetView() {
    scale = 1;
    tx = 0;
    ty = 0;
    draw();
  }

  let legendEntries = $derived.by(() => {
    const seen = new Set<string>();
    const entries: { folder: string; colorToken: string }[] = [];
    void theme.preset;
    void theme.accent;
    for (const n of notesStore.graphData.nodes) {
      if (!seen.has(n.folderPath)) {
        seen.add(n.folderPath);
        entries.push({ folder: n.folderPath, colorToken: getFolderColorToken(n.folderPath) });
      }
    }
    return entries.slice(0, 10);
  });

  let stats = $derived.by(() => {
    const g = notesStore.graphData;
    return { notes: g.nodes.length, links: g.edges.length };
  });
  let graphLoadFailed = $derived(
    Boolean(notesStore.error) &&
      (notesStore.failedOperation?.kind === 'load-graph' ||
        (notesStore.failedOperation?.kind === 'sync-project' &&
          notesStore.graphData.nodes.length === 0)),
  );
</script>

<div
  bind:this={containerEl}
  class="relative w-full h-full overflow-hidden"
  style="background: radial-gradient(ellipse at center, var(--color-surface-2) 0%, var(--color-surface-0) 70%);"
  role="region"
  aria-label="Note graph"
>
  <div class="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="Filter graph..."
      aria-label="Filter graph nodes"
      class="h-8 rounded-md border px-3 text-xs backdrop-blur-sm"
      style="
        background: color-mix(in srgb, var(--color-surface-2) 88%, transparent);
        border-color: var(--color-border);
        color: var(--color-text-primary);
        width: 180px;
      "
    />
    <button
      type="button"
      class="h-8 px-2.5 rounded-md text-[11px] border transition-colors"
      style="
        background: {showLabels ? 'var(--color-info-bg)' : 'var(--color-surface-2)'};
        border-color: var(--color-border);
        color: var(--color-text-primary);
      "
      onclick={() => (showLabels = !showLabels)}
      aria-pressed={showLabels}
    >
      Labels
    </button>
    <button
      type="button"
      class="h-8 px-2.5 rounded-md text-[11px] border transition-colors"
      style="
        background: {localGraph ? 'var(--color-info-bg)' : 'var(--color-surface-2)'};
        border-color: var(--color-border);
        color: var(--color-text-primary);
      "
      onclick={() => {
        localGraph = !localGraph;
        if (!localGraph) selectedNodeId = null;
      }}
      aria-pressed={localGraph}
      title="Show only the selected note and its neighbors"
    >
      Local
    </button>
    <button
      type="button"
      class="h-8 px-2.5 rounded-md text-[11px] border transition-colors hover:bg-[var(--color-surface-3)]"
      style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
      onclick={resetView}
    >
      Reset view
    </button>
  </div>

  <div
    class="absolute top-3 right-3 z-10 flex items-center gap-2 text-[11px]"
    style="color: var(--color-text-muted);"
  >
    <span>{stats.notes} notes · {stats.links} links</span>
    {#if performanceLayout}
      <span
        class="rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
        style="border-color: var(--color-border); color: var(--color-success);"
        >Performance layout</span
      >
    {/if}
    <button
      type="button"
      class="px-2.5 py-1 rounded-md border transition-colors hover:bg-[var(--color-surface-3)]"
      style="border-color: var(--color-border);"
      onclick={() => {
        simulation?.stop();
        void notesStore.fetchGraph().then(() => buildGraph());
      }}
    >
      Refresh
    </button>
  </div>

  <canvas
    bind:this={canvasEl}
    class="w-full h-full touch-none"
    style="display: block; cursor: grab;"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={() => {
      tooltipVisible = false;
    }}
    onwheel={onWheel}
    onkeydown={onCanvasKeydown}
    tabindex="0"
    aria-label="Interactive note graph"
    aria-describedby="note-graph-instructions note-graph-selection"
  ></canvas>

  <p id="note-graph-instructions" class="sr-only">
    Use arrow keys to move between filtered notes, Enter or Space to open the selected note, plus
    and minus to zoom, and zero to reset the view.
  </p>
  <p id="note-graph-selection" class="sr-only" aria-live="polite">
    {selectedNodeId ? `${tooltipTitle}. ${tooltipMeta}` : 'No graph node selected.'}
  </p>

  {#if tooltipVisible}
    <div
      class="pointer-events-none absolute z-20 rounded-md border px-3 py-2 text-xs shadow-xl backdrop-blur-sm"
      style="
        left: {tooltipX}px;
        top: {tooltipY}px;
        background: color-mix(in srgb, var(--color-surface-2) 94%, transparent);
        border-color: var(--color-border-bright);
        color: var(--color-text-primary);
        max-width: 260px;
      "
    >
      <div class="font-semibold truncate">{tooltipTitle}</div>
      <div style="color: var(--color-text-muted);">{tooltipMeta}</div>
    </div>
  {/if}

  {#if legendEntries.length > 0}
    <div
      class="absolute bottom-4 left-4 z-10 rounded-md border p-3 max-w-[220px] backdrop-blur-sm"
      style="
        background: color-mix(in srgb, var(--color-surface-2) 90%, transparent);
        border-color: var(--color-border);
      "
    >
      <div
        class="text-[10px] font-semibold uppercase tracking-widest mb-2"
        style="color: var(--color-text-muted);"
      >
        Vault folders
      </div>
      <div class="space-y-1.5">
        {#each legendEntries as entry (entry.folder)}
          <div class="flex items-center gap-2">
            <div
              class="rounded-full shrink-0"
              style="width: 9px; height: 9px; background: var({entry.colorToken}); box-shadow: 0 0 6px color-mix(in srgb, var({entry.colorToken}) 45%, transparent);"
            ></div>
            <span class="text-[11px] truncate" style="color: var(--color-text-secondary);">
              {entry.folder === '/' ? 'Root' : entry.folder.split('/').pop() || entry.folder}
            </span>
          </div>
        {/each}
      </div>
      <div
        class="mt-2 pt-2 border-t text-[10px]"
        style="border-color: var(--color-border); color: var(--color-text-muted);"
      >
        Outlined ring = explicitly included in agent context · scroll to zoom, drag to pan
      </div>
    </div>
  {/if}

  {#if graphLoadFailed}
    <div class="absolute inset-0 flex flex-col items-center justify-center p-6">
      <div
        class="max-w-sm rounded-lg border p-4 text-center"
        style="background: var(--color-error-bg); border-color: var(--color-error); color: var(--color-text-primary);"
        role="alert"
      >
        <Share2 size={28} class="mx-auto mb-3 text-[var(--color-error)]" />
        <div class="text-sm font-medium">
          {notesStore.failedOperation?.kind === 'sync-project'
            ? 'Project index is incomplete'
            : 'Graph could not be loaded'}
        </div>
        <div class="mt-1 text-xs text-[var(--color-text-secondary)]">{notesStore.error}</div>
        <button
          type="button"
          class="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-2)]"
          style="border-color: var(--color-error); color: var(--color-error);"
          onclick={() => void notesStore.retryFailedOperation()}
          >{notesStore.failedOperation?.kind === 'sync-project'
            ? 'Retry indexing'
            : 'Retry graph'}</button
        >
      </div>
    </div>
  {:else if notesStore.graphData.nodes.length === 0 && !notesStore.isLoading}
    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <div class="text-center" style="color: var(--color-text-muted);">
        <Share2 size={32} class="mx-auto mb-3 opacity-40" />
        <div class="text-sm font-medium">Empty vault</div>
        <div class="text-xs mt-1 opacity-70">
          Create notes or ask an agent to build your network
        </div>
      </div>
    </div>
  {/if}
</div>
