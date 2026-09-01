// Curated "featured" MCP server catalog for the Settings → MCP servers →
// Browse registry view. Mirrors what coding agents like Cursor feature in
// their connector marketplace: official first-party remote servers plus the
// most-used local (stdio) servers.
//
// Deliberately excluded because Koryphaios ships the capability natively:
// - memory (@modelcontextprotocol/server-memory)  → Memory console
// - filesystem (@modelcontextprotocol/server-*)   → workspace-aware agents
// - git / github-local (git MCP servers)          → built-in Git integration
// - obsidian                                      → Notes
// - linear                                        → Goals / workflows
// - sequential-thinking                           → agent planning & goal mode

export interface FeaturedMcpServer {
  id: string;
  name: string;
  title: string;
  category: string;
  description: string;
  version: string;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  transport: 'stdio' | 'sse';
  command: string | null;
  args: string[];
  envVars: Array<{
    name: string;
    description: string;
    isRequired: boolean;
    isSecret: boolean;
    defaultValue: string | null;
  }>;
  url: string | null;
  headerVars: Array<{
    name: string;
    description: string;
    isSecret: boolean;
  }>;
}

const CATEGORY_DEV = 'Dev & code hosting';
const CATEGORY_DATABASES = 'Databases';
const CATEGORY_BROWSER = 'Browser automation';
const CATEGORY_SEARCH = 'Web search';
const CATEGORY_DOCS = 'Docs & knowledge';
const CATEGORY_DESIGN = 'Design';
const CATEGORY_COMMS = 'Communication';
const CATEGORY_OPS = 'Commerce & ops';

export const FEATURED_MCP_CATEGORIES = [
  CATEGORY_DEV,
  CATEGORY_DATABASES,
  CATEGORY_BROWSER,
  CATEGORY_SEARCH,
  CATEGORY_DOCS,
  CATEGORY_DESIGN,
  CATEGORY_COMMS,
  CATEGORY_OPS,
] as const;

function remote(
  partial: Omit<
    FeaturedMcpServer,
    'transport' | 'command' | 'args' | 'envVars' | 'url' | 'headerVars'
  > & {
    url: string;
    headerVars?: FeaturedMcpServer['headerVars'];
  },
): FeaturedMcpServer {
  return {
    ...partial,
    transport: 'sse',
    command: null,
    args: [],
    envVars: [],
    url: partial.url,
    headerVars: partial.headerVars ?? [],
  };
}

function stdio(
  partial: Omit<
    FeaturedMcpServer,
    'transport' | 'command' | 'args' | 'envVars' | 'url' | 'headerVars'
  > & {
    command: string;
    args: string[];
    envVars?: FeaturedMcpServer['envVars'];
  },
): FeaturedMcpServer {
  return {
    ...partial,
    transport: 'stdio',
    command: partial.command,
    args: partial.args,
    envVars: partial.envVars ?? [],
    url: null,
    headerVars: [],
  };
}

