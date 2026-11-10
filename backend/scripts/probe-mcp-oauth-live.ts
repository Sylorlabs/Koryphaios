#!/usr/bin/env bun
/**
 * Read-only live probe of MCP OAuth discovery against real hosted servers.
 *
 * Performs only the metadata fetches an MCP client must get right — the 401
 * challenge, protected-resource metadata, and authorization-server metadata.
 * It deliberately does NOT run dynamic client registration or start a consent
 * flow, so it creates no client records and grants nothing at any provider.
 *
 *   cd backend && bun run scripts/probe-mcp-oauth-live.ts
 *
 * Exit code is non-zero if a server that publishes OAuth metadata cannot be
 * driven far enough to learn its authorization and token endpoints.
 */

import {
  discoverProtectedResource,
  discoverAuthorizationServer,
  parseWwwAuthenticate,
} from '../src/mcp/oauth';

interface Target {
  label: string;
  url: string;
}

const TARGETS: Target[] = [
  { label: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { label: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { label: 'Figma', url: 'https://mcp.figma.com/mcp' },
  { label: 'Slack', url: 'https://mcp.slack.com/mcp' },
  { label: 'Stripe', url: 'https://mcp.stripe.com' },
  { label: 'Supabase', url: 'https://mcp.supabase.com/mcp' },
  { label: 'Neon', url: 'https://mcp.neon.tech/mcp' },
  { label: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp' },
  { label: 'Datadog', url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp' },
  { label: 'Context7', url: 'https://mcp.context7.com/mcp' },
  { label: 'Exa', url: 'https://mcp.exa.ai/mcp' },
];

/** Capture the 401 challenge the way the MCP client does. */
async function challengeFor(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/list',
        'User-Agent': 'Koryphaios (MCP OAuth client)',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(20_000),
    });
    return resp.status === 401 ? resp.headers.get('www-authenticate') : null;
  } catch {
    return null;
  }
}

interface Row {
  label: string;
  status: number | null;
  prm: boolean;
  authServer: boolean;
  dcr: boolean;
  pkce: string;
  scopes: number;
  note: string;
}

const rows: Row[] = [];

for (const target of TARGETS) {
  const challenge = await challengeFor(target.url);
  const status = challenge ? 401 : null;
  const prm = await discoverProtectedResource(target.url, challenge);

  // Mirror resolveAuthorizationChallenge exactly: when a server publishes no
  // protected-resource metadata, its own origin is used as the issuer.
  let authServer = null as Awaited<ReturnType<typeof discoverAuthorizationServer>>;
  if (prm) {
    authServer = await discoverAuthorizationServer(prm.authorization_servers[0]!);
  } else if (challenge) {
    authServer = await discoverAuthorizationServer(new URL(target.url).origin);
  }

  let note = '';
  if (!prm && !challenge) {
    note = 'no OAuth challenge (token header or open access)';
  } else if (!prm) {
    note = 'no protected-resource metadata; using origin as issuer';
  } else if (!authServer) {
    note = 'protected resource found; authorization server metadata unavailable';
  } else if (!authServer.registration_endpoint) {
    note = 'no dynamic client registration — needs its own app credentials';
  }

  rows.push({
    label: target.label,
    status,
    prm: Boolean(prm),
    authServer: Boolean(authServer),
    dcr: Boolean(authServer?.registration_endpoint),
    pkce: (authServer?.code_challenge_methods_supported ?? []).join('/') || '-',
    scopes: authServer?.scopes_supported?.length ?? prm?.scopes_supported?.length ?? 0,
    note,
  });

  const verdict = rows.at(-1)!;
  const mark = verdict.dcr ? 'AUTOMATABLE' : verdict.authServer ? 'PARTIAL   ' : 'NO-DISCOVERY';
  console.log(
    `${mark}  ${verdict.label.padEnd(10)} prm=${verdict.prm ? 'y' : 'n'} as=${verdict.authServer ? 'y' : 'n'} pkce=${verdict.pkce.padEnd(6)} scopes=${verdict.scopes}${verdict.note ? `  — ${verdict.note}` : ''}`,
  );
}

const automatable = rows.filter((r) => r.dcr);
console.log(
  `\n${automatable.length}/${rows.length} servers support fully automatic authorization (DCR + PKCE):`,
);
console.log(automatable.map((r) => `  - ${r.label}`).join('\n') || '  (none)');

const partial = rows.filter((r) => !r.dcr);
if (partial.length > 0) {
  console.log(`\nNot automatable without provider app credentials:`);
  console.log(partial.map((r) => `  - ${r.label}: ${r.note}`).join('\n'));
}

process.exit(automatable.length > 0 ? 0 : 1);
