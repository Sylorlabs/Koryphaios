// Messaging gateway: subscribes to wsBroker and forwards session-scoped events
// to the correct channel adapter. Channels register sessions when they submit a message.

import type { BrokerEvent } from "../pubsub";
import type { WSMessage } from "@koryphaios/shared";
import type { ChannelAdapter } from "./types";
import type { ReplySegment } from "./types";
import { wsBroker } from "../pubsub";
import { sessionReplyStream } from "./reply-stream";
import { messagingLog } from "../logger";

export class MessagingGateway {
  private sessionToAdapter = new Map<string, ChannelAdapter>();
  private reader: ReadableStreamDefaultReader<BrokerEvent<WSMessage>> | null = null;
  private running = false;

  /** Register a session with an adapter so replies are routed to it. */
  registerSession(sessionId: string, adapter: ChannelAdapter): void {
    this.sessionToAdapter.set(sessionId, adapter);
    messagingLog.debug({ sessionId, channelId: adapter.channelId }, "Session registered for messaging");
  }

  /** Unregister when a session is done (optional; also pruned on done event). */
  unregisterSession(sessionId: string): void {
    this.sessionToAdapter.delete(sessionId);
  }

  /** Start consuming wsBroker and forwarding to adapters. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const stream = wsBroker.subscribe();
    this.reader = stream.getReader();
    this.pump();
    messagingLog.info("Messaging gateway started");
  }

  private async pump(): Promise<void> {
    const r = this.reader;
    if (!r) return;
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        const msg = value.payload as WSMessage;
        const sessionId = msg.sessionId;
        if (!sessionId) continue;
        const adapter = this.sessionToAdapter.get(sessionId);
        if (!adapter) continue;

        const segment = this.toReplySegment(sessionId, msg);
        if (!segment) continue;

        sessionReplyStream.push(sessionId, segment);
        adapter.sendReply(sessionId, segment).catch((err) => {
          messagingLog.warn({ err, sessionId, channelId: adapter.channelId }, "Adapter sendReply failed");
        });

        if (segment.done) {
          this.sessionToAdapter.delete(sessionId);
        }
      }
    } catch (err) {
      messagingLog.error({ err }, "Messaging gateway pump error");
    } finally {
      this.running = false;
      this.reader = null;
    }
  }

  private toReplySegment(sessionId: string, msg: WSMessage): ReplySegment | null {
    const pl = msg.payload as Record<string, unknown>;
    switch (msg.type) {
      case "stream.delta":
        return {
          type: "delta",
          sessionId,
          content: typeof pl.content === "string" ? pl.content : undefined,
        };
      case "agent.status": {
        const status = pl.status as string;
        const done = status === "done";
        return {
          type: "status",
          sessionId,
          status,
          done,
        };
      }
      case "system.error":
        return {
          type: "error",
          sessionId,
          error: typeof pl.error === "string" ? pl.error : String(pl.error),
          done: true,
        };
      case "kory.thought":
        return {
          type: "status",
          sessionId,
          status: typeof pl.thought === "string" ? pl.thought : "",
        };
      default:
        return null;
    }
  }

  stop(): void {
    this.running = false;
    if (this.reader) {
      this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    this.sessionToAdapter.clear();
    messagingLog.info("Messaging gateway stopped");
  }
}

export const messagingGateway = new MessagingGateway();
