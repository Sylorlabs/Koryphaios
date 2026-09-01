import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@koryphaios/shared';
import {
  GRAPH_AUTO_FOCUS_THRESHOLD,
  selectGraphView,
  shouldDimGraphNode,
  stableGraphHash,
} from './note-graph-view';

function node(id: string, includeInContext = false): GraphNode {
  return {
    id,
    title: id,
    folderPath: '/',
    tags: [],
    linkCount: 0,
    includeInContext,
  };
}

describe('large note graph views', () => {
  it('defaults large vaults to connected and explicitly contextual notes', () => {
    const nodes = Array.from({ length: GRAPH_AUTO_FOCUS_THRESHOLD + 1 }, (_, index) =>
      node(`note-${index}`, index === 400),
    );
    const edges: GraphEdge[] = [{ from: 'note-0', to: 'note-1' }];

    const view = selectGraphView(nodes, edges, {
      showAllNodes: false,
      localGraph: false,
      selectedNodeId: null,
    });

    expect(view.nodes.map(({ id }) => id)).toEqual(['note-0', 'note-1', 'note-400']);
    expect(view.edges).toEqual(edges);
  });

  it('keeps small vaults complete and lets users reveal every large-vault note', () => {
    const smallNodes = [node('a'), node('b'), node('isolated')];
    const edges: GraphEdge[] = [{ from: 'a', to: 'b' }];
    expect(
      selectGraphView(smallNodes, edges, {
        showAllNodes: false,
        localGraph: false,
        selectedNodeId: null,
      }).nodes,
    ).toHaveLength(3);

    const largeNodes = Array.from({ length: GRAPH_AUTO_FOCUS_THRESHOLD + 1 }, (_, index) =>
      node(`note-${index}`),
    );
    expect(
      selectGraphView(largeNodes, edges, {
        showAllNodes: true,
        localGraph: false,
        selectedNodeId: null,
      }).nodes,
    ).toHaveLength(largeNodes.length);
  });

  it('reduces local mode to the selected note and its direct neighbors', () => {
    const nodes = [node('a'), node('b'), node('c'), node('isolated')];
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];

    const view = selectGraphView(nodes, edges, {
      showAllNodes: true,
      localGraph: true,
      selectedNodeId: 'b',
    });

    expect(view.nodes.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(view.edges).toEqual(edges);
  });

  it('uses stable hashes so refreshes keep colors and initial positions stable', () => {
    expect(stableGraphHash('/docs')).toBe(stableGraphHash('/docs'));
    expect(stableGraphHash('/docs')).not.toBe(stableGraphHash('/rules'));
  });

  it('never dims the graph for hover alone', () => {
    expect(shouldDimGraphNode('a', null, null, new Set(), false, false)).toBe(false);
    expect(shouldDimGraphNode('a', null, 'b', new Set(), false, false)).toBe(false);
    expect(shouldDimGraphNode('b', null, 'b', new Set(), false, false)).toBe(false);
  });

  it('reserves isolation for selection while keeping the hovered node readable', () => {
    const selectedNeighbors = new Set(['selected', 'neighbor']);
    expect(shouldDimGraphNode('neighbor', 'selected', null, selectedNeighbors, false, false)).toBe(false);
    expect(shouldDimGraphNode('outside', 'selected', null, selectedNeighbors, false, false)).toBe(true);
    expect(shouldDimGraphNode('outside', 'selected', 'outside', selectedNeighbors, false, false)).toBe(false);
    expect(shouldDimGraphNode('outside', 'selected', null, selectedNeighbors, true, false)).toBe(true);
    expect(shouldDimGraphNode('outside', 'selected', null, selectedNeighbors, true, true)).toBe(false);
    expect(shouldDimGraphNode('neighbor', 'selected', null, selectedNeighbors, true, false)).toBe(false);
    expect(shouldDimGraphNode('outside', 'selected', null, selectedNeighbors, true, false)).toBe(true);
  });

  it('does not dim by default when no search is active', () => {
    expect(shouldDimGraphNode('a', null, null, new Set(), false, true)).toBe(false);
    expect(shouldDimGraphNode('b', null, null, new Set(), false, true)).toBe(false);
  });
});
