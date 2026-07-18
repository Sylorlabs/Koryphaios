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
  google: {
    label: 'Google',
    iconPath: '/provider-icons/lobehub/google.svg',
    deployment: 'cloud',
    description:
      'Direct Google Gemini API. Uses only GOOGLE_API_KEY; it does not use AI Studio, Vertex AI, gcloud, or Jules credentials.',
  },
  grok: {
    label: 'Grok Build',
    iconPath: '/provider-icons/lobehub/grok.svg',
    deployment: 'local',
    description:
      'CLI only. Runs the official grok CLI on your machine. Install grok, run "grok login", then click Auth — no API key or token entry needed.',
  },
  antigravity: {
    label: 'Antigravity',
    iconPath: '/provider-icons/lobehub/antigravity.svg',
    deployment: 'local',
    description:
      'CLI only. Runs the official agy CLI on your machine. Install agy, run "agy login", then click Auth — credentials stay in the CLI.',
  },
  cursor: {
    label: 'Cursor',
    iconPath: '/provider-icons/lobehub/cursor.svg',
    deployment: 'local',
    description:
      'CLI only. Runs the official cursor-agent CLI on your machine. Install cursor-agent and run "cursor-agent login" — no API key needed.',
  },
  devin: {
    label: 'Devin',
    iconPath: '/provider-icons/lobehub/windsurf.svg',
    deployment: 'local',
    description:
      'CLI only. Runs Cognition\'s official devin CLI on your machine (cloud-backed). Install devin and run "devin auth login" — no API key needed.',
  },
  aistudio: {
    label: 'Google AI Studio',
    iconPath: '/provider-icons/lobehub/gemini.svg',
    deployment: 'cloud',
    description:
      'Google AI Studio — paste your Gemini API key (aistudio.google.com/apikey). Direct Gemini API, no gcloud sign-in.',
  },
  vertexai: {
    label: 'Vertex AI',
    iconPath: '/provider-icons/lobehub/vertexai.svg',
    deployment: 'cloud',
    description:
      'Google Cloud Vertex AI. Uses GOOGLE_VERTEX_AI_API_KEY with your GCP project and location; it is not the Google or AI Studio provider.',
  },
  cline: {
    label: 'Cline',
    iconPath: '/provider-icons/lobehub/cline.svg',
    deployment: 'local',
    description:
      'CLI only. Runs the official cline CLI on your machine — Cline manages its own provider key (run "cline auth …"). No Koryphaios API key.',
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
