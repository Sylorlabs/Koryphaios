// Structured logger for Koryphaios.
// Replaces all console.log/warn/error with pino.

import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production"
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  base: { service: "koryphaios" },
});

export const serverLog = log.child({ module: "server" });
export const providerLog = log.child({ module: "providers" });
export const koryLog = log.child({ module: "kory" });
export const toolLog = log.child({ module: "tools" });
export const mcpLog = log.child({ module: "mcp" });
export const telegramLog = log.child({ module: "telegram" });
export const messagingLog = log.child({ module: "messaging" });
export const authLog = log.child({ module: "auth" });
