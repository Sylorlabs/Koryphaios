// Provider display metadata surfaced to the UI and manager prompts.

import type { ProviderName } from '@koryphaios/shared';

export type ProviderDeployment = 'cloud' | 'api' | 'local' | 'hybrid';

export interface ProviderDisplayMeta {
  /** Human label. Omit only when the generated label is already correct and
   *  the entry exists solely to attach a website URL. */
  label?: string;
  /** Static icon path. Omit when no first-party mark is shipped. */
  iconPath?: string;
  deployment?: ProviderDeployment;
  description?: string;
  /** Official page where the user creates the credential this adapter expects. */
  credentialUrl?: string;
  /** Injected into manager system prompts when this provider is relevant. */
  managerHint?: string;
}

export const JULES_SYNC_INSTRUCTIONS = `Jules runs in Google's cloud — it does NOT edit your local working tree. After Jules completes:
1. If a PR URL was returned: review it, then run \`gh pr checkout <number>\` (or merge on GitHub and \`git pull origin <branch>\`).
2. If Jules pushed to your repo branch: run \`git fetch origin && git pull\`.
3. Verify locally with \`git status\`, tests, and a quick smoke check before continuing.
Never assume local files changed until you have pulled or checked out the remote work.`;

export const HOPLITE_SYNC_INSTRUCTIONS = `Hoplite runs a thread either in Hoplite's cloud or on a local agent, so the sync rules depend on which target the thread used.

Cloud target — does NOT edit your local working tree. Tasks run in Hoplite sandboxes against the project's GitHub repos and produce Hoplite threads and pull requests. After a cloud thread completes:
1. If a PR URL was returned: review it, then run \`gh pr checkout <number>\` (or merge on GitHub and \`git pull origin <branch>\`).
2. If Hoplite pushed to your repo branch: run \`git fetch origin && git pull\`.
3. Verify locally with \`git status\`, tests, and a quick smoke check before continuing.

Local target — runs a local agent (Codex or Claude) against your checkout in \`direct\` or \`worktree\` workspace mode, so it edits the working tree directly. Review the diff in place; there is no PR to pull.

Live delegation into Hoplite is not wired in this release; the API key is verified in Settings.`;

