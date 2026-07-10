<script lang="ts">
  import * as d3 from 'd3';
  import { onMount, onDestroy } from 'svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import type { GraphNode, GraphEdge } from '@koryphaios/shared';

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

  const FOLDER_COLORS = [
    '#8b7ec8', '#6b9bd1', '#5ec4a0', '#d4845c', '#c47fd0',
    '#62bfcf', '#e8a85a', '#8fbf6b', '#b87fe0', '#e87fa8',
    '#5ab8e8', '#d5b261',
  ] as const;

  const folderColorMap = new Map<string, string>();
  let colorIndex = 0;

  type SimNode = d3.SimulationNodeDatum &
    GraphNode & { x: number; y: number; vx: number; vy: number };
  type SimLink = { source: SimNode; target: SimNode };

  function getFolderColor(folderPath: string): string {
    if (!folderColorMap.has(folderPath)) {
      folderColorMap.set(folderPath, FOLDER_COLORS[colorIndex % FOLDER_COLORS.length]);
      colorIndex++;
    }
    return folderColorMap.get(folderPath)!;
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
      ctx.strokeStyle = lit
        ? 'rgba(139, 126, 200, 0.8)'
        : focusId
          ? 'rgba(120, 130, 160, 0.10)'
          : 'rgba(120, 130, 160, 0.22)';
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
        ? 'rgba(255, 220, 140, 0.9)'
        : n.id === focusId
          ? 'rgba(255,255,255,0.7)'
          : 'rgba(255, 255, 255, 0.15)';
      ctx.stroke();

      if (drawLabels && !dim) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(220, 225, 240, 0.9)';
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

    // Adaptive physics: big vaults drop the (expensive) collide force, cap the
    // charge range, and settle faster so the sim reaches idle quickly — once
    // idle it stops ticking, so a large static graph costs nothing to display.
    const big = simNodes.length > 800;
    simulation = d3
      .forceSimulation(simNodes)
      .force('charge', d3.forceManyBody().strength(chargeStrength).distanceMax(big ? 160 : 280))
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
        d3.forceCollide<SimNode>().radius((d) => getNodeRadius(d.linkCount, d.includeInContext) + 10),
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

  let resizeObserver: ResizeObserver | null = null;

  $effect(() => {
    // Redraw when label/search toggles change (no rebuild needed).
    void showLabels;
    void searchQuery;
    draw();
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
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(containerEl);
    }
  });

  onDestroy(() => {
    simulation?.stop();
    resizeObserver?.disconnect();
  });

  function resetView() {
    scale = 1;
    tx = 0;
    ty = 0;
    draw();
  }

  let legendEntries = $derived.by(() => {
    const seen = new Set<string>();
    const entries: { folder: string; color: string }[] = [];
    for (const n of notesStore.graphData.nodes) {
      if (!seen.has(n.folderPath)) {
        seen.add(n.folderPath);
        entries.push({ folder: n.folderPath, color: getFolderColor(n.folderPath) });
      }
    }
    return entries.slice(0, 10);
  });

  let stats = $derived.by(() => {
    const g = notesStore.graphData;
    return { notes: g.nodes.length, links: g.edges.length };
  });
</script>

<div
  bind:this={containerEl}
  class="relative w-full h-full overflow-hidden"
  style="background: radial-gradient(ellipse at center, #1a1d2e 0%, #12141f 70%);"
