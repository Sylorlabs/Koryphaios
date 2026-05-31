// Streaming Response Handler
// Makes AI feel responsive by streaming tokens, thoughts, and file changes

import type { WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../pubsub';
import { serverLog } from '../logger';

export interface StreamEvent {
  type: 'thought' | 'token' | 'tool_call' | 'tool_result' | 'file_change' | 'complete' | 'error';
  payload: unknown;
  timestamp: number;
  sessionId: string;
  agentId?: string;
}

export interface ThoughtChunk {
  text: string;
  stage: 'understanding' | 'planning' | 'executing' | 'reflecting';
  confidence?: number;
}

export interface TokenChunk {
  content: string;
  isCode?: boolean;
  language?: string;
}

export interface FileChangeEvent {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  diff?: string;
  preview?: string;
}

/**
 * Streams AI responses in real-time
 */
export class StreamingResponseHandler {
  private activeStreams = new Map<string, boolean>();

  /**
   * Start a new streaming response
   */
  startStream(sessionId: string, agentId: string): StreamController {
    const streamId = `${sessionId}-${Date.now()}`;
    this.activeStreams.set(streamId, true);

    return new StreamController(streamId, sessionId, agentId, (id) => {
      this.activeStreams.delete(id);
    });
  }

  /**
   * Check if stream is still active
   */
  isActive(streamId: string): boolean {
    return this.activeStreams.get(streamId) ?? false;
  }

  /**
   * Cancel all streams for a session
   */
  cancelSessionStreams(sessionId: string): void {
    for (const [streamId, active] of this.activeStreams) {
      if (streamId.startsWith(sessionId)) {
        this.activeStreams.delete(streamId);
      }
    }
  }
}

/**
 * Controls an individual stream
 */
export class StreamController {
  private buffer: StreamEvent[] = [];
  private flushInterval?: NodeJS.Timeout;
  private lastFlush = Date.now();

  constructor(
    private streamId: string,
    private sessionId: string,
    private agentId: string,
    private onClose: (streamId: string) => void,
  ) {
    // Flush buffer every 50ms for smooth UI
    this.flushInterval = setInterval(() => this.flush(), 50);
  }

  /**
   * Stream a thought/process update
   */
  thought(text: string, stage: ThoughtChunk['stage'] = 'executing', confidence?: number): void {
    this.emit({
      type: 'thought',
      payload: { text, stage, confidence } as ThoughtChunk,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
  }

  /**
   * Stream a content token (for natural language responses)
   */
  token(content: string, isCode = false, language?: string): void {
    this.emit({
      type: 'token',
      payload: { content, isCode, language } as TokenChunk,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
  }

  /**
   * Announce a tool call starting
   */
  toolCall(toolName: string, input: unknown): void {
    this.emit({
      type: 'tool_call',
      payload: { tool: toolName, input, status: 'started' },
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
  }

  /**
   * Stream tool result
   */
  toolResult(toolName: string, result: unknown, durationMs: number): void {
    this.emit({
      type: 'tool_result',
      payload: { tool: toolName, result, durationMs },
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
  }

  /**
   * Stream a file change (with diff preview)
   */
  fileChange(
    path: string,
    operation: FileChangeEvent['operation'],
    diff?: string,
    preview?: string,
  ): void {
    this.emit({
      type: 'file_change',
      payload: { path, operation, diff, preview } as FileChangeEvent,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
  }

  /**
   * Mark stream as complete
   */
  complete(summary?: string): void {
    this.emit({
      type: 'complete',
      payload: { summary, totalTokens: 0 },
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
    this.close();
  }

  /**
   * Stream an error
   */
  error(message: string, recoverable = false): void {
    this.emit({
      type: 'error',
      payload: { message, recoverable },
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
    if (!recoverable) {
      this.close();
    }
  }

  /**
   * Emit event immediately or buffer
   */
  private emit(event: StreamEvent): void {
    // Buffer thoughts, stream tokens immediately
    if (event.type === 'thought') {
      this.buffer.push(event);
    } else {
      // Flush buffer first to maintain order
      if (this.buffer.length > 0) {
        this.flush();
      }
      this.broadcast(event);
    }
  }

  /**
   * Flush buffered events
   */
  private flush(): void {
    if (this.buffer.length === 0) return;

    // Batch thoughts that happened in same window
    const thoughts = this.buffer.filter((e) => e.type === 'thought');
    if (thoughts.length > 0) {
      // Only send the latest thought to avoid spam
      const latest = thoughts[thoughts.length - 1];
      this.broadcast(latest);
    }

    this.buffer = [];
    this.lastFlush = Date.now();
  }

  /**
   * Broadcast to WebSocket clients
   */
  private broadcast(event: StreamEvent): void {
    const wsMessage: WSMessage = {
      type: 'stream.delta',
      payload: event,
      timestamp: event.timestamp,
      sessionId: this.sessionId,
      agentId: this.agentId,
    };

    wsBroker.publish('custom', wsMessage);
  }

  /**
   * Close the stream
   */
  close(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = undefined;
    }
    this.flush(); // Final flush
    this.onClose(this.streamId);
  }
}

// Export singleton
export const streamingHandler = new StreamingResponseHandler();
