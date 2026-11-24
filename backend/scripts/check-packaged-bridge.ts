/**
 * Packaged-build check: spawn build/kory-mcp-bridge.js over real stdio against
 * a stub backend catalog and negotiate the MCP protocol (initialize →
 * tools/list). Run after `bun run build`. Exits non-zero on failure.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKoryBridgeGrant } from '../src/providers/bridge-grant';

const bridge = resolve(import.meta.dir, '../build/kory-mcp-bridge.js');
if (!existsSync(bridge)) {
  console.error(`FAIL: ${bridge} does not exist — run bun run build first`);
  process.exit(1);
}

const tools = [
  { name: 'kory__read_file', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'kory__bash', description: 'Run a command', inputSchema: { type: 'object' } },
];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === '/api/v1/mcp-bridge/catalog') return Response.json({ tools });
    return new Response('not found', { status: 404 });
  },
});

const grant = getKoryBridgeGrant('packaged-check', 'manager', ['mcp:catalog', 'mcp:execute']);
const proc = Bun.spawn([process.execPath, bridge, '--provider', 'devin'], {
  env: {
    ...process.env,
    KORY_BACKEND_URL: `http://127.0.0.1:${server.port}`,
    KORY_BRIDGE_AUTH_FILE: grant.path,
  },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});

const send = (msg: unknown) => proc.stdin.write(JSON.stringify(msg) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'packaged-check', version: '0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
proc.stdin.end();

const reader = proc.stdout.getReader();
let buf = '';
const responses: any[] = [];
const deadline = Date.now() + 15000;
while (Date.now() < deadline && responses.length < 2) {
  const { done, value } = await Promise.race([
    reader.read(),
    new Promise<{ done: boolean; value?: Uint8Array }>((r) =>
      setTimeout(() => r({ done: false }), 1000),
    ),
  ]);
  if (done) break;
  if (!value) continue;
  buf += new TextDecoder().decode(value);
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) responses.push(JSON.parse(line));
  }
}
proc.kill();
server.stop();

const init = responses.find((r) => r.id === 1);
const list = responses.find((r) => r.id === 2);
if (!init?.result?.serverInfo) {
  console.error('FAIL: no initialize result', JSON.stringify(responses));
  process.exit(1);
}
const names: string[] = list?.result?.tools?.map((t: { name: string }) => t.name) ?? [];
if (!names.includes('kory__read_file') || !names.includes('kory__bash')) {
  console.error('FAIL: tools/list missing kory tools', JSON.stringify(list));
  process.exit(1);
}
console.log(
  `OK: packaged bridge negotiated (server=${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol=${init.result.protocolVersion}), tools/list → ${names.join(', ')}`,
);
