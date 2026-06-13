import { ClaudeCodeProvider } from '../src/providers/claude-code';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';

const DIR = '/tmp/kory-agentic-test';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const p = new ClaudeCodeProvider({ name: 'claude', disabled: false } as any);
const fileEdits: any[] = [];
const tools: any[] = [];
let text = '';

for await (const e of p.streamResponse({
  model: 'claude-code-sonnet',
  systemPrompt: 'You are a coding assistant. Use your tools to do exactly what is asked.',
  messages: [{ role: 'user', content: 'Create a file named pwagent.txt containing exactly the word mango. Then use Edit to change mango to kiwi.' }],
  workingDirectory: DIR,
} as any)) {
  if (e.type === 'file_edit') { fileEdits.push(e); console.log('FILE_EDIT', e.fileOperation, e.filePath?.split('/').pop(), 'content=', JSON.stringify(e.fileContent), 'old=', JSON.stringify(e.fileOldContent)); }
  else if (e.type === 'tool_executed') { tools.push(e); console.log('TOOL_EXECUTED', e.toolName, 'err=', e.isError, '->', (e.toolOutput || '').slice(0, 50)); }
  else if (e.type === 'content_delta') text += e.content ?? '';
  else if (e.type === 'complete') console.log('COMPLETE');
  else if (e.type === 'error') console.log('ERROR:', e.error);
}

console.log('\n=== SUMMARY ===');
console.log('file_edit events:', fileEdits.length, '| tool_executed:', tools.length);
console.log('text streamed (chars):', text.length);
console.log('pwagent.txt exists:', existsSync(`${DIR}/pwagent.txt`), '| contents:', existsSync(`${DIR}/pwagent.txt`) ? JSON.stringify(readFileSync(`${DIR}/pwagent.txt`, 'utf-8')) : 'N/A');
