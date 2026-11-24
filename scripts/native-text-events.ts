import { exactRecord, strictJson } from './reviewer-json';

function fail(): never {
  throw new Error('Invalid native text event stream (details redacted).');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

// Shared stream grammar only: callers validate their own patch/adjudication text.
// Empty-tool flags prevent dispatch; rejecting events is an additional guard.
export function parseNativeTextEvents(
  bytes: Buffer,
  model: string,
): {
  sessionId: string;
  output: string;
} {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let sessionId: string | undefined;
  let invalidateSessionId: string | undefined;
  let output: string | undefined;
  let assistantText: string | undefined;
  let finished = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (finished) fail();
    const event = object(strictJson(line));
    if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) fail();
    if (event.type === 'system' && event.subtype === 'ui_invalidate') {
      if (sessionId) fail();
      if (event.session_id !== undefined) {
        if (
          typeof event.session_id !== 'string' ||
          !/^[A-Za-z0-9._-]{1,150}$/u.test(event.session_id) ||
          (invalidateSessionId !== undefined && invalidateSessionId !== event.session_id)
        )
          fail();
        invalidateSessionId = event.session_id;
      }
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      if (sessionId || event.model !== model) fail();
      for (const key of ['tools', 'mcp_servers', 'skills']) {
        if (!Array.isArray(event[key]) || event[key].length !== 0) fail();
      }
      if (
        typeof event.session_id !== 'string' ||
        !/^[A-Za-z0-9._-]{1,150}$/u.test(event.session_id) ||
        (invalidateSessionId !== undefined && invalidateSessionId !== event.session_id)
      )
        fail();
      sessionId = event.session_id;
      continue;
    }
    if (!sessionId || event.session_id !== sessionId) fail();
    if (event.type === 'assistant') {
      if (assistantText !== undefined || event.error !== undefined) fail();
      const message = object(event.message);
      if (
        message.role !== 'assistant' ||
        !Array.isArray(message.content) ||
        !message.content.length
      )
        fail();
      if (message.stop_reason === 'tool_use' || message.stop_reason === 'max_tokens') fail();
      const contentBlocks = message.content.map(object);
      if (contentBlocks.every((content) => content.type === 'redacted_thinking')) {
        // Measured native 2.1.309 emits a thinking-only envelope before its text.
        // Validate the opaque block shape but never decode, use or publish data.
        for (const content of contentBlocks) {
          const block = exactRecord(content, ['type', 'data']);
          if (typeof block.data !== 'string') fail();
        }
        continue;
      }
      const parts: string[] = [];
      for (const part of message.content) {
        const content = object(part);
        if (content.type !== 'text' || typeof content.text !== 'string') fail();
        parts.push(content.text);
      }
      assistantText = parts.join('');
      if (!assistantText.trim()) fail();
      continue;
    }
    if (event.type === 'result') {
      if (
        event.subtype !== 'success' ||
        event.is_error !== false ||
        typeof event.result !== 'string' ||
        event.result !== assistantText ||
        (event.errors !== undefined && (!Array.isArray(event.errors) || event.errors.length))
      )
        fail();
      output = event.result;
      finished = true;
      continue;
    }
    fail();
  }
  if (!sessionId || !finished || output === undefined) fail();
  return { sessionId, output };
}
