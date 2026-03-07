// Discord channel adapter: sends reply segments as Discord messages.
// Session id format: discord-<channelId> so one channel = one conversation.

import type { Client, TextChannel } from "discord.js";
import type { ChannelAdapter, ReplySegment } from "./types";
import { CHANNEL_PREFIX } from "./types";
import { discordLog } from "../logger";

const MAX_MESSAGE_LENGTH = 2000;

export class DiscordAdapter implements ChannelAdapter {
  readonly sessionIdPrefix = CHANNEL_PREFIX.discord;
  readonly channelId = "discord";
  readonly client: Client;
  private sessionToChannelId = new Map<string, string>();
  private buffer = new Map<string, string>();

  constructor(client: Client) {
    this.client = client;
  }

  setChannelId(sessionId: string, channelId: string): void {
    this.sessionToChannelId.set(sessionId, channelId);
  }

  async sendReply(sessionId: string, segment: ReplySegment): Promise<void> {
    const channelId = this.sessionToChannelId.get(sessionId);
    if (!channelId) {
      discordLog.debug({ sessionId }, "No channelId for session, skipping reply");
      return;
    }

    if (segment.type === "error") {
      await this.send(channelId, `❌ ${segment.error ?? "Error"}`);
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
      this.sessionToChannelId.delete(sessionId);
      if (text) {
        await this.send(channelId, text);
      }
    }
  }

  private async send(channelId: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) {
        discordLog.warn({ channelId }, "Channel not found or not text-based");
        return;
      }
      const textChannel = channel as TextChannel;

      if (text.length <= MAX_MESSAGE_LENGTH) {
        await textChannel.send(text);
        return;
      }

      // Split into chunks respecting code blocks
      const chunks = this.splitMessage(text);
      for (const chunk of chunks) {
        await textChannel.send(chunk);
      }
    } catch (err) {
      discordLog.warn({ err, channelId }, "Discord send failed");
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
      // Try to split at newline near the limit
      let splitIdx = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitIdx <= 0) splitIdx = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx);
    }
    return chunks;
  }
}
