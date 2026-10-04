// Live probe: connect the real MCPClient to real servers pulled from the
// official MCP registry, using the exact same mapping the Settings browse view
// uses. This is the check that the transport fix works against production
// servers, not just the local fixture.
//
//   cd backend && bun run scripts/probe-mcp-registry-live.ts
//
// Optional: restrict to specific server names, e.g.
//   bun run scripts/probe-mcp-registry-live.ts filesystem context7

import { mapSearchResult } from '../src/routes/v1/mcp-registry';
import { MCPClient } from '../src/mcp/client';

const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
const QUERY = process.argv[2] ?? 'filesystem';
const ONLY = process.argv.slice(3);

interface RegistryListItem {
  server: {
    name: string;
    packages?: Array<Record<string, unknown>>;
    remotes?: Array<Record<string, unknown>>;
  };
}

async function search(q: string): Promise<RegistryListItem[]> {
  const params = new URLSearchParams({ search: q, limit: '30', version: 'latest' });
  const res = await fetch(`${REGISTRY_BASE_URL}/v0.1/servers?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`registry search returned ${res.status}`);
  const json = (await res.json()) as { servers?: RegistryListItem[] };
  return json.servers ?? [];
}

interface Outcome {
  name: string;
  transport: string;
  command: string | null;
  connected: boolean;
  toolCount: number;
  protocolVersion: string;
  durationMs: number;
  error?: string;
}

const outcomes: Outcome[] = [];

for (const item of await search(QUERY)) {
  const mapped = mapSearchResult(item);
  if (!mapped) continue;
  if (ONLY.length > 0 && !ONLY.some((n) => mapped.name.includes(n))) continue;

  // Only probe transports that need no credentials.
  const needsSecret =
    mapped.transport === 'sse'
      ? mapped.headerVars.length > 0
      : mapped.envVars.some((v) => v.isRequired);
  if (needsSecret) {
    console.log(`skip  ${mapped.name} — requires credentials`);
    continue;
  }

  const client = new MCPClient({
    name: mapped.name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64),
    transport: mapped.transport,
    command: mapped.command ?? undefined,
    args: mapped.args,
    url: mapped.url ?? undefined,
  });

  const started = Date.now();
  const outcome: Outcome = {
    name: mapped.name,
    transport: mapped.transport,
    command: mapped.command,
    connected: false,
    toolCount: 0,
    protocolVersion: '-',
    durationMs: 0,
  };

  try {
    await client.connect();
    outcome.connected = true;
    outcome.toolCount = client.availableTools.length;
    outcome.protocolVersion = client.negotiatedProtocolVersion;

    // A connection is only useful if a tool actually runs.
    const first = client.availableTools[0];
    if (first) {
      const result = await client.callTool(first.name, {});
      const text = result.content.find((c) => c.type === 'text')?.text ?? '';
      outcome.toolCount = outcome.toolCount;
      console.log(
        `ok    ${mapped.name} [${mapped.transport}] ${outcome.toolCount} tools, probe "${first.name}" -> ${
          result.isError ? 'tool-level error' : `${text.slice(0, 60)}`
        }`,
      );
    } else {
      console.log(`ok    ${mapped.name} [${mapped.transport}] connected, 0 tools advertised`);
    }
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    console.log(`FAIL  ${mapped.name} [${mapped.transport}] ${outcome.error}`);
  } finally {
    outcome.durationMs = Date.now() - started;
    outcomes.push(outcome);
    await client.shutdown();
  }
}

const connected = outcomes.filter((o) => o.connected).length;
console.log(`\n${connected}/${outcomes.length} registry servers connected (query="${QUERY}")`);
process.exit(connected > 0 ? 0 : 1);
