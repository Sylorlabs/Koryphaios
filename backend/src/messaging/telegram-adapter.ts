// Telegram channel adapter: sends reply segments as Telegram messages.
// Session id format: telegram-<chatId> so one chat = one conversation.

import type { Bot } from "grammy";
import type { ChannelAdapter } from "./types";
import type { ReplySegment } from "./types";
import { CHANNEL_PREFIX } from "./types";
import { telegramLog } from "../logger";

const MAX_MESSAGE_LENGTH = 4000;

export class TelegramAdapter implements ChannelAdapter {
  readonly sessionIdPrefix = CHANNEL_PREFIX.telegram;
  readonly channelId = "telegram";
  readonly bot: Bot;
  private sessionToChatId = new Map<string, number>();
  private buffer = new Map<string, string>();

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /** Call when a message is received so replies go to the right chat. */
  setChatId(sessionId: string, chatId: number): void {
    this.sessionToChatId.set(sessionId, chatId);
  }

  async sendReply(sessionId: string, segment: ReplySegment): Promise<void> {
    const chatId = this.sessionToChatId.get(sessionId);
    if (chatId === undefined) {
      telegramLog.debug({ sessionId }, "No chatId for session, skipping reply");
      return;
    }

    if (segment.type === "error") {
      await this.send(chatId, `❌ ${segment.error ?? "Error"}`);
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
      this.sessionToChatId.delete(sessionId);
      if (text) {
        await this.send(chatId, text);
      }
    } else if (segment.type === "status" && segment.status && segment.status !== "done") {
      // Optional: send "thinking" indicator; avoid spamming
      // Skip for now; final message is sent on done
    }
  }

  private async send(chatId: number, text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch((err) => {
        telegramLog.warn({ err, chatId }, "Telegram send failed, retrying without Markdown");
        return this.bot.api.sendMessage(chatId, text);
      });
      return;
    }
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }
}
