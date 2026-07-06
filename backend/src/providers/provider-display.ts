// Provider display metadata surfaced to the UI and manager prompts.

import type { ProviderName } from '@koryphaios/shared';

export type ProviderDeployment = 'cloud' | 'local' | 'hybrid';

export interface ProviderDisplayMeta {
  label: string;
  iconPath: string;
  deployment?: ProviderDeployment;
  description?: string;
  /** Injected into manager system prompts when this provider is relevant. */
  managerHint?: string;
}

export const JULES_SYNC_INSTRUCTIONS = `Jules runs in Google's cloud — it does NOT edit your local working tree. After Jules completes:
1. If a PR URL was returned: review it, then run \`gh pr checkout <number>\` (or merge on GitHub and \`git pull origin <branch>\`).
2. If Jules pushed to your repo branch: run \`git fetch origin && git pull\`.
3. Verify locally with \`git status\`, tests, and a quick smoke check before continuing.
Never assume local files changed until you have pulled or checked out the remote work.`;

export const PROVIDER_DISPLAY: Partial<Record<ProviderName, ProviderDisplayMeta>> = {
  grok: {
    label: 'Grok Build',
    iconPath: '/provider-icons/lobehub/grok.svg',
    deployment: 'local',
    description:
      'Runs the official grok CLI on your machine. Install grok, run "grok login", then click Auth — no API key or token entry needed.',
  },
  antigravity: {
    label: 'Antigravity',
    iconPath: '/provider-icons/lobehub/antigravity.svg',
    deployment: 'local',
    description:
      'Runs the official agy CLI on your machine. Install agy, run "agy login", then click Auth — credentials stay in the CLI.',
  },
  cursor: {
    label: 'Cursor',
    iconPath: '/provider-icons/lobehub/cursor.svg',
    deployment: 'local',
    description:
      'Runs the official cursor-agent CLI on your machine. Install cursor-agent and run "cursor-agent login" — no API key needed.',
  },
  devin: {
    label: 'Devin',
    iconPath: '/provider-icons/lobehub/windsurf.svg',
    deployment: 'local',
    description:
      'Runs Cognition\'s official devin CLI on your machine (cloud-backed). Install devin and run "devin auth login" — no API key needed.',
  },
  jules: {
    label: 'Google Jules',
    iconPath: '/provider-icons/jules.svg',
    deployment: 'cloud',
    description:
      'Cloud async coding agent (API only). Tasks run on remote Google VMs and land on GitHub first — pull or checkout PRs to sync locally.',
    managerHint: JULES_SYNC_INSTRUCTIONS,
  },
};

export function getProviderDisplay(name: ProviderName): ProviderDisplayMeta | undefined {
  return PROVIDER_DISPLAY[name];
}