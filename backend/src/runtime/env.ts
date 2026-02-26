import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { serverLog } from "../logger";

/** Load .env from project root into process.env (only set if not already set). Call at startup so persisted provider keys are available after restart. */
export function loadEnvFromProject(projectRoot: string): void {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
    serverLog.debug("Loaded .env from project root");
  } catch (err) {
    serverLog.warn({ path: envPath, error: String(err) }, "Could not load .env");
  }
}

/** Restrict .env to owner read/write only (0600). Works on Windows, macOS, and Linux. */
function restrictEnvFilePermissions(envPath: string) {
  try {
    chmodSync(envPath, 0o600);
  } catch (err) {
    serverLog.warn({ path: envPath, error: String(err) }, "Could not set .env file mode to 0600");
  }
}

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
    restrictEnvFilePermissions(envPath);
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
    restrictEnvFilePermissions(envPath);
    serverLog.debug({ key }, "Cleared environment variable");
  } catch (err) {
    serverLog.error({ key, error: String(err) }, "Failed to clear environment variable");
  }
}
