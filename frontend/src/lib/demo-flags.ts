// Demo variant detection. Kept dependency-free so both the API layer and the
// demo seeding module can import it without creating store import cycles.
//
//   ?demo=*     → 'guided' — a read-only scripted example on a self-healing loop.
//   (no param)  → 'off'

import { browser } from '$app/environment';

export type DemoVariant = 'off' | 'guided';

function detectVariant(): DemoVariant {
  if (!browser) return 'off';
  const param = new URLSearchParams(location.search).get('demo');
  if (param !== null) return 'guided';
  if (location.hash.includes('demo')) return 'guided';
  return 'off';
}

export const demoVariant: DemoVariant = detectVariant();
export const isDemoMode = demoVariant !== 'off';
export const isGuidedDemo = demoVariant === 'guided';
