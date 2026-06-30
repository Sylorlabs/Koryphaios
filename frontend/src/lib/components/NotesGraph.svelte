<script lang="ts">
  import * as d3 from 'd3';
  import { onMount, onDestroy } from 'svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import type { GraphNode, GraphEdge } from '@koryphaios/shared';

  interface Props {
    onNodeClick: (noteId: string) => void;
  }

  let { onNodeClick }: Props = $props();

  let svgEl = $state<SVGSVGElement | undefined>(undefined);
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

  type SimLink = d3.SimulationLinkDatum<SimNode> & {
    source: SimNode;
    target: SimNode;
    key: string;
  };

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

  function getVisibleGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const { nodes, edges } = notesStore.graphData;
    if (!localGraph || !selectedNodeId) return { nodes, edges };

    const keep = getNeighborSet(selectedNodeId, edges);
    const filteredNodes = nodes.filter((n) => keep.has(n.id));
    const ids = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes: filteredNodes, edges: filteredEdges };
  }

  function linkPath(d: SimLink): string {
    const sx = (d.source as SimNode).x;
    const sy = (d.source as SimNode).y;
    const tx = (d.target as SimNode).x;
    const ty = (d.target as SimNode).y;
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const curvature = Math.min(36, dist * 0.15);
    const cx = mx + (-dy / dist) * curvature;
    const cy = my + (dx / dist) * curvature;
    return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
  }

  function buildGraph() {
    if (!svgEl || !containerEl) return;

    d3.select(svgEl).selectAll('*').remove();
    folderColorMap.clear();
    colorIndex = 0;
    simulation?.stop();

    const { nodes, edges } = getVisibleGraph();
    if (!nodes.length) return;

    const settings = notesStore.settings;
    const { chargeStrength, linkDistance, gravity } = settings.graphPhysics;

    const width = containerEl.clientWidth || 800;
    const height = containerEl.clientHeight || 600;

    const svg = d3
      .select(svgEl)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    const defs = svg.append('defs');

    const glowFilter = defs
      .append('filter')
      .attr('id', 'node-glow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '2.5').attr('result', 'blur');
    const merge = glowFilter.append('feMerge');
    merge.append('feMergeNode').attr('in', 'blur');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');

    const g = svg.append('g');

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    svg.call(zoom);

    const simNodes: SimNode[] = nodes.map((n) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * width * 0.35,
      y: height / 2 + (Math.random() - 0.5) * height * 0.35,
      vx: 0,
      vy: 0,
    }));

    const nodeById = new Map(simNodes.map((n) => [n.id, n]));

    const simLinks: SimLink[] = edges
      .filter((e) => nodeById.has(e.from) && nodeById.has(e.to))
      .map((e) => ({
        source: nodeById.get(e.from)!,
        target: nodeById.get(e.to)!,
        key: `${e.from}->${e.to}`,
      }));

    const focusId = hoveredNodeId ?? selectedNodeId;
    const focusNeighbors = getNeighborSet(focusId, edges);

    const linkSel = g
      .append('g')
      .attr('class', 'links')
      .selectAll('path')
      .data(simLinks, (d) => (d as SimLink).key)
      .enter()
      .append('path')
      .attr('fill', 'none')
      .attr('stroke', (d) => {
        const active =
          focusId &&
          ((d.source as SimNode).id === focusId || (d.target as SimNode).id === focusId);
        return active ? 'rgba(139, 126, 200, 0.75)' : 'rgba(120, 130, 160, 0.22)';
      })
      .attr('stroke-width', (d) => {
        const active =
          focusId &&
          ((d.source as SimNode).id === focusId || (d.target as SimNode).id === focusId);
        return active ? 1.8 : 1;
      });

    const nodeSel = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(simNodes, (d) => (d as SimNode).id)
      .enter()
      .append('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')
      .on('mouseover', function (event: MouseEvent, d: SimNode) {
        hoveredNodeId = d.id;
        updateFocusStyles();
        tooltipTitle = d.title;
        tooltipMeta = `${d.linkCount} links · ${d.folderPath}`;
        const rect = containerEl!.getBoundingClientRect();
        tooltipX = event.clientX - rect.left + 14;
        tooltipY = event.clientY - rect.top - 12;
        tooltipVisible = true;
      })
      .on('mousemove', function (event: MouseEvent) {
        const rect = containerEl!.getBoundingClientRect();
        tooltipX = event.clientX - rect.left + 14;
        tooltipY = event.clientY - rect.top - 12;
      })
      .on('mouseout', function () {
        hoveredNodeId = null;
        updateFocusStyles();
        tooltipVisible = false;
      })
      .on('click', (_event: MouseEvent, d: SimNode) => {
        selectedNodeId = selectedNodeId === d.id ? null : d.id;
        if (localGraph) buildGraph();
        onNodeClick(d.id);
      })
      .call(
        d3
          .drag<SVGGElement, SimNode>()
          .on('start', function (event, d) {
            if (!event.active) simulation?.alphaTarget(0.25).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', function (event, d) {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', function (event, d) {
            if (!event.active) simulation?.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );

    nodeSel
      .append('circle')
      .attr('class', 'node-halo')
      .attr('r', (d) => getNodeRadius(d.linkCount, d.includeInContext) + 5)
      .attr('fill', (d) => getFolderColor(d.folderPath))
      .attr('opacity', 0.18);

    nodeSel
      .append('circle')
      .attr('class', 'node-core')
      .attr('r', (d) => getNodeRadius(d.linkCount, d.includeInContext))
      .attr('fill', (d) => getFolderColor(d.folderPath))
      .attr('stroke', (d) =>
        d.includeInContext ? 'rgba(255, 220, 140, 0.9)' : 'rgba(255, 255, 255, 0.15)',
      )
      .attr('stroke-width', (d) => (d.includeInContext ? 2 : 1.2))
      .attr('filter', 'url(#node-glow)');

    const labelSel = g
      .append('g')
      .attr('class', 'labels')
      .selectAll('text')
      .data(simNodes, (d) => (d as SimNode).id)
      .enter()
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => getNodeRadius(d.linkCount, d.includeInContext) + 12)
      .attr('font-size', '9.5px')
      .attr('font-weight', (d) => (d.linkCount >= 3 ? '600' : '400'))
      .attr('fill', 'rgba(220, 225, 240, 0.82)')
      .attr('pointer-events', 'none')
      .text((d) => (d.title.length > 24 ? d.title.slice(0, 22) + '…' : d.title));

    function updateFocusStyles() {
      const activeId = hoveredNodeId ?? selectedNodeId;
      const neighbors = getNeighborSet(activeId, edges);

      nodeSel.attr('opacity', (d) => {
        if (!activeId) return 1;
        return neighbors.has(d.id) ? 1 : 0.15;
      });

      linkSel
        .attr('stroke', (d) => {
          const lit =
            activeId &&
            ((d.source as SimNode).id === activeId || (d.target as SimNode).id === activeId);
          return lit ? 'rgba(139, 126, 200, 0.85)' : 'rgba(120, 130, 160, 0.12)';
        })
        .attr('stroke-width', (d) => {
          const lit =
            activeId &&
            ((d.source as SimNode).id === activeId || (d.target as SimNode).id === activeId);
          return lit ? 2 : 0.8;
        });

      nodeSel.select('.node-core').attr('stroke-width', (d) => {
        if (d.id === activeId) return 2.5;
        if (d.includeInContext) return 2;
        return 1.2;
      });
    }

    simulation = d3
      .forceSimulation(simNodes)
      .force('charge', d3.forceManyBody().strength(chargeStrength).distanceMax(280))
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
      .force(
        'collide',
        d3.forceCollide<SimNode>().radius(
          (d) => getNodeRadius(d.linkCount, d.includeInContext) + 10,
        ),
      )
      .velocityDecay(0.35)
      .on('tick', () => {
        linkSel.attr('d', linkPath);
        nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
        labelSel
          .attr('x', (d) => d.x)
          .attr('y', (d) => d.y)
          .attr('opacity', showLabels ? 1 : 0);
      });

    updateFocusStyles();
  }

  $effect(() => {
    if (!svgEl) return;
    const q = searchQuery.trim().toLowerCase();
    d3.select(svgEl)
      .selectAll<SVGCircleElement, SimNode>('.node-core')
      .attr('opacity', (d) => {
        if (!q) return 1;
        return d.title.toLowerCase().includes(q) ? 1 : 0.12;
      });
    d3.select(svgEl)
      .selectAll<SVGTextElement, SimNode>('text')
      .attr('opacity', (d) => {
        if (!showLabels) return 0;
        if (!q) return 0.9;
        return d.title.toLowerCase().includes(q) ? 1 : 0.15;
      });
  });

  $effect(() => {
    const _data = notesStore.graphData;
    const _local = localGraph;
    const _selected = selectedNodeId;
    requestAnimationFrame(() => buildGraph());
  });

  onMount(() => {
    void notesStore.fetchGraph().then(() => buildGraph());
  });

  onDestroy(() => {
    simulation?.stop();
  });

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
    return {
      notes: g.nodes.length,
      links: g.edges.length,
    };
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

  <svg bind:this={svgEl} class="w-full h-full" style="display: block;"></svg>

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
        Gold ring = pinned in agent context
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