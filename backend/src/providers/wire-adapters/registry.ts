// Ordered registry of wire adapters. Detection consults it after the three
// SDK shape classifiers miss; the CustomProvider constructor resolves an
// explicitly pinned adapter id here.

import { cohereAdapter } from './cohere';
import { ollamaAdapter } from './ollama';
import type { WireAdapter } from './types';

const ADAPTERS: WireAdapter[] = [ollamaAdapter, cohereAdapter];

/** All registered adapters, in detection-priority order. */
export function listWireAdapters(): readonly WireAdapter[] {
  return ADAPTERS;
}

export function getWireAdapter(id: string): WireAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}
