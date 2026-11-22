/**
 * Who actually enforces the chat's permission mode for a provider's tool calls.
 *
 * The composer shows this next to the permission picker so a chosen mode is
 * never a silent promise: "Ask" means Kory asks only where Kory is in the path.
 *
 * Keep this table conservative. A provider is listed as enforced only when the
 * mechanism is recorded as verified in AGENTS.md / the adapter source; anything
 * unknown is "unverified", never "enforced". A wrong "enforced" claim is a
 * trust bug, a wrong "unverified" claim is merely cautious.
 */

export type PermissionEnforcementLevel = 'kory' | 'kory-hooks' | 'native' | 'unverified';

export interface PermissionEnforcement {
  level: PermissionEnforcementLevel;
  /** Short label for the badge, e.g. "Enforced by Kory". */
  label: string;
  /** One sentence explaining the mechanism for this provider. */
  detail: string;
}

/** CLI harnesses whose real actions all cross Kory's tool boundary. */
const KORY_BOUNDARY: Record<string, string> = {
  codex: 'Codex runs its own tools read-only; edits and commands go through Kory tools.',
  opencode: 'OpenCode native edits and commands are rejected; work goes through Kory tools.',
  antigravity: 'Antigravity native writes and commands are denied; work goes through Kory tools.',
  omnirush: 'Omnirush native tools are disabled; every action is a Kory tool call.',
  freebuff:
    'Freebuff native tools only touch a disposable sandbox; the real workspace is reached through Kory tools.',
  codebuff: 'Codebuff filesystem and command tools are overridden by Kory tools.',
};

/** CLI harnesses whose native tools are checked by Kory hooks before running. */
const KORY_HOOKS: Record<string, string> = {
  claude: "Claude Code's native tools are checked by a Kory hook before they run.",
  devin: "Devin's native tools are checked by a Kory hook before they run.",
};

/** CLI harnesses whose native tools run under the CLI's own policy. */
const NATIVE: Record<string, string> = {
  codebuddy: "CodeBuddy's native edit and write tools are pre-approved and run without Kory's check.",
  cursor: "Cursor runs with --trust; its native tools are not checked by Kory.",
  grok: "Grok's built-in tools stay enabled and are not checked by Kory.",
  'gemini-cli': 'Gemini CLI cannot call Kory tools; its own tools follow its own policy.',
};

/** CLI harness ids, so an unknown one is reported as unverified, not enforced. */
const KNOWN_CLI_HARNESSES = new Set([
  ...Object.keys(KORY_BOUNDARY),
  ...Object.keys(KORY_HOOKS),
  ...Object.keys(NATIVE),
  'kimicode',
]);

export function providerPermissionEnforcement(
  provider: string | null | undefined,
  displayName?: string,
): PermissionEnforcement {
  const name = String(provider ?? '');
  const label = displayName || name || 'This provider';
  if (KORY_BOUNDARY[name]) {
    return { level: 'kory', label: 'Enforced by Kory', detail: KORY_BOUNDARY[name] };
  }
  if (KORY_HOOKS[name]) {
    return { level: 'kory-hooks', label: 'Enforced by Kory hooks', detail: KORY_HOOKS[name] };
  }
  if (NATIVE[name]) {
    return {
      level: 'native',
      label: 'Not enforced by Kory',
      detail: `${NATIVE[name]} This mode applies to Kory tools only.`,
    };
  }
  if (KNOWN_CLI_HARNESSES.has(name)) {
    return {
      level: 'unverified',
      label: 'Unverified',
      detail: `Kory has not verified how ${label} gates its own tools. This mode applies to Kory tools only.`,
    };
  }
  if (!name) {
    return { level: 'unverified', label: 'No model selected', detail: 'Choose a model to see who enforces this mode.' };
  }
  // API providers have no tools of their own: every tool call is a Kory tool.
  return {
    level: 'kory',
    label: 'Enforced by Kory',
    detail: 'Every file and command action is a Kory tool call checked against this mode.',
  };
}
