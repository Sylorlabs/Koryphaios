// Secure Telegram Bridge — Identity-locked webhook handler.
// Only accepts commands from TELEGRAM_ADMIN_ID. Streams manager replies back to the chat.

import { Bot, webhookCallback } from "grammy";
import type { KoryManager } from "../kory/manager";
import type { MessagingGateway } from "../messaging/gateway";
import type { TelegramAdapter } from "../messaging/telegram-adapter";
import { telegramLog } from "../logger";

export interface TelegramConfig {
  botToken: string;
  adminId: number;
  secretToken?: string;
}

export class TelegramBridge {
  private bot: Bot;
  private adminId: number;

  constructor(
    private config: TelegramConfig,
    private kory: KoryManager,
    private gateway: MessagingGateway,
    private adapter: TelegramAdapter,
  ) {
    this.adminId = config.adminId;
    this.bot = adapter.bot;
    this.setupHandlers();
  }

  private setupHandlers() {
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.adminId) {
        telegramLog.warn({ userId: ctx.from?.id }, "Blocked unauthorized user");
        return;
      }
      await next();
    });

    this.bot.command("task", async (ctx) => {
      const prompt = ctx.match?.trim();
      if (!prompt) {
        await ctx.reply("Usage: /task <your request here>");
        return;
      }
      await this.runTask(ctx, prompt);
    });

    this.bot.command("vibe", async (ctx) => {
      await ctx.reply("Use /task instead. Sending your message as a task.");
      const prompt = ctx.match?.trim() || "";
      if (prompt) await this.runTask(ctx, prompt);
    });

    this.bot.command("status", async (ctx) => {
      const workers = this.kory.getStatus();
      if (workers.length === 0) {
        await ctx.reply("😴 No active workers. System is idle.");
        return;
      }
      const lines = workers.map((w) =>
        `• **${w.identity.name}** (${w.identity.model})\n  Status: ${w.status}\n  Task: ${w.task.slice(0, 100)}`
      );
      await ctx.reply(`📊 Active Workers:\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
    });

    this.bot.command("cancel", async (ctx) => {
      this.kory.cancel();
      await ctx.reply("🛑 All active tasks cancelled.");
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text?.trim() ?? "";
      if (text.startsWith("/")) return;
      await this.runTask(ctx, text);
    });
  }

  private async runTask(ctx: { chat: { id: number }; reply: (text: string) => Promise<unknown> }, prompt: string): Promise<void> {
    const chatId = ctx.chat.id;
    const sessionId = `telegram-${chatId}`;

    this.gateway.registerSession(sessionId, this.adapter);
    this.adapter.setChatId(sessionId, chatId);

    await ctx.reply("⏳ Processing…");

    try {
      await this.kory.processTask(sessionId, prompt);
    } catch (err: unknown) {
      telegramLog.error({ err, sessionId }, "Kory task error from Telegram");
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getWebhookHandler() {
    return webhookCallback(this.bot, "std/http", {
      secretToken: this.config.secretToken,
    });
  }

  async startPolling() {
    await this.bot.start();
  }
}