export const FEATURED_MCP_SERVERS: FeaturedMcpServer[] = [
  // ── Dev & code hosting ─────────────────────────────────────────────────
  remote({
    id: 'io.github.github/github-mcp-server',
    name: 'github',
    title: 'GitHub',
    category: CATEGORY_DEV,
    description:
      'Official GitHub server: repos, issues, pull requests, Actions, and code search. Paste a personal access token as the Authorization header ("Bearer ghp_…").',
    version: 'latest',
    websiteUrl: 'https://github.com/github/github-mcp-server',
    repositoryUrl: 'https://github.com/github/github-mcp-server',
    url: 'https://api.githubcopilot.com/mcp/',
    headerVars: [
      {
        name: 'Authorization',
        description: 'Bearer <your GitHub personal access token>',
        isSecret: true,
      },
    ],
  }),
  remote({
    id: 'io.gitlab/gitlab-mcp-server',
    name: 'gitlab',
    title: 'GitLab',
    category: CATEGORY_DEV,
    description:
      'Official GitLab server (beta) for issues, merge requests, pipelines, and repositories on gitlab.com or self-managed. Paste "Bearer <token>" as the Authorization header.',
    version: 'beta',
    websiteUrl: 'https://docs.gitlab.com/user/gitlab_duo/mcp/',
    repositoryUrl: 'https://gitlab.com/gitlab-org/gitlab',
    url: 'https://gitlab.com/api/v4/mcp',
    headerVars: [
      {
        name: 'Authorization',
        description: 'Bearer <your GitLab personal access token>',
        isSecret: true,
      },
    ],
  }),
  remote({
    id: 'io.sentry/sentry-mcp',
    name: 'sentry',
    title: 'Sentry',
    category: CATEGORY_DEV,
    description:
      'Official Sentry server: pull errors, traces, and release health so the agent can debug against real production issues. OAuth sign-in on first connect.',
    version: 'latest',
    websiteUrl: 'https://mcp.sentry.dev',
    repositoryUrl: 'https://github.com/getsentry/sentry-mcp',
    url: 'https://mcp.sentry.dev',
  }),
  remote({
    id: 'com.atlassian/atlassian-mcp',
    name: 'atlassian',
    title: 'Atlassian (Jira & Confluence)',
    category: CATEGORY_DEV,
    description:
      'Official Atlassian Rovo server for Jira issues, Confluence pages, and Compass. OAuth sign-in with your Atlassian account on first connect.',
    version: 'latest',
    websiteUrl: 'https://developer.atlassian.com/cloud/rovo/mcp-server/',
    repositoryUrl: 'https://github.com/atlassian/atlassian-mcp-server',
    url: 'https://mcp.atlassian.com/v1/mcp',
  }),
  remote({
    id: 'com.datadoghq/datadog-mcp',
    name: 'datadog',
    title: 'Datadog',
    category: CATEGORY_DEV,
    description:
      'Official Datadog server (beta): query logs, metrics, traces, monitors, and dashboards. Set both API and application key headers.',
    version: 'beta',
    websiteUrl: 'https://docs.datadoghq.com/integrations/mcp/',
    repositoryUrl: 'https://github.com/DataDog/datadog-mcp-server',
    url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    headerVars: [
      { name: 'DD-API-KEY', description: 'Your Datadog API key', isSecret: true },
      {
        name: 'DD-APPLICATION-KEY',
        description: 'Your Datadog application key',
        isSecret: true,
      },
    ],
  }),
  // ── Databases ──────────────────────────────────────────────────────────
  remote({
    id: 'io.supabase/supabase-mcp',
    name: 'supabase',
    title: 'Supabase',
    category: CATEGORY_DATABASES,
    description:
      'Official Supabase server: manage tables, query data, fetch config, and generate types across your Supabase projects. OAuth sign-in on first connect.',
    version: 'latest',
    websiteUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    repositoryUrl: 'https://github.com/supabase-community/supabase-mcp',
    url: 'https://mcp.supabase.com/mcp',
  }),
  remote({
    id: 'com.neon/neon-mcp',
    name: 'neon',
    title: 'Neon Postgres',
    category: CATEGORY_DATABASES,
    description:
      'Official Neon server: create and manage Neon projects, branches, and databases, and run SQL migrations. OAuth sign-in on first connect.',
    version: 'latest',
    websiteUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    repositoryUrl: 'https://github.com/neondatabase/mcp-server-neon',
    url: 'https://mcp.neon.tech/mcp',
  }),
  stdio({
    id: 'io.github.modelcontextprotocol/server-postgres',
    name: 'postgres',
    title: 'PostgreSQL (read-only)',
    category: CATEGORY_DATABASES,
    description:
      'Reference server with read-only access to a PostgreSQL database: list tables and run SELECT queries. Replace the connection-string argument with your database URL.',
    version: 'latest',
    websiteUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost:5432/mydb'],
  }),
  stdio({
    id: 'com.mongodb/mongodb-mcp',
    name: 'mongodb',
    title: 'MongoDB',
    category: CATEGORY_DATABASES,
    description:
      'Official MongoDB server: explore collections, inspect schemas, and run queries against a cluster. Set the connection string environment variable.',
    version: 'latest',
    websiteUrl: 'https://www.mongodb.com/docs/languages/tools/mcp-server/',
    repositoryUrl: 'https://github.com/mongodb-js/mongodb-mcp-server',
    command: 'npx',
    args: ['-y', 'mongodb-mcp-server'],
    envVars: [
      {
        name: 'MDB_MCP_CONNECTION_STRING',
        description: 'mongodb+srv://user:password@cluster.mongodb.net/mydb',
        isRequired: true,
        isSecret: true,
        defaultValue: null,
      },
    ],
  }),
  // ── Browser automation ─────────────────────────────────────────────────
  stdio({
    id: 'io.github.microsoft/playwright-mcp',
    name: 'playwright',
    title: 'Playwright',
    category: CATEGORY_BROWSER,
    description:
      'Official Playwright server from Microsoft: drive a real accessibility-tree browser to navigate, click, fill forms, and screenshot pages.',
    version: 'latest',
    websiteUrl: 'https://github.com/microsoft/playwright-mcp',
    repositoryUrl: 'https://github.com/microsoft/playwright-mcp',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  }),
  remote({
    id: 'com.browserbase/browserbase-mcp',
    name: 'browserbase',
    title: 'Browserbase',
    category: CATEGORY_BROWSER,
    description:
      'Official Browserbase server: cloud browser sessions to navigate, extract data, and take screenshots at scale. API key or OAuth on first connect.',
    version: 'latest',
    websiteUrl: 'https://docs.browserbase.com/integrations/mcp/connect-mcp-server',
    repositoryUrl: 'https://github.com/browserbase/mcp-server-browserbase',
    url: 'https://api.browserbase.com/mcp',
  }),
  remote({
    id: 'com.browserstack/browserstack-mcp',
    name: 'browserstack',
    title: 'BrowserStack',
    category: CATEGORY_BROWSER,
    description:
      'Official BrowserStack server: test sites on real devices and browsers, access test observability data, and debug failures. OAuth sign-in on first connect.',
    version: 'latest',
    websiteUrl: 'https://www.browserstack.com/docs/mcp-server',
    repositoryUrl: 'https://github.com/browserstack/mcp-server',
    url: 'https://mcp.browserstack.com/mcp',
  }),
  // ── Web search ─────────────────────────────────────────────────────────
  stdio({
    id: 'io.github.modelcontextprotocol/server-brave-search',
    name: 'brave-search',
    title: 'Brave Search',
    category: CATEGORY_SEARCH,
    description:
      'Reference server for web and local search via the Brave Search API. Get a free API key at api-dashboard.search.brave.com.',
    version: 'latest',
    websiteUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      {
        name: 'BRAVE_API_KEY',
        description: 'Your Brave Search API key',
        isRequired: true,
        isSecret: true,
        defaultValue: null,
      },
    ],
  }),
  remote({
    id: 'com.exa/exa-mcp',
    name: 'exa',
    title: 'Exa',
    category: CATEGORY_SEARCH,
    description:
      'Official Exa server: AI-powered web search, company and research-paper search, deep-research reports, and crawling. Free tier API key supported.',
    version: 'latest',
    websiteUrl: 'https://docs.exa.ai/exa-mcp-server/overview',
    repositoryUrl: 'https://github.com/exa-labs/exa-mcp-server',
    url: 'https://mcp.exa.ai/mcp',
  }),
  // ── Docs & knowledge ───────────────────────────────────────────────────
  remote({
    id: 'com.upstash/context7',
    name: 'context7',
    title: 'Context7',
    category: CATEGORY_DOCS,
    description:
      'Upstash Context7: pull up-to-date, version-specific library documentation and code examples straight into agent context.',
    version: 'latest',
    websiteUrl: 'https://context7.com',
    repositoryUrl: 'https://github.com/upstash/context7',
    url: 'https://mcp.context7.com/mcp',
  }),
  remote({
    id: 'com.notion/notion-mcp',
    name: 'notion',
    title: 'Notion',
    category: CATEGORY_DOCS,
    description:
      'Official Notion server: search, read, and update team docs, specs, wikis, and databases. OAuth sign-in with your Notion workspace on first connect.',
    version: 'latest',
    websiteUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    repositoryUrl: 'https://github.com/makenotion/notion-mcp-server',
    url: 'https://mcp.notion.com/mcp',
  }),
  // ── Design ─────────────────────────────────────────────────────────────
  remote({
    id: 'com.figma/figma-mcp',
    name: 'figma',
    title: 'Figma',
    category: CATEGORY_DESIGN,
    description:
      'Official Figma Dev Mode server: read design tokens, inspect components, and get design-to-code context. OAuth sign-in on first connect.',
    version: 'latest',
    websiteUrl:
      'https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server',
    repositoryUrl: 'https://github.com/figma/figma-mcp',
    url: 'https://mcp.figma.com/mcp',
  }),
  // ── Communication ──────────────────────────────────────────────────────
  remote({
    id: 'com.slack/slack-mcp',
    name: 'slack',
    title: 'Slack',
    category: CATEGORY_COMMS,
    description:
      'Official Slack server: fetch thread context, send messages, manage channels and canvases. OAuth sign-in with your Slack workspace on first connect.',
    version: 'latest',
    websiteUrl: 'https://docs.slack.dev/ai/slack-mcp-server',
    repositoryUrl: 'https://github.com/slackapi/slack-mcp-server',
    url: 'https://mcp.slack.com/mcp',
  }),
  // ── Commerce & ops ─────────────────────────────────────────────────────
  remote({
    id: 'com.stripe/stripe-mcp',
    name: 'stripe',
    title: 'Stripe',
    category: CATEGORY_OPS,
    description:
      'Official Stripe server: manage payments, subscriptions, customers, and balances, and inspect disputes. OAuth sign-in on first connect.',
    version: 'latest',
    websiteUrl: 'https://docs.stripe.com/mcp',
    repositoryUrl: 'https://github.com/stripe/agent-toolkit',
    url: 'https://mcp.stripe.com',
  }),
];
