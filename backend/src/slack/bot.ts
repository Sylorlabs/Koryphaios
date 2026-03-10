// Secure Slack Bridge — Channel/User-locked bot handler.
// Uses Socket Mode for real-time event processing. Streams manager replies to Slack channels.

import { App } from "@slack/bolt";
import type { KoryManager } from "../kory/manager";
import type { MessagingGateway } from "../messaging/gateway";
import type { SlackAdapter } from "../messaging/slack-adapter";
import { slackLog } from "../logger";

export interface SlackBridgeConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
}

export class SlackBridge {
  private app: App;
  private allowedChannelIds: Set<string>;
  private allowedUserIds: Set<string>;

  constructor(
    private config: SlackBridgeConfig,
    private kory: KoryManager,
    private gateway: MessagingGateway,
    private adapter: SlackAdapter,
  ) {
    this.allowedChannelIds = new Set(config.allowedChannelIds ?? []);
    this.allowedUserIds = new Set(config.allowedUserIds ?? []);

    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret || undefined,
      socketMode: true,
    });

    this.setupHandlers();
  }

  private isAuthorized(channelId: string, userId: string): boolean {
    if (this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(channelId)) {
      return false;
    }
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
      return false;
    }
    return true;
  }

  private setupHandlers(): void {
    // Slash command: /task
    this.app.command("/task", async ({ command, ack, respond }) => {
      await ack();

      if (!this.isAuthorized(command.channel_id, command.user_id)) {
        slackLog.warn({ userId: command.user_id, channelId: command.channel_id }, "Blocked unauthorized user");
        await respond("⛔ You are not authorized to use this bot.");
        return;
      }

      const prompt = command.text?.trim();
      if (!prompt) {
        await respond("Usage: `/task <your request here>`");
        return;
      }

      await respond("⏳ Processing…");
      await this.runTask(command.channel_id, prompt, command.thread_ts);
    });

    // Slash command: /status
    this.app.command("/status", async ({ command, ack, respond }) => {
      await ack();

      if (!this.isAuthorized(command.channel_id, command.user_id)) {
        await respond("⛔ You are not authorized to use this bot.");
        return;
      }

      const workers = this.kory.getStatus();
      if (workers.length === 0) {
        await respond("😴 No active workers. System is idle.");
        return;
      }
      const lines = workers.map((w) =>
        `• *${w.agent.name}* (${w.agent.model})\n  Status: ${w.status}\n  Task: ${w.task.slice(0, 100)}`
      );
      await respond(`📊 Active Workers:\n\n${lines.join("\n\n")}`);
    });

    // Slash command: /cancel
    this.app.command("/cancel", async ({ command, ack, respond }) => {
      await ack();

      if (!this.isAuthorized(command.channel_id, command.user_id)) {
        await respond("⛔ You are not authorized to use this bot.");
        return;
      }

      this.kory.cancel();
      await respond("🛑 All active tasks cancelled.");
    });

    // Respond to @mentions
    this.app.event("app_mention", async ({ event, say }) => {
      const userId = event.user;
      const channelId = event.channel;

      if (!userId || !this.isAuthorized(channelId, userId)) {
        slackLog.warn({ userId, channelId }, "Blocked unauthorized mention");
        return;
      }

      const text = event.text
        .replace(/<@[A-Z0-9]+>/g, "")
        .trim();

      if (!text) return;

      await say({ text: "⏳ Processing…", thread_ts: event.ts });
      await this.runTask(channelId, text, event.ts);
    });

    // Respond to DMs
    this.app.event("message", async ({ event, say }) => {
      // Only handle direct messages (no subtype = user message)
      if ("subtype" in event && event.subtype) return;
      if (!("channel_type" in event)) return;
      if ((event as unknown as Record<string, unknown>).channel_type !== "im") return;

      const userId = "user" in event ? (event.user as string) : undefined;
      if (!userId) return;

      const channelId = event.channel;

      if (!this.isAuthorized(channelId, userId)) {
        slackLog.warn({ userId, channelId }, "Blocked unauthorized DM");
        return;
      }

      const text = "text" in event ? (event.text as string)?.trim() : undefined;
      if (!text) return;

      await say({ text: "⏳ Processing…", thread_ts: event.ts });
      await this.runTask(channelId, text, event.ts);
    });
  }

  private async runTask(channelId: string, prompt: string, threadTs?: string): Promise<void> {
    const sessionId = `slack-${channelId}`;

    this.gateway.registerSession(sessionId, this.adapter);
    this.adapter.setChannel(sessionId, channelId, threadTs);

    try {
      await this.kory.processTask(sessionId, prompt);
    } catch (err: unknown) {
      slackLog.error({ err, sessionId }, "Kory task error from Slack");
      try {
        await this.adapter.webClient.chat.postMessage({
          channel: channelId,
          text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
          thread_ts: threadTs,
        });
      } catch {
        // Best effort
      }
    }
  }

  async start(): Promise<void> {
    await this.app.start();
    slackLog.info("Slack bot started (Socket Mode)");
  }

  async stop(): Promise<void> {
    await this.app.stop();
    slackLog.info("Slack bot stopped");
  }
}
