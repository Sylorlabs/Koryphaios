// Koryphaios-as-an-MCP-server — a single HTTP endpoint (POST /mcp) that
// exposes Koryphaios's OWN tools (notes + memory) to any MCP-capable CLI
// (grok, claude-code, codex, cursor…). This is how a CLI harness that runs its
// own agentic loop can still read/write Koryphaios memory and the notes network
// instead of being a knowledge dead-end.
//
// Minimal spec-compliant JSON-RPC 2.0 over HTTP: initialize, tools/list,
// tools/call. No SSE/streaming needed — these tools are request/response.

import { getContext } from '../context';
import type { ToolContext } from '../tools/registry';
import { mcpLog } from '../logger';

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

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function exposedToolDefs() {
  const { kory } = getContext();
  const registry = (kory as unknown as { tools?: { getAll(): Array<{ name: string; description: string; inputSchema: unknown }> } }).tools;
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

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'koryphaios', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null; // notification, no reply

    case 'tools/list':
      return rpcResult(id, { tools: exposedToolDefs() });

    case 'tools/call': {
      const name = params?.name as string | undefined;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name || !MCP_EXPOSED_TOOLS.has(name)) {
        return rpcError(id, -32602, `Unknown or unexposed tool: ${name}`);
      }
      try {
        const { kory } = getContext();
        const registry = (kory as unknown as { tools: { execute(ctx: ToolContext, call: { id: string; name: string; input: Record<string, unknown> }): Promise<{ output: string; isError: boolean }> } }).tools;
        const ctx: ToolContext = {
          sessionId: `mcp-${Date.now()}`,
          workingDirectory,
          allowedPaths: [workingDirectory],
          isSandboxed: false,
          signal: new AbortController().signal,
        };
        const result = await registry.execute(ctx, { id: `mcp-${Date.now()}`, name, input: args });
        return rpcResult(id, {
          content: [{ type: 'text', text: result.output }],
          isError: result.isError,
        });
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
    req.headers.get('authorization') ?? (url.searchParams.get('auth') ? `Bearer ${url.searchParams.get('auth')}` : null);
  if (!validateToken(token)) {
    return new Response(JSON.stringify(rpcError(null, -32000, 'Unauthorized')), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Streamable-HTTP clients (grok's rmcp) open a GET for a server→client SSE
  // stream. We have no server-initiated messages, so decline it cleanly (405
  // is spec-allowed and tells the client "no SSE, POST only") — NOT a 401,
  // which some clients misread as an OAuth challenge.
  if (req.method === 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (req.method === 'DELETE') {
    return new Response(null, { status: 204 }); // session teardown — no-op, we're stateless
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const sessionHeader = req.headers.get('mcp-session-id') ?? 'koryphaios-mcp';
  const result = await handleMcpRequest(body, workingDirectory);
  if (result === null) {
    return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': sessionHeader } });
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
        'Mcp-Session-Id': sessionHeader,
      },
    });
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionHeader },
  });
}
