// Koryphaios-as-an-MCP-server — a single HTTP endpoint (POST /mcp) that
// exposes Koryphaios's OWN tools (notes + memory) to any MCP-capable CLI
// (grok, claude-code, codex, cursor…). This is how a CLI harness that runs its
// own agentic loop can still read/write Koryphaios memory and the notes network
// instead of being a knowledge dead-end.
//
// Implements the 2026-07-28 MCP specification (stateless, server/discover,
// per-request _meta, resultType, Mcp-Method/Mcp-Name headers) while remaining
// backward-compatible with legacy clients via the initialize path.

import { getContext } from '../context';
import type { ToolContext } from '../tools/registry';
import { mcpLog, serverLog } from '../logger';
import { VERSION } from '../constants';
import { loadAgentSettings } from '../agent-settings';
import { resolveToolPermissionPolicy, resolveSandboxOptions } from '../tools/permission-policy';

// Only Koryphaios's KNOWLEDGE tools are exposed over MCP — file edits and shell
// stay with each CLI's native tools (their strength); this is purely so CLIs
// can contribute to memory/notes and read project rules.
const MCP_EXPOSED_TOOLS = new Set([
  'create_note',
  'update_note',
  'read_note',
  'search_notes',
  'recall_notes',
  'list_notes',
  'link_notes',
  'get_note_backlinks',
]);

const CURRENT_PROTOCOL_VERSION = '2026-07-28';
const FALLBACK_PROTOCOL_VERSION = '2025-11-25';
const OLDEST_PROTOCOL_VERSION = '2024-11-05';
// All versions this server supports (for initialize negotiation).
const SUPPORTED_PROTOCOL_VERSIONS = [
  CURRENT_PROTOCOL_VERSION,
  '2025-11-25',
  '2025-06-18',
  OLDEST_PROTOCOL_VERSION,
];
// Only modern (2026-07-28+) versions are advertised via server/discover.
// 2025-era versions are negotiated via the initialize fallback.
const MODERN_PROTOCOL_VERSIONS = [CURRENT_PROTOCOL_VERSION];

// Cache hints for list responses (2026-07-28 CacheableResult). Tools change
// rarely; 60s freshness with private scope (per-user tool set).
const LIST_TTL_MS = 60_000;
const LIST_CACHE_SCOPE = 'private';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function clientProtocolVersion(body: JsonRpcRequest): string | undefined {
  const meta = body._meta;
  if (!meta) return undefined;
  const v = meta['io.modelcontextprotocol/protocolVersion'];
  return typeof v === 'string' ? v : undefined;
}

/** Build a JSON-RPC success response. For 2026-07-28 clients, stamps
 *  `serverInfo` into `result._meta` per spec PR #3002 (servers SHOULD identify
 *  themselves on every response). Legacy clients get `resultType: complete`
 *  which they ignore. */
