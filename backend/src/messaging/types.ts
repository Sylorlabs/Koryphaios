// Messaging gateway — channel adapter types.
// Channels (Telegram, iMessage bridge, Android bridge) implement this and receive
// session-scoped replies from the manager agent.

export const CHANNEL_PREFIX = {
  telegram: "telegram-",
  imessage: "imessage-",
  android: "android-",
} as const;

export type ChannelId = keyof typeof CHANNEL_PREFIX;

/** Reply segment: text delta or final message for a session */
export interface ReplySegment {
  type: "delta" | "message" | "error" | "status";
  sessionId: string;
  content?: string;
  error?: string;
  status?: string;
  done?: boolean;
}

/** Metadata passed when submitting a message (channel-specific) */
export interface ChannelMetadata {
  /** Telegram: chat id for replies */
  chatId?: number;
  /** Bridge devices: device id */
  deviceId?: string;
  /** Bridge: thread/conversation id */
  threadId?: string;
}

/** Channel adapter: receives replies for sessions it owns */
export interface ChannelAdapter {
  readonly sessionIdPrefix: string;
  readonly channelId: ChannelId;

  /**
   * Send a reply segment to the user (e.g. send Telegram message, push to bridge queue).
   * Adapter may buffer deltas and send one message when done.
   */
  sendReply(sessionId: string, segment: ReplySegment): Promise<void>;

  /**
   * Optional: ask user for input (e.g. send question in chat; next message = response).
   */
  askUser?(sessionId: string, question: string, options?: string[]): Promise<void>;
}
