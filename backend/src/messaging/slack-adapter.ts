// Slack channel adapter: sends reply segments as Slack messages.
// Session id format: slack-<channelId> so one channel = one conversation.

import type { WebClient } from "@slack/web-api";
import type { ChannelAdapter, ReplySegment } from "./types";
import { CHANNEL_PREFIX } from "./types";
import { slackLog } from "../logger";

const MAX_MESSAGE_LENGTH = 3000;

export class SlackAdapter implements ChannelAdapter {
  readonly sessionIdPrefix = CHANNEL_PREFIX.slack;
  readonly channelId = "slack";
  readonly webClient: WebClient;
  private sessionToChannel = new Map<string, { channelId: string; threadTs?: string }>();
  private buffer = new Map<string, string>();

  constructor(webClient: WebClient) {
    this.webClient = webClient;
  }

  setChannel(sessionId: string, channelId: string, threadTs?: string): void {
    this.sessionToChannel.set(sessionId, { channelId, threadTs });
  }

  async sendReply(sessionId: string, segment: ReplySegment): Promise<void> {
    const target = this.sessionToChannel.get(sessionId);
    if (!target) {
      slackLog.debug({ sessionId }, "No channel for session, skipping reply");
      return;
    }

    if (segment.type === "error") {
      await this.send(target.channelId, `❌ ${segment.error ?? "Error"}`, target.threadTs);
      return;
    }

    if (segment.type === "delta" && segment.content) {
      let buf = this.buffer.get(sessionId) ?? "";
      buf += segment.content;
      this.buffer.set(sessionId, buf);
    }

    if (segment.type === "status" && segment.done) {
      const text = this.buffer.get(sessionId)?.trim();
      this.buffer.delete(sessionId);
      this.sessionToChannel.delete(sessionId);
      if (text) {
        await this.send(target.channelId, text, target.threadTs);
      }
    }
  }

  private async send(channelId: string, text: string, threadTs?: string): Promise<void> {
    try {
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.webClient.chat.postMessage({
          channel: channelId,
          text,
          thread_ts: threadTs,
          mrkdwn: true,
        });
        return;
      }

      const chunks = this.splitMessage(text);
      for (const chunk of chunks) {
        await this.webClient.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs,
          mrkdwn: true,
        });
      }
    } catch (err) {
      slackLog.warn({ err, channelId }, "Slack send failed");
    }
  }

  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitIdx <= 0) splitIdx = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx);
    }
    return chunks;
  }
}