function rpcResult(id: unknown, result: Record<string, unknown>, isModernClient: boolean) {
  const base: Record<string, unknown> = { ...result, resultType: 'complete' };
  if (isModernClient) {
    base._meta = {
      ...(base._meta as Record<string, unknown> | undefined),
      'io.modelcontextprotocol/serverInfo': { name: 'koryphaios', version: VERSION },
    };
  }
  return { jsonrpc: '2.0', id: id ?? null, result: base };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function exposedToolDefs() {
  const { kory } = getContext();
  const registry = (
    kory as unknown as {
      tools?: { getAll(): Array<{ name: string; description: string; inputSchema: unknown }> };
    }
  ).tools;
  const all = registry?.getAll?.() ?? [];
  return all
    .filter((t) => MCP_EXPOSED_TOOLS.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Handle one MCP JSON-RPC request. Returns the response body (or null for a
 *  notification that needs no reply). */
export async function handleMcpRequest(
  body: JsonRpcRequest,
  workingDirectory: string,
): Promise<unknown | null> {
  const { method, id, params } = body;
  const isModernClient = clientProtocolVersion(body) === CURRENT_PROTOCOL_VERSION;

  switch (method) {
    // ── 2026-07-28: server/discover (replaces initialize for capability probe) ──
    // Returns only modern (2026-07-28+) versions in `supportedVersions`.
    // 2025-era versions are negotiated via the initialize fallback.
    // serverInfo is NOT a top-level field here — it's stamped into _meta by
    // rpcResult for modern clients (spec PR #3002).
    case 'server/discover':
      return rpcResult(
        id,
        {
          supportedVersions: MODERN_PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
        },
        isModernClient,
      );

    // ── Legacy initialize: 2025-11-25 is the supported fallback; the older
    // 2024-11-05 revision remains accepted for existing local clients. ──
    // InitializeResultSchema has serverInfo as a top-level field (unlike
    // server/discover, which puts it in _meta).
    case 'initialize': {
      const requested = clientProtocolVersion(body) ?? FALLBACK_PROTOCOL_VERSION;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : FALLBACK_PROTOCOL_VERSION;
      return rpcResult(
        id,
        {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: 'koryphaios', version: VERSION },
        },
        isModernClient,
      );
    }

    case 'notifications/initialized':
      return null; // notification, no reply (legacy only)

    case 'tools/list':
      return rpcResult(
        id,
        {
          tools: exposedToolDefs(),
          ttlMs: LIST_TTL_MS,
          cacheScope: LIST_CACHE_SCOPE,
        },
        isModernClient,
      );

    case 'tools/call': {
      const name = params?.name as string | undefined;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name || !MCP_EXPOSED_TOOLS.has(name)) {
        return rpcError(id, -32602, `Unknown or unexposed tool: ${name}`);
      }
      try {
        const { kory } = getContext();
        const registry = (
          kory as unknown as {
            tools: {
              execute(
                ctx: ToolContext,
                call: { id: string; name: string; input: Record<string, unknown> },
              ): Promise<{ output: string; isError: boolean }>;
            };
          }
        ).tools;
        const ctx: ToolContext = {
          sessionId: `mcp-${Date.now()}`,
          workingDirectory,
          allowedPaths: [workingDirectory],
          isSandboxed: false,
          sandboxOptions: resolveSandboxOptions(loadAgentSettings(workingDirectory), false),
          permissionPolicy: resolveToolPermissionPolicy(loadAgentSettings(workingDirectory), 'act'),
          approvedToolCallIds: new Set(),
          signal: new AbortController().signal,
        };
        const result = await registry.execute(ctx, { id: `mcp-${Date.now()}`, name, input: args });
        return rpcResult(
          id,
          {
            content: [{ type: 'text', text: result.output }],
            isError: result.isError,
          },
          isModernClient,
        );
      } catch (err) {
        mcpLog.warn({ err, tool: name }, 'MCP tool call failed');
        return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Bun.serve fetch integration: POST /mcp. Auth via the local bearer token
 *  (header or ?auth=) so only this machine's CLIs can reach it. */
export async function serveMcp(
  req: Request,
  workingDirectory: string,
  validateToken: (t: string | null) => boolean,
): Promise<Response> {
  const url = new URL(req.url);
  const token =
    req.headers.get('authorization') ??
    (url.searchParams.get('auth') ? `Bearer ${url.searchParams.get('auth')}` : null);
  if (!validateToken(token)) {
    return new Response(JSON.stringify(rpcError(null, -32000, 'Unauthorized')), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // 2026-07-28: subscriptions/listen replaces the GET SSE stream. We have no
  // server-initiated messages, so decline cleanly (405 is spec-allowed). Legacy
  // clients that GET for an SSE stream also get 405 — same behavior as before.
  if (req.method === 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (req.method === 'DELETE') {
    // 2026-07-28 removed protocol-level sessions; DELETE is a no-op teardown.
    return new Response(null, { status: 204 });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 2026-07-28: validate Mcp-Method/Mcp-Name headers on streamable HTTP POSTs.
  // Legacy clients don't send these, so only enforce when the
  // client advertises the current protocol version in _meta — which we can only
  // read after parsing the body. Header presence is checked softly: if absent,
  // we still process the request (backward compat) but log a debug note.
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'MCP endpoint failed to parse request body',
    );
    return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const mcpMethodHeader = req.headers.get('mcp-method');
  const advertisedVersion = clientProtocolVersion(body);
  if (advertisedVersion === CURRENT_PROTOCOL_VERSION && !mcpMethodHeader) {
    // Current-spec clients MUST send Mcp-Method. Legacy clients are exempt.
    return new Response(
      JSON.stringify(rpcError(body.id ?? null, -32020, 'Missing required Mcp-Method header')),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  if (mcpMethodHeader && mcpMethodHeader !== body.method) {
    return new Response(
      JSON.stringify(
        rpcError(body.id ?? null, -32020, 'Mcp-Method header does not match JSON-RPC method'),
      ),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const result = await handleMcpRequest(body, workingDirectory);
  if (result === null) {
    // Notification: no reply body. 2026-07-28 dropped Mcp-Session-Id.
    return new Response(null, { status: 202 });
  }

  // Streamable-HTTP clients (grok's rmcp) send `Accept: text/event-stream` and
  // expect the JSON-RPC response framed as a single SSE `message` event, then
  // the stream closes. Honor that; fall back to plain JSON for simple clients.
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/event-stream')) {
    const sse = `event: message\ndata: ${JSON.stringify(result)}\n\n`;
    return new Response(sse, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
