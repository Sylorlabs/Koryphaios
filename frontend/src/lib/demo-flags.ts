// Demo variant detection. Kept dependency-free so both the API layer and the
// demo seeding module can import it without creating store import cycles.
//
//   ?demo=1     → 'guided' — a scripted example user doing work on a loop.
//   ?demo=full  → 'full'   — the real Koryphaios UI, fully interactive, backed
//                            by an in-memory shim. Nothing is persisted.
//   (no param)  → 'off'

import { browser } from '$app/environment';

export type DemoVariant = 'off' | 'guided' | 'full';

function detectVariant(): DemoVariant {
  if (!browser) return 'off';
  const param = new URLSearchParams(location.search).get('demo');
  if (param === 'full') return 'full';
  if (param !== null) return 'guided';
  if (location.hash.includes('demo=full')) return 'full';
  if (location.hash.includes('demo')) return 'guided';
  return 'off';
}

export const demoVariant: DemoVariant = detectVariant();
export const isDemoMode = demoVariant !== 'off';
export const isGuidedDemo = demoVariant === 'guided';
export const isFullDemo = demoVariant === 'full';
