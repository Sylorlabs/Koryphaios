import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { serverLog } from "../logger";

export function persistEnvVar(projectRoot: string, key: string, value: string) {
  const envPath = join(projectRoot, ".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf-8");
  } catch (err) {
    serverLog.debug({ key, error: String(err) }, "No existing .env file, creating new one");
  }

  process.env[key] = value;

  const lines = content.split("\n");
  const existingIdx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (existingIdx >= 0) {
    lines[existingIdx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }

  try {
    writeFileSync(envPath, lines.join("\n"));
    serverLog.debug({ key }, "Persisted environment variable");
  } catch (err) {
    serverLog.error({ key, error: String(err) }, "Failed to persist environment variable");
  }
}

export function clearEnvVar(projectRoot: string, key: string) {
  const envPath = join(projectRoot, ".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    delete process.env[key];
    return;
  }

  delete process.env[key];
  const lines = content
    .split("\n")
    .filter((line) => !line.startsWith(`${key}=`));
  try {
    writeFileSync(envPath, lines.join("\n"));
    serverLog.debug({ key }, "Cleared environment variable");
  } catch (err) {
    serverLog.error({ key, error: String(err) }, "Failed to clear environment variable");
  }
}
