// Fake ACP agent used by the acp:<id> tests. It is a standalone CommonJS program
// that speaks newline-delimited JSON-RPC 2.0 over stdio, like a real ACP agent.
// Behaviour is steered by environment variables so one script covers the cases:
//
//   FAKE_ACP_STATE      file that records what the agent received (session/new, config, permissions)
//   FAKE_ACP_PROTOCOL   protocolVersion to answer with (default 1)
//   FAKE_ACP_MODELS     comma list of model ids offered in configOptions (default two models;
//                       empty string offers no model option)
//   FAKE_ACP_MODE       normal | exit-init | hang-init | hang-prompt

export const FAKE_ACP_AGENT_SOURCE = String.raw`
const readline = require('readline');
const fs = require('fs');
const statePath = process.env.FAKE_ACP_STATE;
const protocol = Number(process.env.FAKE_ACP_PROTOCOL || 1);
const modelList = (process.env.FAKE_ACP_MODELS === undefined ? 'fake-small,fake-large' : process.env.FAKE_ACP_MODELS)
  .split(',').map((s) => s.trim()).filter(Boolean);
const mode = process.env.FAKE_ACP_MODE || 'normal';

function readState() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { return {}; } }
function record(patch) { if (statePath) fs.writeFileSync(statePath, JSON.stringify({ ...readState(), ...patch })); }
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

if (mode === 'exit-init') process.exit(3);

const sessions = new Map();
const pendingPermission = new Map();
let permissionSeq = 0;

function ask(params) {
  const rid = 'perm-' + (++permissionSeq);
  return new Promise((resolve) => {
    pendingPermission.set(rid, resolve);
    send({ jsonrpc: '2.0', id: rid, method: 'session/request_permission', params });
  });
}

const options = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  // Response to one of our permission requests.
  if (msg.id !== undefined && !msg.method) {
    const resolve = pendingPermission.get(String(msg.id));
    if (resolve) { pendingPermission.delete(String(msg.id)); resolve(msg.result); }
    return;
  }
  const id = msg.id;
  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      if (mode === 'hang-init') return;
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: protocol,
        agentCapabilities: { promptCapabilities: { image: false, embeddedContext: false } },
        agentInfo: { name: 'fake-acp', version: '0.0.1' },
        authMethods: [],
      } });
      return;
    case 'session/new': {
      const sid = 'ses_' + (sessions.size + 1);
      sessions.set(sid, {});
      record({ newSession: { cwd: params.cwd, mcpServers: params.mcpServers || [] } });
      const configOptions = [];
      if (modelList.length > 0) {
        configOptions.push({ id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: modelList[0], options: modelList.map((v) => ({ value: v, name: v })) });
      }
      configOptions.push({ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build',
        options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] });
      send({ jsonrpc: '2.0', id, result: { sessionId: sid, configOptions } });
      return;
    }
    case 'session/set_config_option': {
      const state = readState();
      record({ config: { ...(state.config || {}), [params.configId]: params.value } });
      send({ jsonrpc: '2.0', id, result: { configOptions: [] } });
      return;
    }
    case 'session/close':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'session/cancel':
      return;
    case 'session/prompt': {
      if (mode === 'hang-prompt') return;
      const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: u } });
      (async () => {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
        update({ sessionUpdate: 'tool_call', toolCallId: 't-edit', name: 'write_file', title: 'Write file',
          kind: 'edit', status: 'pending', rawInput: { path: 'x.txt', content: 'nope' } });
        const editResult = await ask({ sessionId: params.sessionId,
          toolCall: { toolCallId: 't-edit', name: 'write_file', title: 'Write file', kind: 'edit', status: 'pending' },
          options });
        record({ editPermission: editResult });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't-edit', status: 'failed', rawOutput: 'blocked by policy' });

        const readResult = await ask({ sessionId: params.sessionId,
          toolCall: { toolCallId: 't-read', name: 'read_file', title: 'Read file', kind: 'read', status: 'pending' },
          options });
        record({ readPermission: readResult });
        update({ sessionUpdate: 'tool_call', toolCallId: 't-read', name: 'read_file', kind: 'read',
          status: 'in_progress', rawInput: { path: 'a.txt' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't-read', name: 'read_file', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'file body' } }] });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from fake agent' } });
        update({ sessionUpdate: 'usage_update', used: 42, size: 1000 });
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } });
      })();
      return;
    }
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method ' + msg.method } });
  }
});
`;
