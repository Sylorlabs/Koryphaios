import { CursorProvider } from '../src/providers/cursor';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';

const DIR = '/tmp/kory-cursor-agentic';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const p = new CursorProvider({ name: 'cursor', disabled: false } as any);
const fileEdits: any[] = [];
const tools: any[] = [];
let text = '';

for await (const e of p.streamResponse({
  model: 'cursor-agent',
  systemPrompt: 'You are a coding assistant.',
  messages: [{ role: 'user', content: 'Create a file named cur.txt containing exactly the word mango. Then change mango to kiwi.' }],
  workingDirectory: DIR,
} as any)) {
  if (e.type === 'file_edit') { fileEdits.push(e); console.log('FILE_EDIT', e.fileOperation, e.filePath?.split('/').pop(), 'content=', JSON.stringify(e.fileContent)); }
  else if (e.type === 'tool_executed') { tools.push(e); console.log('TOOL_EXECUTED', e.toolName, '->', (e.toolOutput || '').slice(0, 40)); }
  else if (e.type === 'content_delta') text += e.content ?? '';
  else if (e.type === 'complete') console.log('COMPLETE');
  else if (e.type === 'error') console.log('ERROR:', e.error);
}

console.log('\n=== SUMMARY ===');
console.log('file_edit:', fileEdits.length, '| tool_executed:', tools.length, '| text chars:', text.length);
console.log('cur.txt exists:', existsSync(`${DIR}/cur.txt`), '| contents:', existsSync(`${DIR}/cur.txt`) ? JSON.stringify(readFileSync(`${DIR}/cur.txt`, 'utf-8')) : 'N/A');
