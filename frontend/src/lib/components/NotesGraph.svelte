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
  let tooltipEl = $state<HTMLDivElement | undefined>(undefined);
  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipTitle = $state('');
  let tooltipLinkCount = $state(0);

  // 12-color palette for folder paths
  const FOLDER_COLORS = [
    '#d5b261', '#6b8cde', '#5ec27a', '#e86b6b', '#c47fd0',
    '#62bfcf', '#e8a85a', '#8fbf6b', '#b87fe0', '#e87fa8',
    '#5ab8e8', '#e8c95a',
  ] as const;

  const folderColorMap = new Map<string, string>();
  let colorIndex = 0;

  function getFolderColor(folderPath: string): string {
    if (!folderColorMap.has(folderPath)) {
      folderColorMap.set(
        folderPath,
        FOLDER_COLORS[colorIndex % FOLDER_COLORS.length]
      );
      colorIndex++;
    }
    return folderColorMap.get(folderPath)!;
  }

  function getNodeRadius(linkCount: number): number {
    return Math.min(5 + linkCount * 1.5, 25);
  }

  function buildGraph() {
    if (!svgEl || !containerEl) return;

    // Clear previous content
    d3.select(svgEl).selectAll('*').remove();
    folderColorMap.clear();
    colorIndex = 0;

    const { nodes, edges } = notesStore.graphData;
    if (!nodes.length) return;

    const settings = notesStore.settings;
    const { chargeStrength, linkDistance, gravity } = settings.graphPhysics;

    const width = containerEl.clientWidth || 800;
    const height = containerEl.clientHeight || 600;

    const svg = d3.select(svgEl)
      .attr('width', width)
      .attr('height', height);

    // Zoom layer
    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Build simulation nodes (copy to avoid mutating store)
    type SimNode = d3.SimulationNodeDatum & GraphNode & { x: number; y: number; vx: number; vy: number };
    const simNodes: SimNode[] = nodes.map((n) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * 200,
      y: height / 2 + (Math.random() - 0.5) * 200,
      vx: 0,
      vy: 0,
    }));

    const idToIndex = new Map(simNodes.map((n, i) => [n.id, i]));

    type SimLink = d3.SimulationLinkDatum<SimNode> & { source: SimNode; target: SimNode };
    const simLinks: SimLink[] = edges
      .filter((e: GraphEdge) => idToIndex.has(e.from) && idToIndex.has(e.to))
      .map((e: GraphEdge) => ({
        source: simNodes[idToIndex.get(e.from)!],
        target: simNodes[idToIndex.get(e.to)!],
      })) as SimLink[];

    // Draw edges
    const linkSel = g.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(simLinks)
      .enter()
      .append('line')
      .attr('stroke', 'rgba(255,255,255,0.12)')
      .attr('stroke-width', 1);

    // Draw nodes
    const nodeSel = g.append('g')
      .attr('class', 'nodes')
      .selectAll('circle')
      .data(simNodes)
      .enter()
      .append('circle')
      .attr('r', (d) => getNodeRadius(d.linkCount))
      .attr('fill', (d) => getFolderColor(d.folderPath))
      .attr('stroke', 'rgba(0,0,0,0.4)')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseover', function (event: MouseEvent, d: SimNode) {
        d3.select(this)
          .attr('stroke', '#fff')
          .attr('stroke-width', 2.5);

        tooltipTitle = d.title;
        tooltipLinkCount = d.linkCount;

        const containerRect = containerEl!.getBoundingClientRect();
        tooltipX = event.clientX - containerRect.left + 12;
        tooltipY = event.clientY - containerRect.top - 10;
        tooltipVisible = true;
      })
      .on('mousemove', function (event: MouseEvent) {
        const containerRect = containerEl!.getBoundingClientRect();
        tooltipX = event.clientX - containerRect.left + 12;
        tooltipY = event.clientY - containerRect.top - 10;
      })
      .on('mouseout', function () {
        d3.select(this)
          .attr('stroke', 'rgba(0,0,0,0.4)')
          .attr('stroke-width', 1.5);
        tooltipVisible = false;
      })
      .on('click', (_event: MouseEvent, d: SimNode) => {
        onNodeClick(d.id);
      })
      .call(
        d3.drag<SVGCircleElement, SimNode>()
          .on('start', function (event, d) {
            if (!event.active) simulation?.alphaTarget(0.3).restart();
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
          })
      );

    // Labels for high-link-count nodes
    const labelSel = g.append('g')
      .attr('class', 'labels')
      .selectAll('text')
      .data(simNodes.filter((n) => n.linkCount >= 2))
      .enter()
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => -(getNodeRadius(d.linkCount) + 4))
      .attr('font-size', '10px')
      .attr('fill', 'rgba(255,255,255,0.65)')
      .attr('pointer-events', 'none')
      .text((d) => d.title.length > 20 ? d.title.slice(0, 18) + '…' : d.title);

    // Build and start simulation
    simulation = d3.forceSimulation(simNodes)
      .force('charge', d3.forceManyBody().strength(chargeStrength))
      .force(
        'link',
        d3.forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(linkDistance)
      )
      .force('center', d3.forceCenter(width / 2, height / 2).strength(Math.abs(gravity) / 500))
      .force('collide', d3.forceCollide<SimNode>().radius((d) => getNodeRadius(d.linkCount) + 3))
      .on('tick', () => {
        linkSel
          .attr('x1', (d) => (d.source as SimNode).x)
          .attr('y1', (d) => (d.source as SimNode).y)
          .attr('x2', (d) => (d.target as SimNode).x)
          .attr('y2', (d) => (d.target as SimNode).y);

        nodeSel
          .attr('cx', (d) => d.x)
          .attr('cy', (d) => d.y);

        labelSel
          .attr('x', (d) => (d as SimNode).x)
          .attr('y', (d) => (d as SimNode).y);
      });
  }

  // Highlight searched nodes
  $effect(() => {
    if (!svgEl) return;
    const q = searchQuery.trim().toLowerCase();
    d3.select(svgEl)
      .selectAll<SVGCircleElement, d3.SimulationNodeDatum & GraphNode>('circle')
      .attr('opacity', (d) => {
        if (!q) return 1;
        return d.title.toLowerCase().includes(q) ? 1 : 0.2;
      });
  });

  // Rebuild graph when graph data changes
  $effect(() => {
    const _data = notesStore.graphData;
    // Rebuild after a tick to ensure SVG is mounted
    requestAnimationFrame(() => buildGraph());
  });

  onMount(() => {
    void notesStore.fetchGraph().then(() => buildGraph());
  });

  onDestroy(() => {
    simulation?.stop();
  });

  // Collect unique folders for legend
  let legendEntries = $derived.by(() => {
    const seen = new Set<string>();
    const entries: { folder: string; color: string }[] = [];
    for (const n of notesStore.graphData.nodes) {
      if (!seen.has(n.folderPath)) {
        seen.add(n.folderPath);
        entries.push({ folder: n.folderPath, color: getFolderColor(n.folderPath) });
      }
    }
    return entries.slice(0, 12);
  });
