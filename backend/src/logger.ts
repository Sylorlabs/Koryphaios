// Structured logger for Koryphaios.
// Replaces all console.log/warn/error with pino.

import pino from "pino";
import { join } from "path";

const isProduction = process.env.NODE_ENV === "production";
const logDir = process.env.LOG_DIR ?? ".koryphaios/logs";

export const log = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  ...(isProduction
    ? {
        transport: {
          target: "pino-roll",
          options: {
            file: join(logDir, "server"),
            frequency: "daily",
            mkdir: true,
            maxSize: "100M",
            maxFiles: 7,
          },
        },
      }
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }),
  base: { service: "koryphaios" },
});

export const serverLog = log.child({ module: "server" });
export const providerLog = log.child({ module: "providers" });
export const koryLog = log.child({ module: "kory" });
export const toolLog = log.child({ module: "tools" });
export const mcpLog = log.child({ module: "mcp" });
export const telegramLog = log.child({ module: "telegram" });
