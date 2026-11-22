import { NOTE_TOOL_DEFINITIONS } from '@koryphaios/shared';

/**
 * A bouncer, not a killer.
 *
 * The owner's Mac is not an agent playground, and one name in particular keeps
 * arriving: an agent asked to build a "settings window" leaves an app bundle, a
 * window title, a Dock entry or a scratch file called *Native Settings* behind.
 * Removing it afterwards is the wrong end of the problem — by then the thing has
 * already been let in, and something always survives the sweep (a window still
 * on screen, a registration in LaunchServices, a file outside the scanned tree).
 *
 * So the name is refused at the door: every tool call is screened before it
 * runs, and a call that would create, write, move, launch or drive anything
 * carrying the name is rejected with a reason the agent can read and retry
 * from. Nothing reaches the filesystem or the process table.
 *
 * The pattern is a name, deliberately, exactly like
 * `security/owner-display-guard.ts`: it matches whatever the thing calls itself,
 * so it catches a file, an `.app`, a window title, a shell command, or a bundle
 * id without knowing which one it is.
 */
export const BANNED_INPUT_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [{ label: 'Native Settings', pattern: /native[\s._-]*settings/iu }] as const;

export const BANNED_NAME_REASON =
  'The name "Native Settings" is banned on this machine. Do not create, write, move, launch, or drive anything with that name — no file, folder, app bundle, window title, Dock entry or scratch artifact. Choose a different name and retry.';

/** The banned name found in `text`, or null. Case-insensitive, any separator. */
export function bannedNameIn(text: string): string | null {
  for (const entry of BANNED_INPUT_PATTERNS) {
    if (entry.pattern.test(text)) return entry.label;
  }
  return null;
}

/** Refusal reason for a label, or null when the label is allowed. */
export function bannedNameRefusal(label: string): string | null {
  return bannedNameIn(label) === null ? null : BANNED_NAME_REASON;
}

/** Every string reachable from a tool input, bounded so a huge payload cannot wedge a turn. */
function inputStrings(value: unknown, depth = 0, budget = { chars: 200_000 }): string[] {
  if (depth > 8 || budget.chars <= 0) return [];
  if (typeof value === 'string') {
    budget.chars -= value.length;
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => inputStrings(entry, depth + 1, budget));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      key,
      ...inputStrings(entry, depth + 1, budget),
    ]);
  }
  return [];
}

export interface ScreenedCall {
  name: string;
  input: unknown;
}

/**
 * Tools that only observe state that already exists. They are exempt because the
 * repository legitimately holds the token (`native-settings-controls.test.ts`),
 * so reading it must stay possible. `READ_ONLY_TOOLS` is deliberately not reused:
 * it also lists window-driving tools such as `computer_place_window`, and driving
 * a window titled "Native Settings" is exactly what this bouncer exists to stop.
 */
const OBSERVATION_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'ls',
  'diff',
  'view_image',
  'web_search',
  'web_fetch',
  'git_inspect',
  'computer_status',
  'computer_list_apps',
  'computer_list_elements',
  'computer_observe',
  'computer_wait',
  'list_mcp_tools',
  'list_linked_devices',
  'load_skill_detail',
  'fetch_context',
  'get_resource_budget',
  ...NOTE_TOOL_DEFINITIONS.filter((tool) => tool.category === 'read').map((tool) => tool.name),
]);

/**
 * Decide whether a tool call may enter. Observation-only tools are never
 * screened; everything else is checked against the full serialized input.
 */
export function screenToolCall(call: ScreenedCall): { reason: string } | null {
  if (OBSERVATION_TOOLS.has(call.name)) return null;
  for (const text of inputStrings(call.input)) {
    if (bannedNameIn(text) !== null) return { reason: BANNED_NAME_REASON };
  }
  return null;
}
