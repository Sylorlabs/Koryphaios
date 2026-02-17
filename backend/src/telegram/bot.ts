// Secure Telegram Bridge — Identity-locked webhook handler.
// Only accepts commands from TELEGRAM_ADMIN_ID. Drops everything else.

import { Bot, webhookCallback } from "grammy";
import type { KoryManager } from "../kory/manager";
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
  ) {
    this.adminId = config.adminId;
    this.bot = new Bot(config.botToken);
    this.setupHandlers();
  }

  private setupHandlers() {
    // Identity lock — drop ALL messages not from admin
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.adminId) {
        telegramLog.warn({ userId: ctx.from?.id }, "Blocked unauthorized user");
        return; // Silent drop
      }
      await next();
    });

    // /task [prompt] — send a task to Kory
    this.bot.command("task", async (ctx) => {
      const prompt = ctx.match;
      if (!prompt) {
        await ctx.reply("Usage: /task <your request here>");
        return;
      }

      await ctx.reply(`🎯 Received task. Routing to Kory...\n\n"${prompt.slice(0, 200)}"`);

      try {
        // Fire and forget — Kory processes async, status available via /status
        const sessionId = `telegram-${Date.now()}`;
        this.kory.processTask(sessionId, prompt).catch((err) => {
          telegramLog.error(err, "Kory error from Telegram");
        });
        await ctx.reply("✅ Task dispatched. Use /status to check progress.");
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // Backwards compatibility - alias /vibe to /task
    this.bot.command("vibe", async (ctx) => {
      await ctx.reply("The /vibe command is deprecated. Use /task instead.");
    });

    // /status — get current agent activity
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

    // /cancel — cancel all active work
    this.bot.command("cancel", async (ctx) => {
      this.kory.cancel();
      await ctx.reply("🛑 All active tasks cancelled.");
    });

    // Handle plain text as a task
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return;

      await ctx.reply(`🎯 Processing: "${text.slice(0, 100)}..."`);
      const sessionId = `telegram-${Date.now()}`;
      this.kory.processTask(sessionId, text).catch((err) => telegramLog.error(err, "Kory task error from Telegram"));
    });
  }

  /** Get the webhook handler for use with Bun's HTTP server. */
  getWebhookHandler() {
    return webhookCallback(this.bot, "std/http", {
      secretToken: this.config.secretToken,
    });
  }

  /** Start polling mode (for development). */
  async startPolling() {
    await this.bot.start();
  }
}
