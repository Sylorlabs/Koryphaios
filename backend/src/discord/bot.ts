// Secure Discord Bridge — Guild/User-locked bot handler.
// Streams manager replies back to Discord channels.

import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { KoryManager } from "../kory/manager";
import type { MessagingGateway } from "../messaging/gateway";
import type { DiscordAdapter } from "../messaging/discord-adapter";
import { discordLog } from "../logger";

export interface DiscordBridgeConfig {
  botToken: string;
  allowedGuildIds?: string[];
  allowedUserIds?: string[];
}

export class DiscordBridge {
  private client: Client;
  private allowedGuildIds: Set<string>;
  private allowedUserIds: Set<string>;

  constructor(
    private config: DiscordBridgeConfig,
    private kory: KoryManager,
    private gateway: MessagingGateway,
    private adapter: DiscordAdapter,
  ) {
    this.client = adapter.client;
    this.allowedGuildIds = new Set(config.allowedGuildIds ?? []);
    this.allowedUserIds = new Set(config.allowedUserIds ?? []);
    this.setupHandlers();
  }

  private isAuthorized(guildId: string | null, userId: string): boolean {
    if (this.allowedGuildIds.size > 0 && guildId && !this.allowedGuildIds.has(guildId)) {
      return false;
    }
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) {
      return false;
    }
    return true;
  }

  private setupHandlers(): void {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      if (!this.isAuthorized(guildId, userId)) {
        discordLog.warn({ userId, guildId }, "Blocked unauthorized user");
        await interaction.reply({ content: "⛔ You are not authorized to use this bot.", ephemeral: true });
        return;
      }

      const channelId = interaction.channelId;

      switch (interaction.commandName) {
        case "task": {
          const prompt = interaction.options.getString("prompt", true);
          await interaction.deferReply();
          await this.runTask(channelId, prompt, async (text) => {
            await interaction.editReply(text);
          });
          break;
        }
        case "status": {
          const workers = this.kory.getStatus();
          if (workers.length === 0) {
            await interaction.reply("😴 No active workers. System is idle.");
            return;
          }
          const lines = workers.map((w) =>
            `• **${w.agent.name}** (${w.agent.model})\n  Status: ${w.status}\n  Task: ${w.task.slice(0, 100)}`
          );
          await interaction.reply(`📊 Active Workers:\n\n${lines.join("\n\n")}`);
          break;
        }
        case "cancel": {
          this.kory.cancel();
          await interaction.reply("🛑 All active tasks cancelled.");
          break;
        }
      }
    });

    // Also respond to @mentions in messages
    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (!message.mentions.has(this.client.user!)) return;

      const userId = message.author.id;
      const guildId = message.guildId;

      if (!this.isAuthorized(guildId, userId)) {
        discordLog.warn({ userId, guildId }, "Blocked unauthorized mention");
        return;
      }

      const text = message.content
        .replace(new RegExp(`<@!?${this.client.user!.id}>`, "g"), "")
        .trim();

      if (!text) return;

      const channelId = message.channelId;
      await message.reply("⏳ Processing…");
      await this.runTask(channelId, text, async (reply) => {
        // Chunked reply for long messages
        if (reply.length <= 2000) {
          await message.reply(reply);
        } else {
          const chunks: string[] = [];
          for (let i = 0; i < reply.length; i += 2000) {
            chunks.push(reply.slice(i, i + 2000));
          }
          for (const chunk of chunks) {
            await message.channel.send(chunk);
          }
        }
      });
    });
  }

  private async runTask(
    channelId: string,
    prompt: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const sessionId = `discord-${channelId}`;

    this.gateway.registerSession(sessionId, this.adapter);
    this.adapter.setChannelId(sessionId, channelId);

    try {
      await this.kory.processTask(sessionId, prompt);
    } catch (err: unknown) {
      discordLog.error({ err, sessionId }, "Kory task error from Discord");
      await reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  }

  async registerSlashCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("task")
        .setDescription("Send a task to the AI agent")
        .addStringOption((opt) =>
          opt.setName("prompt").setDescription("The task to perform").setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show status of active workers"),
      new SlashCommandBuilder()
        .setName("cancel")
        .setDescription("Cancel all active tasks"),
    ];

    const rest = new REST({ version: "10" }).setToken(this.config.botToken);

    try {
      await rest.put(
        Routes.applicationCommands(this.client.user!.id),
        { body: commands.map((c) => c.toJSON()) },
      );
      discordLog.info("Registered Discord slash commands");
    } catch (err) {
      discordLog.error({ err }, "Failed to register Discord slash commands");
    }
  }

  async start(): Promise<void> {
    await this.client.login(this.config.botToken);
    discordLog.info({ tag: this.client.user?.tag }, "Discord bot logged in");

    // Register slash commands once ready
    this.client.once(Events.ClientReady, async () => {
      await this.registerSlashCommands();
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    discordLog.info("Discord bot stopped");
  }
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}
