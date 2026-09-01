import type { GraphEdge, GraphNode } from '@koryphaios/shared';

export const GRAPH_AUTO_FOCUS_THRESHOLD = 400;
export const GRAPH_STATIC_LAYOUT_THRESHOLD = 800;

export function stableGraphHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function graphNeighborIds(nodeId: string | null, edges: GraphEdge[]): Set<string> {
  if (!nodeId) return new Set();
  const neighbors = new Set<string>([nodeId]);
  for (const edge of edges) {
    if (edge.from === nodeId) neighbors.add(edge.to);
    if (edge.to === nodeId) neighbors.add(edge.from);
  }
  return neighbors;
}

/** Hover is informational; only an intentional selection may isolate the graph. */
export function shouldDimGraphNode(
  nodeId: string,
  selectedNodeId: string | null,
  hoveredNodeId: string | null,
  selectedNeighbors: ReadonlySet<string>,
  searchActive: boolean,
  matchesSearch: boolean,
): boolean {
  if (!selectedNodeId) return searchActive && !matchesSearch;
  if (searchActive) {
    return !matchesSearch && !selectedNeighbors.has(nodeId) && nodeId !== hoveredNodeId;
  }
  return !selectedNeighbors.has(nodeId) && nodeId !== hoveredNodeId;
}

export function selectGraphView(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: { showAllNodes: boolean; localGraph: boolean; selectedNodeId: string | null },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (options.localGraph && options.selectedNodeId) {
    const keep = graphNeighborIds(options.selectedNodeId, edges);
    const filteredNodes = nodes.filter((node) => keep.has(node.id));
    const ids = new Set(filteredNodes.map((node) => node.id));
    const filteredEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return { nodes: filteredNodes, edges: filteredEdges };
  }

  if (!options.showAllNodes && nodes.length > GRAPH_AUTO_FOCUS_THRESHOLD && edges.length > 0) {
    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    const filteredNodes = nodes.filter(
      (node) => connected.has(node.id) || node.includeInContext,
    );
    return { nodes: filteredNodes, edges };
  }

  return { nodes, edges };
}
