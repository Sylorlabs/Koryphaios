// Messaging gateway and channel adapters.
// Use registerSession(sessionId, adapter) when a channel receives a message,
// then call kory.processTask(sessionId, text). Replies stream to the adapter.

export { messagingGateway } from "./gateway";
export { sessionReplyStream } from "./reply-stream";
export { TelegramAdapter } from "./telegram-adapter";
export type { ChannelAdapter, ReplySegment, ChannelId, ChannelMetadata } from "./types";
export { CHANNEL_PREFIX } from "./types";