</script>

<div
  bind:this={containerEl}
  class="relative w-full h-full"
  style="background: var(--color-surface-0);"
>
  <!-- Search bar -->
  <div class="absolute top-3 left-3 z-10">
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="Search graph..."
      class="h-8 rounded-lg border px-3 text-xs"
      style="
        background: var(--color-surface-2);
        border-color: var(--color-border);
        color: var(--color-text-primary);
        width: 200px;
      "
    />
  </div>

  <!-- Refresh button -->
  <button
    type="button"
    class="absolute top-3 right-3 z-10 px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[var(--color-surface-3)]"
    style="
      background: var(--color-surface-2);
      border-color: var(--color-border);
      color: var(--color-text-secondary);
    "
    onclick={() => {
      simulation?.stop();
      void notesStore.fetchGraph().then(() => buildGraph());
    }}
  >
    Refresh
  </button>

  <!-- SVG canvas -->
  <svg
    bind:this={svgEl}
    class="w-full h-full"
    style="display: block;"
  ></svg>

  <!-- Tooltip -->
  {#if tooltipVisible}
    <div
      bind:this={tooltipEl}
      class="pointer-events-none absolute z-20 rounded-lg border px-3 py-2 text-xs shadow-lg"
      style="
        left: {tooltipX}px;
        top: {tooltipY}px;
        background: var(--color-surface-2);
        border-color: var(--color-border);
        color: var(--color-text-primary);
        max-width: 240px;
      "
    >
      <div class="font-semibold truncate">{tooltipTitle}</div>
      <div style="color: var(--color-text-muted);">{tooltipLinkCount} link{tooltipLinkCount !== 1 ? 's' : ''}</div>
    </div>
  {/if}

  <!-- Legend -->
  {#if legendEntries.length > 0}
    <div
      class="absolute bottom-4 left-4 z-10 rounded-lg border p-3 max-w-[200px]"
      style="
        background: var(--color-surface-2);
        border-color: var(--color-border);
      "
    >
      <div class="text-[10px] font-semibold uppercase tracking-widest mb-2" style="color: var(--color-text-muted);">Folders</div>
      <div class="space-y-1">
        {#each legendEntries as entry (entry.folder)}
          <div class="flex items-center gap-2">
            <div
              class="rounded-full shrink-0"
              style="width: 8px; height: 8px; background: {entry.color};"
            ></div>
            <span class="text-[11px] truncate" style="color: var(--color-text-secondary);">
              {entry.folder === '/' ? 'Root' : entry.folder.split('/').pop() || entry.folder}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Empty state -->
  {#if notesStore.graphData.nodes.length === 0 && !notesStore.isLoading}
    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
      <div class="text-center" style="color: var(--color-text-muted);">
        <div class="text-4xl mb-3 opacity-30">◎</div>
        <div class="text-sm font-medium">No notes yet</div>
        <div class="text-xs mt-1 opacity-60">Create notes to see the graph</div>
      </div>
    </div>
  {/if}
</div>
