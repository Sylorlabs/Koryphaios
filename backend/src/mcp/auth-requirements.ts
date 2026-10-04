// Which credential a configured MCP server needs, and how the user gets it.
//
// The browse view classifies a server from registry metadata. This module does
// the same for a server that is already configured, so the settings row can say
// up front what is missing instead of letting the user discover it through a 401.
//
// A server configured with no credentials at all — a hand-added remote endpoint
// the user never finished setting up — is the case worth being loud about, so
// that returns `kind: 'unknown'` with an explicit next step.

import {
  FEATURED_MCP_SERVERS,
  deriveMcpAuthRequirement,
  type McpAuthRequirement,
} from './featured-registry';

interface ServerLikeConfig {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

const BY_NAME = new Map(FEATURED_MCP_SERVERS.map((server) => [server.name, server]));

/**
 * A configured server the user built by hand. There is no registry record, so
 * the best we can do is infer from what is present and be explicit when nothing
 * is.
 */
const UNKNOWN_REMOTE: McpAuthRequirement = {
  kind: 'unknown',
  label: 'Sign-in required',
  detail:
    'This remote server was added without any credential. Open it to enter a token header, or remove it if it is no longer needed.',
};

const UNKNOWN_LOCAL: McpAuthRequirement = {
  kind: 'none',
  label: 'No sign-in',
  detail: 'Runs locally.',
};

/**
 * Resolve the auth requirement for a configured server.
 *
 * Featured servers keep their curated classification, which knows more than
 * inference can (for example that Slack needs the user's own app). Everything
 * else is inferred, and an unclassifiable remote server is reported as
 * `unknown` rather than optimistically as "no sign-in".
 */
export function lookupMcpAuthRequirement(
  serverName: string,
  config: ServerLikeConfig | null,
): McpAuthRequirement {
  const featured = BY_NAME.get(serverName);
  if (featured) return featured.auth;

  if (!config) return UNKNOWN_REMOTE;
  if (config.type === 'stdio') return UNKNOWN_LOCAL;

  const url = typeof config.url === 'string' ? config.url.trim() : '';
  if (!url) return UNKNOWN_REMOTE;

  return deriveMcpAuthRequirement({
    title: serverName,
    transport: 'sse',
    url,
    headerVars: Object.keys(config.headers ?? {})
      .filter((name) => {
        const value = config.headers?.[name];
        return typeof value === 'string' && value.trim().length > 0;
      })
      .map((name) => ({
        name,
        description: '',
        isSecret: /authorization|token|key|secret/i.test(name),
      })),
    envVars: [],
  });
}