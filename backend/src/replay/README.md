# Message Replay Buffer

Event sourcing system for agent conversations in Koryphaios.

## Overview

The Message Replay Buffer provides a complete event sourcing system for tracking, replaying, and analyzing agent conversations. It enables:

- **Complete conversation history**: Every interaction is stored as an immutable event
- **Timeline reconstruction**: Rebuild conversation state at any point
- **Session forking**: Create branches from any point in a conversation
- **Export/Import**: Share and archive conversations
- **Replay with control**: Step through conversations with breakpoints

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ReplayBuffer                           │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ EventStore   │  │ ReplayPlayer │  │Conversation      │  │
│  │              │  │              │  │Exporter          │  │
│  │ • append()   │  │ • play()     │  │                  │  │
│  │ • getEvents()│  │ • pause()    │  │ • exportToFile() │  │
│  │ • replay()   │  │ • step()     │  │ • exportShareable│  │
│  │ • fork()     │  │              │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
                   ┌──────────────────┐
                   │  replay_events   │
                   │  (SQLite/Postgres)│
                   └──────────────────┘
```

## Usage

### Basic Event Logging

```typescript
import { getReplayBuffer } from './replay';

const buffer = getReplayBuffer();

// Log user message
await buffer.appendUserMessage(sessionId, 'Hello, how are you?');

// Log LLM response
await buffer.appendLLMResponse(
  sessionId,
  "I'm doing well! How can I help you today?",
  'claude-3-opus',
  'anthropic',
  tokensIn,
  tokensOut,
  latencyMs,
);

// Log tool calls
await buffer.appendToolCall(sessionId, 'read_file', { path: '/tmp/test.txt' }, 'call-1');
await buffer.appendToolResult(sessionId, 'read_file', 'File contents', false, 100, 'call-1');
```

### Replaying Events

```typescript
// Replay entire conversation
const state = await buffer.replay(sessionId);
console.log(state.messages); // All messages in order
console.log(state.toolCalls); // All tool calls made

// Replay up to specific point
const stateAt = await buffer.replay(sessionId, 5); // Up to sequence 5
```

### Timeline View

```typescript
// Get full timeline
const timeline = await buffer.getTimeline(sessionId);

// Filtered timeline
const userMessages = await buffer.getTimeline(sessionId, {
  types: ['user_message'],
  startSequence: 10,
  endSequence: 20,
});
```

### Forking Conversations

```typescript
// Fork at sequence 5
await buffer.fork(sourceSessionId, 5, newSessionId);

// Fork with marker event
await buffer.forkWithMarker(
  sourceSessionId,
  5,
  newSessionId,
  'Forked before controversial response',
);
```

### Replay Player (with breakpoints)

```typescript
import { ReplayPlayer } from './replay';

const player = new ReplayPlayer();
const events = await eventStore.getEvents(sessionId);

// Set breakpoints
player.setBreakpoints(['tool_call', 'llm_response']);

// Play with control
for await (const state of player.play(events, { speed: 'normal' })) {
  console.log(`At sequence ${state.currentSequence}`);

  if (state.isPaused) {
    // Handle pause at breakpoint
    await showBreakpointUI(state.currentEvent);
    player.resume();
  }
}
```

### Export/Import

```typescript
// Export to JSON
const json = await buffer.exportSession(sessionId);
await fs.writeFile('conversation.json', json);

// Import from JSON
await buffer.importSession(jsonString, newSessionId);

// Export shareable (stripped) version
const exporter = getConversationExporter();
const shareable = await exporter.exportShareable(sessionId);
```

## Event Types

| Type           | Description           | Payload                                              |
| -------------- | --------------------- | ---------------------------------------------------- |
| `user_message` | User input            | `{ content: string, attachments?: [...] }`           |
| `llm_request`  | Request to LLM        | `{ model, messages, temperature, ... }`              |
| `llm_response` | Response from LLM     | `{ content, model, tokensIn, tokensOut, latencyMs }` |
| `tool_call`    | Tool invocation       | `{ toolName, input, callId }`                        |
| `tool_result`  | Tool execution result | `{ toolName, output, isError, durationMs }`          |
| `state_change` | State mutation        | `{ key, previousValue, newValue, reason }`           |

## Database Schema

```sql
CREATE TABLE replay_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON
  parent_event_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_replay_events_session ON replay_events(session_id, sequence);
CREATE INDEX idx_replay_events_type ON replay_events(type);
CREATE INDEX idx_replay_events_parent ON replay_events(parent_event_id);
```

## Key Design Principles

1. **Immutable Events**: Events are never updated, only appended
2. **Per-Session Sequences**: Sequence numbers auto-increment within each session
3. **Fork Support**: Events can reference parent events for branching
4. **Efficient Queries**: Indexed by session, sequence, type for fast retrieval
5. **JSON Payloads**: Flexible schema for different event types

## Integration Points

The replay buffer integrates with:

- **KoryManager**: Logs all agent interactions
- **Session Store**: Enables export/import of sessions
- **Debug UI**: Provides timeline visualization
- **Analytics**: Powers conversation analysis

## Testing

```bash
# Run replay buffer tests
bun test backend/src/replay/replay.test.ts
```

## API Reference

See `types.ts` for complete type definitions.
