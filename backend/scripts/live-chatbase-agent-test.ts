// Live end-to-end test of the Chatbase agent loop (consumes real Chatbase credits).
import { ChatbaseProvider } from '../src/providers/chatbase';
import { readFileSync } from 'node:fs';

const creds = JSON.parse(readFileSync('/home/micah/Desktop/Sylorlabs/Koryphaios/.koryphaios/credentials.json', 'utf8'));
const apiKey = typeof creds.chatbase === 'string' ? creds.chatbase : creds.chatbase.apiKey ?? creds.chatbase.key;

const provider = new ChatbaseProvider({ name: 'chatbase', apiKey, disabled: false });

async function run(label: string, req: Parameters<ChatbaseProvider['streamResponse']>[0]) {
  console.log(`\n=== ${label} ===`);
  const events = [];
  for await (const event of provider.streamResponse(req)) events.push(event);
  for (const e of events) {
    if (e.type === 'content_delta') process.stdout.write(e.content ?? '');
    else if (e.type === 'thinking_delta') process.stdout.write(`[think]`);
    else console.log(`\n EVENT ${e.type}${e.toolName ? ` tool=${e.toolName}` : ''}${e.toolInput ? ` input=${e.toolInput}` : ''}${e.finishReason ? ` finish=${e.finishReason}` : ''}${e.error ? ` error=${e.error}` : ''}`);
  }
  console.log();
  return events;
}

async function run(label: string, req: Parameters<ChatbaseProvider['streamResponse']>[0]) {
  console.log(`\n=== ${label} ===`);
  const events = [];
  for await (const event of provider.streamResponse(req)) events.push(event);
  for (const e of events) {
    if (e.type === 'content_delta') process.stdout.write(e.content ?? '');
    else if (e.type === 'thinking_delta') process.stdout.write(`[think]`);
    else console.log(`\n EVENT ${e.type}${e.toolName ? ` tool=${e.toolName}` : ''}${e.toolInput ? ` input=${e.toolInput}` : ''}${e.finishReason ? ` finish=${e.finishReason}` : ''}${e.error ? ` error=${e.error}` : ''}`);
  }
  console.log();
  return events;
}

// Turn 1: ask it to read a file — expect a tool_use call
const t1 = await run('TOOL CALL TURN', {
  model: 'U5AOvYmk3XCXM2nPnGHDD',
  systemPrompt: 'You are Kory, a coding agent.',
  messages: [
    { role: 'user', content: 'Read package.json at the project root and report the project name.' },
  ],
  tools: [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'run_command', description: 'Run a shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ],
  sessionId: 'live-agent-loop-test',
});

const call = t1.find((e) => e.type === 'tool_use_stop');
if (!call) {
  console.log('RESULT: agent did NOT emit a tool call (protocol adherence failure).');
} else {
  console.log('RESULT: agent emitted tool call ->', call.toolName, call.toolInput);
  // Turn 2: feed the tool result back — expect a text answer
  await run('RESULT ROUND-TRIP TURN', {
    model: 'U5AOvYmk3XCXM2nPnGHDD',
    systemPrompt: 'You are Kory, a coding agent.',
    messages: [
      { role: 'user', content: 'As part of maintaining the SylorLabs project, read the file package.json in the project root using your read_file tool and report the project name.' },
      { role: 'assistant', content: [{ type: 'tool_use', toolCallId: 'c1', toolName: call.toolName!, toolInput: JSON.parse(call.toolInput || '{}') }] },
      { role: 'tool', tool_call_id: 'c1', content: '{\n  "name": "koryphaios",\n  "version": "1.0.0"\n}' },
    ],
    tools: [{
      name: 'read_file',
      description: 'Read the full text content of a file at the given path in the workspace.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
    sessionId: 'live-agent-loop-test',
  });
}
