import { browser } from '$app/environment';

const KEY = 'koryphaios-goal-display';
type GoalDisplay = { sidebar: boolean; composer: boolean };
// Goals should be available without permanently claiming sidebar real estate.
const fallback: GoalDisplay = { sidebar: false, composer: true };
function load(): GoalDisplay {
  if (!browser) return fallback;
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return fallback; }
}
let display = $state<GoalDisplay>(load());
function update(patch: Partial<GoalDisplay>) { display = { ...display, ...patch }; if (browser) localStorage.setItem(KEY, JSON.stringify(display)); }
export const goalDisplayStore = { get sidebar() { return display.sidebar; }, get composer() { return display.composer; }, update };