>
  <div class="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="Filter graph..."
      class="h-8 rounded-md border px-3 text-xs backdrop-blur-sm"
      style="
        background: rgba(22, 25, 38, 0.85);
        border-color: rgba(120, 130, 160, 0.25);
        color: rgba(230, 235, 245, 0.95);
        width: 180px;
      "
    />
    <button
      type="button"
      class="h-8 px-2.5 rounded-md text-[11px] border transition-colors"
      style="
        background: {showLabels ? 'rgba(139, 126, 200, 0.25)' : 'rgba(22, 25, 38, 0.85)'};
        border-color: rgba(120, 130, 160, 0.25);
        color: rgba(220, 225, 240, 0.9);
      "
      onclick={() => (showLabels = !showLabels)}
    >
      Labels
    </button>
    <button
      type="button"
      class="h-8 px-2.5 rounded-md text-[11px] border transition-colors"
      style="
        background: {localGraph ? 'rgba(139, 126, 200, 0.25)' : 'rgba(22, 25, 38, 0.85)'};
        border-color: rgba(120, 130, 160, 0.25);
        color: rgba(220, 225, 240, 0.9);
      "
      onclick={() => {
        localGraph = !localGraph;
        if (!localGraph) selectedNodeId = null;
      }}
    >
      Local
    </button>
    <button
      type="button"
      class="h-8 px-2.5 rounded-md text-[11px] border transition-colors hover:bg-white/5"
      style="background: rgba(22, 25, 38, 0.85); border-color: rgba(120, 130, 160, 0.25); color: rgba(220, 225, 240, 0.9);"
      onclick={resetView}
    >
      Reset view
    </button>
  </div>

  <div
    class="absolute top-3 right-3 z-10 flex items-center gap-2 text-[11px]"
    style="color: rgba(180, 190, 210, 0.75);"
  >
    <span>{stats.notes} notes · {stats.links} links</span>
    <button
      type="button"
      class="px-2.5 py-1 rounded-md border transition-colors hover:bg-white/5"
      style="border-color: rgba(120, 130, 160, 0.25);"
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
    onpointerleave={() => { tooltipVisible = false; }}
    onwheel={onWheel}
  ></canvas>

  {#if tooltipVisible}
    <div
      class="pointer-events-none absolute z-20 rounded-md border px-3 py-2 text-xs shadow-xl backdrop-blur-sm"
      style="
        left: {tooltipX}px;
        top: {tooltipY}px;
        background: rgba(22, 25, 38, 0.92);
        border-color: rgba(139, 126, 200, 0.35);
        color: rgba(230, 235, 245, 0.95);
        max-width: 260px;
      "
    >
      <div class="font-semibold truncate">{tooltipTitle}</div>
      <div style="color: rgba(160, 170, 190, 0.85);">{tooltipMeta}</div>
    </div>
  {/if}

  {#if legendEntries.length > 0}
    <div
      class="absolute bottom-4 left-4 z-10 rounded-md border p-3 max-w-[220px] backdrop-blur-sm"
      style="
        background: rgba(22, 25, 38, 0.88);
        border-color: rgba(120, 130, 160, 0.2);
      "
    >
      <div
        class="text-[10px] font-semibold uppercase tracking-widest mb-2"
        style="color: rgba(160, 170, 190, 0.7);"
      >
        Vault folders
      </div>
      <div class="space-y-1.5">
        {#each legendEntries as entry (entry.folder)}
          <div class="flex items-center gap-2">
            <div
              class="rounded-full shrink-0"
              style="width: 9px; height: 9px; background: {entry.color}; box-shadow: 0 0 6px {entry.color}55;"
            ></div>
            <span class="text-[11px] truncate" style="color: rgba(200, 210, 225, 0.85);">
              {entry.folder === '/' ? 'Root' : entry.folder.split('/').pop() || entry.folder}
            </span>
          </div>
        {/each}
      </div>
      <div class="mt-2 pt-2 border-t text-[10px]" style="border-color: rgba(120,130,160,0.15); color: rgba(150,160,180,0.7);">
        Gold ring = pinned in agent context · scroll to zoom, drag to pan
      </div>
    </div>
  {/if}

  {#if notesStore.graphData.nodes.length === 0 && !notesStore.isLoading}
    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <div class="text-center" style="color: rgba(160, 170, 190, 0.6);">
        <div class="text-4xl mb-3 opacity-40">◎</div>
        <div class="text-sm font-medium">Empty vault</div>
        <div class="text-xs mt-1 opacity-70">Create notes or ask an agent to build your network</div>
      </div>
    </div>
  {/if}
</div>
