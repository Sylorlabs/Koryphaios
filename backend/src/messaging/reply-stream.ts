// Per-session reply queue for channel reply streaming (SSE/poll).
// Bridge devices can consume replies via GET /api/channels/replies?sessionId=...

import type { ReplySegment } from "./types";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

interface SessionQueue {
  segments: ReplySegment[];
  createdAt: number;
}

export class SessionReplyStream {
  private sessions = new Map<string, SessionQueue>();
  private listeners = new Map<string, ReadableStreamDefaultController<ReplySegment>[]>();

  push(sessionId: string, segment: ReplySegment): void {
    let q = this.sessions.get(sessionId);
    if (!q) {
      q = { segments: [], createdAt: Date.now() };
      this.sessions.set(sessionId, q);
    }
    q.segments.push(segment);

    const list = this.listeners.get(sessionId);
    if (list) {
      for (const ctrl of list) {
        try {
          ctrl.enqueue(segment);
        } catch {
          list.splice(list.indexOf(ctrl), 1);
        }
      }
    }

    if (segment.done) {
      this.listeners.delete(sessionId);
      setTimeout(() => this.dropSession(sessionId), 5000);
    }
  }

  /** Get all segments so far and optionally stream new ones (SSE). */
  getStream(sessionId: string): ReadableStream<ReplySegment> {
    const self = this;
    return new ReadableStream<ReplySegment>({
      start(controller) {
        const q = self.sessions.get(sessionId);
        if (q) {
          for (const seg of q.segments) {
            controller.enqueue(seg);
            if (seg.done) {
              controller.close();
              return;
            }
          }
        }
        let list = self.listeners.get(sessionId);
        if (!list) {
          list = [];
          self.listeners.set(sessionId, list);
        }
        list.push(controller);
      },
      cancel() {
        // Controller will be removed when push() enqueue fails (stream closed)
      },
    });
  }

  /** Get pending segments (for polling). Does not remove them. */
  getPending(sessionId: string): ReplySegment[] {
    const q = this.sessions.get(sessionId);
    return q ? [...q.segments] : [];
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.listeners.delete(sessionId);
  }

  /** Prune old sessions (call periodically if needed). */
  prune(): void {
    const now = Date.now();
    for (const [id, q] of this.sessions) {
      if (now - q.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.listeners.delete(id);
      }
    }
  }
}

export const sessionReplyStream = new SessionReplyStream();