export const PROVIDER_DISPLAY: Partial<Record<ProviderName, ProviderDisplayMeta>> = {
  beam: {
    label: 'Reflection AI',
    iconPath: '/provider-icons/reflection.svg',
    deployment: 'api',
    credentialUrl: 'https://platform.reflection.ai/api-keys',
    description:
      'Reflection AI text models through OpenAI-compatible Chat Completions and Models endpoints.',
  },
  agentrouter: {
    label: 'AgentRouter',
    deployment: 'api',
    credentialUrl: 'https://agentrouter.org',
    description: 'OpenAI-compatible Chat Completions and Anthropic-compatible Claude Messages through the selected AgentRouter gateway.',
  },
  commandcode: {
    label: 'Command Code',
    iconPath: '/provider-icons/commandcode-color.svg',
    deployment: 'api',
    credentialUrl: 'https://commandcode.ai/settings/keys',
    description: 'OpenAI- and Anthropic-compatible model gateway.',
  },
  tokenrouter: {
    label: 'TokenRouter',
    iconPath: '/provider-icons/tokenrouter.svg',
    deployment: 'api',
    description: 'OpenAI-compatible model gateway.',
  },
  unorouter: {
    label: 'UnoRouter',
    iconPath: '/provider-icons/unorouter-color.svg',
    deployment: 'api',
    credentialUrl: 'https://unorouter.com/en/docs/platform/quickstart',
    description: 'Open-source OpenAI-compatible gateway — one key for 200+ models.',
  },
  respan: {
    label: 'Respan',
    iconPath: '/provider-icons/respan.svg',
    deployment: 'api',
    credentialUrl: 'https://platform.respan.ai/platform/gateway/api-keys',
    description: 'Respan AI gateway — one key for 2000+ models with built-in observability.',
  },
  experientiallabs: {
    label: 'Experiential Labs',
    iconPath: '/provider-icons/experientiallabs-color.svg',
    deployment: 'api',
    credentialUrl: 'https://platform.experientiallabs.ai/',
    description: 'Open-source AI gateway — one key for hosted, BYOK, and local models.',
  },
  tokenharbor: {
    label: 'Token Harbor',
    // Official monochrome anchor mark from tokenharbor.ai/logo.svg.
    iconPath: '/provider-icons/tokenharbor.svg',
    deployment: 'api',
    credentialUrl: 'https://tokenharbor.ai/dashboard/api-keys',
    description:
      'OpenAI- and Anthropic-compatible gateway — one thk_live_ key for GPT, Claude, Gemini, DeepSeek and more, with per-token pricing and automatic failover.',
  },
  logfare: {
    label: 'Logfare',
    // Official Logfare mark (logfare.ai/static/img/favicon.png).
    iconPath: '/provider-icons/logfare-color.png',
    deployment: 'api',
    credentialUrl: 'https://logfare.ai/register',
    description:
      'Free community-run OpenAI-compatible inference. Requests are logged for internal research datasets in exchange for no-cost access; use `logfare/auto` to route across the catalog.',
  },
  gwarden: {
    label: 'Gwarden AI',
    // Official mark from gwarden.su/logo.png — the icon the vendor itself
    // declares via `<link rel="icon">`, shipped unmodified.
    iconPath: '/provider-icons/gwarden-color.png',
    deployment: 'api',
    credentialUrl: 'https://gwarden.su/dashboard',
    description:
      'Unified gateway speaking the OpenAI, Anthropic and Responses APIs on one key — 96 models across Claude, GPT, Gemini, Grok, Kimi, DeepSeek and GLM. The public /v1/models catalog reports each model’s own context and output limits.',
  },
  apinex: {
    label: 'APInex',
    // Official APInex brand mark (apinex.bond/brand/mark.png).
    iconPath: '/provider-icons/apinex-color.png',
    deployment: 'api',
    credentialUrl: 'https://apinex.bond/login',
    description:
      'OpenAI-compatible gateway on one prepaid token balance — chat models plus web research, X/Twitter and voice tools through the same key.',
  },
  digitalocean: {
    label: 'DigitalOcean Inference',
    iconPath: '/provider-icons/digitalocean.svg',
    deployment: 'api',
    description: 'DigitalOcean serverless inference.',
  },
  codex: {
    label: 'Codex CLI',
    iconPath: '/provider-icons/lobehub/codex.svg',
    deployment: 'local',
    credentialUrl: 'https://chatgpt.com/',
    description:
      'Use an existing login from the local `codex` CLI. This is separate from Koryphaios-managed ChatGPT sign-in.',
  },
  'codex-auth': {
    label: 'OpenAI Codex',
    iconPath: '/provider-icons/lobehub/codex.svg',
    deployment: 'local',
    credentialUrl: 'https://chatgpt.com/',
    description:
      'Sign in with ChatGPT. The official local Codex app-server owns OAuth, refreshes, and subscription access.',
  },
  claude: {
    credentialUrl: 'https://claude.ai/',
  },
  google: {
    label: 'Google',
    iconPath: '/provider-icons/lobehub/google.svg',
    deployment: 'api',
    credentialUrl: 'https://aistudio.google.com/apikey',
    description:
      'Direct Google Gemini API. Uses only GOOGLE_API_KEY; it does not use AI Studio, Vertex AI, gcloud, or Jules credentials.',
  },
  kimicode: {
    label: 'Kimi Code',
    iconPath: '/provider-icons/lobehub/kimi-color.svg',
    deployment: 'api',
    description:
      'Sign in with your Kimi account via the official OAuth device flow. Koryphaios stores only a local session marker and refreshes tokens automatically — no API key entry.',
  },
  grok: {
    label: 'Grok Build',
    iconPath: '/provider-icons/lobehub/grok.svg',
    deployment: 'local',
    description:
      'CLI only. Runs the official grok CLI on your machine. Install grok, run "grok login", then click Auth — no API key or token entry needed.',
  },
  opencode: {
    label: 'OpenCode',
    iconPath: '/provider-icons/lobehub/opencode.svg',
    deployment: 'local',
    credentialUrl: 'https://opencode.ai/auth',
    description:
      'CLI only. Runs the official opencode CLI on your machine over ACP. Install opencode, run "opencode auth login", then click Auth — credentials stay in the CLI. Models and context windows come from the CLI\'s own authenticated catalog; host actions run through Koryphaios\'s approval-gated tool bridge.',
  },
  codebuddy: {
    label: 'CodeBuddy',
    // The official CodeBuddy brand mark, copied from the installed CLI package.
    iconPath: '/provider-icons/codebuddy-color.png',
    deployment: 'local',
    description:
      "Runs Tencent's official CodeBuddy CLI harness with your CLI login. Credentials stay CLI-owned; the model catalog comes from the installed CLI product files.",
  },
  cohere: {
    label: 'Cohere',
    iconPath: '/provider-icons/lobehub/cohere.svg',
    deployment: 'api',
    description:
      'API model via OpenAI-compatible compatibility endpoint (set API key, then verify connection).',
  },
  antigravity: {
    label: 'Antigravity',
    iconPath: '/provider-icons/lobehub/antigravity.svg',
    deployment: 'local',
    description:
      'CLI only. Runs the official agy CLI on your machine. Install agy, run "agy login", then click Auth — credentials stay in the CLI. ' +
      'Native shell, file writes, and web tools are denied by Koryphaios; all host actions run through its approval-gated tool bridge.',
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
      'CLI only. Runs Cognition\'s official devin CLI on your machine. Install devin and run "devin auth login" — no API key needed.',
  },
  aistudio: {
    label: 'Google AI Studio',
    iconPath: '/provider-icons/lobehub/aistudio.svg',
    deployment: 'api',
    credentialUrl: 'https://aistudio.google.com/apikey',
    description:
      'Google AI Studio — paste your Gemini API key (aistudio.google.com/apikey). Direct Gemini API, no gcloud sign-in.',
  },
  vertexai: {
    label: 'Vertex AI',
    iconPath: '/provider-icons/lobehub/vertexai.svg',
    deployment: 'api',
    description:
      'Google Cloud Vertex AI. Uses GOOGLE_VERTEX_AI_API_KEY with your GCP project and location; it is not the Google or AI Studio provider.',
  },
  azure: {
    label: 'Azure OpenAI',
    iconPath: '/provider-icons/lobehub/azure.svg',
    deployment: 'api',
    description:
      'Azure OpenAI inference requires your resource endpoint, credential, and explicit deployment name. Base model catalog IDs are not runnable deployment names.',
  },
  azurecognitive: {
    label: 'Azure Cognitive',
    iconPath: '/provider-icons/lobehub/azure.svg',
    deployment: 'api',
    description:
      'Azure-hosted OpenAI inference requires your resource endpoint, credential, and explicit deployment name. Catalog model IDs are not inferred as deployments.',
  },
  bedrock: {
    label: 'AWS Bedrock',
    iconPath: '/provider-icons/lobehub/bedrock-color.svg',
    deployment: 'api',
    description:
      'Anthropic Claude models on Amazon Bedrock only. A successful regional catalog check is reported as detected catalog access; InvokeModel permission, model entitlement, quota, and runtime inference remain unverified until a request succeeds.',
  },
  'github-models': {
    label: 'GitHub Models',
    iconPath: '/provider-icons/lobehub/github.svg',
    deployment: 'api',
    description:
      'GitHub Models inference. Verification queries the official models.github.ai catalog; a saved token alone is only detected, not verified.',
  },
  gitlab: {
    label: 'GitLab Duo',
    iconPath: '/provider-icons/gitlab-color.svg',
    deployment: 'api',
    credentialUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    description:
      "GitLab Duo's chat API (POST /api/v4/chat/completions) with a personal access token carrying the `api` or `ai_features` scope. Answers arrive as one non-streamed body and GitLab picks the model. gitlab.com serves this endpoint to GitLab team members only; self-managed needs the access_rest_chat feature flag and a seat with Duo access.",
  },
  sapai: {
    label: 'SAP AI Core',
    iconPath: '/provider-icons/sapai-color.svg',
    deployment: 'api',
    description:
      'SAP AI Core requires a service-key OAuth exchange, AI resource group, and explicit running deployment ID. Service-key JSON is never sent as a bearer token.',
  },
  // No `description`: the card shows only the name and the API key input.
  // The integration facts (OpenAI-compatible base, the three catalog
  // endpoints, first-party + models.dev reasoning ladders) are documented on
  // backend/src/providers/cline.ts.
  cline: {
    label: 'Cline',
    iconPath: '/provider-icons/lobehub/cline.svg',
    deployment: 'api',
    credentialUrl: 'https://app.cline.bot/settings/api-keys',
  },
  freebuff: {
    label: 'Freebuff (Experimental)',
    iconPath: '/provider-icons/lobehub/codebuff.svg',
    deployment: 'local',
    description:
      'Runs the real Freebuff TUI in a tmux PTY. Native tools are confined to a disposable bubblewrap checkout; the real project is available through Koryphaios\u2019s authenticated MCP tool bridge. Login remains owned by `freebuff login`.',
  },
  codebuff: {
    label: 'Codebuff API',
    iconPath: '/provider-icons/lobehub/codebuff.svg',
    deployment: 'api',
    credentialUrl: 'https://www.codebuff.com/api-keys',
    description:
      'Official @codebuff/sdk provider using your Codebuff API key and the documented Codebuff base agent. SDK filesystem and terminal tools route through Koryphaios permissions.',
  },
  kilocode: {
    label: 'Kilo Code',
    iconPath: '/provider-icons/lobehub/kilocode.svg',
    deployment: 'api',
    credentialUrl: 'https://app.kilo.ai',
    description:
      'Kilo AI Gateway — one API key for hundreds of OpenAI-compatible models. Add your key from app.kilo.ai. BYOK provider keys are configured on the Kilo dashboard.',
  },
  jules: {
    label: 'Google Jules',
    iconPath: '/provider-icons/jules.svg',
    deployment: 'cloud',
    description:
      'Cloud async coding agent (API only). Tasks run on remote Google VMs and land on GitHub first — pull or checkout PRs to sync locally.',
    managerHint: JULES_SYNC_INSTRUCTIONS,
  },
  hoplite: {
    label: 'Hoplite',
    iconPath: '/provider-icons/hoplite.svg',
    // Hoplite threads run in Hoplite cloud sandboxes *or* on a local agent
    // (`executionTarget.kind: 'local'`, provider codex|claude), so the provider
    // is genuinely hybrid rather than cloud-only.
    deployment: 'hybrid',
    description:
      'Cloud + local async coding agent (hoplite.sh). A thread runs either in Hoplite cloud sandboxes against your GitHub repos — producing threads and pull requests — or on a local Codex/Claude agent in direct or worktree workspace mode. Model, reasoning effort, and fast tier are chosen per thread. The organization API key is verified in Settings; live delegation is not wired in this release.',
    managerHint: HOPLITE_SYNC_INSTRUCTIONS,
  },
  poe: {
    label: 'Poe',
    iconPath: '/provider-icons/lobehub/poe-color.svg',
    deployment: 'api',
    description:
      'Poe API gateway. Paste an API key from poe.com/api_key; Koryphaios sends it only to https://api.poe.com/v1.',
  },
  notion: {
    label: 'Notion',
    iconPath: '/provider-icons/lobehub/notion.svg',
    deployment: 'api',
    credentialUrl: 'https://developers.notion.com/guides/get-started/personal-access-tokens',
    description:
      'Notion Agent APIs. Connect with a Personal Access Token (PAT) from the Notion Developer portal to chat with the Custom Agents your token can reach.',
  },
  workbuddy: {
    label: 'WorkBuddy',
    iconPath: '/provider-icons/workbuddy-color.png',
    deployment: 'api',
    description:
      'Work Buddy (workbuddy.ai) API keys are issued by Tencent TokenHub. Koryphaios sends the key only to https://tokenhub-intl.tencentcloudmaas.com/v1. Create a key at https://console.cloud.tencent.com/tokenhub/apikey.',
    credentialUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
  },
  'workbuddy-desktop': {
    label: 'WorkBuddy Desktop',
    // The official WorkBuddy brand mark — shared with the WorkBuddy cloud
    // provider so both surfaces read as the same product, but the label is
    // distinct ("WorkBuddy Desktop" vs "WorkBuddy") to avoid confusion.
    iconPath: '/provider-icons/workbuddy-color.png',
    deployment: 'local',
    description:
      'Runs the WorkBuddy AI desktop app installed on this machine. That is the ' +
      'entire setup: no API key, no token, no login step. Koryphaios hosts the ' +
      'runtime inside the running app so turns inherit its sign-in and limits, ' +
      'and falls back to the bundled runtime when the app is closed. ' +
      'WORKBUDDY_DESKTOP_APP_PATH is only needed for a non-standard install location.',
    managerHint:
      'Install WorkBuddy AI and it is ready. kory__ MCP tools (context, notes, ' +
      'delegation) are injected into every turn automatically.',
  },
  autoclaw: {
    label: 'AutoClaw',
    iconPath: '/provider-icons/autoclaw.svg',
    deployment: 'api',
    description:
      'Connects Koryphaios to the AutoClaw (Z.ai) desktop app installed on this machine: an OpenAI-compatible gateway bound to loopback at http://127.0.0.1:18789/v1. Paste the gateway bearer token from ~/.openclaw-autoclaw/.gateway-token (or copy it from the AutoClaw app).',
  },
  // Website key pages for API providers whose credentials are created on the
  // provider's own site. Labels keep their generated values; these entries
  // only attach the official key-management URL surfaced in Settings.
  qwen: {
    credentialUrl: 'https://bailian.console.aliyun.com/',
  },
  zai: {
    credentialUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  perplexity: {
    credentialUrl: 'https://www.perplexity.ai/api',
  },
  stepfun: {
    credentialUrl: 'https://platform.stepfun.com/',
  },

  // Dedicated capability providers: these have no chat-completions contract,
  // so they are configured and verified through their own adapters and appear
  // in the surface matching their API rather than in the chat picker.
  replicate: {
    label: 'Replicate',
    iconPath: '/provider-icons/lobehub/replicate.svg',
    deployment: 'api',
    credentialUrl: 'https://replicate.com/account/api-tokens',
    description: 'Runs image, video, audio, and embedding models through the predictions API.',
    managerHint:
      'Replicate generates media asynchronously. For image or video requests call the Koryphaios image or video route rather than expecting a chat completion.',
  },
  luma: {
    label: 'Luma',
    iconPath: '/provider-icons/lobehub/luma.svg',
    deployment: 'api',
    credentialUrl: 'https://platform.lumalabs.ai/',
    description: 'Dream Machine video and image generation through asynchronous generation jobs.',
    managerHint:
      'Luma generations are asynchronous and can take minutes. Submit the job and let the video route poll it rather than blocking a turn.',
  },
  klingai: {
    label: 'Kling AI',
    iconPath: '/provider-icons/lobehub/kling.svg',
    deployment: 'api',
    credentialUrl: 'https://kling.ai/dev',
    description: 'Kling AI text-to-video, image-to-video, and image generation tasks.',
    managerHint:
      'Kling video tasks are asynchronous and billed per task. Use the video route and expect a multi-minute wait.',
  },
  prodia: {
    label: 'Prodia',
    deployment: 'api',
    credentialUrl: 'https://app.prodia.com/dashboard/api-tokens',
    description: 'FLUX, SDXL, Gemini, Recraft, and Wan inference through the unified job endpoint.',
  },
  lmnt: {
    label: 'LMNT',
    deployment: 'api',
    credentialUrl: 'https://lmnt.com/settings',
    description: 'Low-latency speech synthesis with voice cloning across 31 languages.',
  },
  voyageai: {
    label: 'Voyage AI',
    iconPath: '/provider-icons/lobehub/voyage.svg',
    deployment: 'api',
    credentialUrl: 'https://dashboard.voyageai.com/api-keys',
    description: 'Embeddings and rerankers that back semantic memory retrieval.',
  },
  mem0: {
    label: 'Mem0',
    deployment: 'cloud',
    credentialUrl: 'https://app.mem0.ai/dashboard/api-keys',
    description: 'Managed long-term memory that survives across machines and restarts.',
  },
  letta: {
    label: 'Letta',
    iconPath: '/provider-icons/letta.svg',
    deployment: 'cloud',
    credentialUrl: 'https://app.letta.com/api-keys',
    description: 'Stateful agents with archival memory blocks and searchable passages.',
  },
};

export function getProviderDisplay(name: ProviderName): ProviderDisplayMeta | undefined {
  return PROVIDER_DISPLAY[name];
}
