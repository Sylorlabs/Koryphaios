import { browser } from '$app/environment';

const KEY = 'koryphaios-goal-display';
// Goal Mode lives above the chat. `composer` is the only surface, so a goal
// opened from anywhere (slash command, palette, a chat's goal chip) always has
// somewhere to render.
type GoalDisplay = { composer: boolean };
const fallback: GoalDisplay = { composer: true };
function load(): GoalDisplay {
  if (!browser) return fallback;
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch (err: unknown) {
    console.debug(
      'Failed to load goal display settings:',
      err instanceof Error ? err.message : String(err),
    );
    return fallback;
  }
}
let display = $state<GoalDisplay>(load());
function update(patch: Partial<GoalDisplay>) {
  display = { ...display, ...patch };
  if (browser) localStorage.setItem(KEY, JSON.stringify(display));
}
export const goalDisplayStore = {
  get composer() {
    return display.composer;
  },
  update,
};
