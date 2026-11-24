/**
 * Chat findings saved as sourced notes.
 *
 * A chat finding captures one reviewed statement from a conversation as a
 * durable note. Unlike free text copied by hand, the provenance block is
 * host-recorded (session, message, role, provider/model, timestamp) so the
 * note can be cited later and never pretends to be more than what the chat
 * actually said.
 */

import type { ChatFindingInput } from '@koryphaios/shared';

export interface BuiltChatFinding {
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
}

const MAX_TITLE_CHARS = 240;
const MAX_BODY_CHARS = 8_000;

function cleanScalar(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function inlineCode(value: string): string {
  const longestFence = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(longestFence + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

export function buildChatFinding(
  input: ChatFindingInput,
  recordedAt: Date = new Date(),
): BuiltChatFinding {
  const title = cleanScalar(input.title, MAX_TITLE_CHARS);
  const body = cleanScalar(input.body, MAX_BODY_CHARS);
  const sessionId = cleanScalar(input.source.sessionId, 2048);
  if (!title) throw new Error('Chat finding title is required');
  if (!body) throw new Error('Chat finding body is required');
  if (!sessionId) throw new Error('Chat finding session provenance is required');

  const provenanceRows = [
    ['Session', inlineCode(sessionId)],
    input.source.messageId
      ? ['Message', inlineCode(cleanScalar(input.source.messageId, 240))]
      : null,
    input.source.role ? ['Role', inlineCode(cleanScalar(input.source.role, 120))] : null,
    input.source.provider
      ? ['Provider', inlineCode(cleanScalar(input.source.provider, 240))]
      : null,
    input.source.model ? ['Model', inlineCode(cleanScalar(input.source.model, 240))] : null,
    ['Recorded', inlineCode(recordedAt.toISOString())],
  ].filter((row): row is string[] => Boolean(row));

  const lines = [
    `# ${title}`,
    '',
    '> **CHAT FINDING** · Saved from a Koryphaios chat with source provenance',
    '',
    '## Finding',
    '',
    body,
    '',
    '## Provenance',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...provenanceRows.map(([label, value]) => `| ${label} | ${value} |`),
  ];

  return {
    title,
    content: lines.join('\n').trimEnd() + '\n',
    folderPath: '/Findings',
    tags: ['chat-finding', 'sourced'],
  };
}
