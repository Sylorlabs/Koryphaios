#!/usr/bin/env bun
/**
 * Koryphaios Health Check CLI
 *
 * Outputs [Model Name]: [VALID | INVALID | NO_KEY] for each provider
 * using keys from .env. All network calls use a 5s timeout.
 *
 * Usage:
 *   bun run scripts/health-check.ts
 *   cd backend && bun run scripts/health-check.ts
 *
 * Load .env from project root (backend/../.env or .env).
 */

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { validateProviderKey } from "../src/core/auth/KeyValidator";

// Load .env from repo root
function loadEnv(): void {
  const candidates = [
    resolve(import.meta.dir, "..", "..", ".env"),
    resolve(import.meta.dir, "..", ".env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eq = trimmed.indexOf("=");
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            if (!process.env[key]) {
              process.env[key] = value.replace(/^["']|["']$/g, "");
            }
          }
        }
      }
      break;
    }
  }
}

const MODEL_LABELS: Record<string, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "GPT (OpenAI)",
  google: "Gemini (Google)",
  groq: "Groq",
  openrouter: "OpenRouter",
  xai: "xAI",
};

const ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
};

async function main(): Promise<void> {
  loadEnv();

  const providers = Object.keys(ENV_VARS);
  const results: Array<{ label: string; status: string }> = [];

  for (const provider of providers) {
    const label = MODEL_LABELS[provider] ?? provider;
    const raw = process.env[ENV_VARS[provider]];
    const apiKey = raw?.trim() || null;

    const result = await validateProviderKey(provider, {
      apiKey,
      authToken: null,
    });

    results.push({ label, status: result.status });
  }

  // Output: [Model Name]: [VALID/INVALID/NO_KEY]
  console.log("\nKoryphaios Health Check\n");
  for (const { label, status } of results) {
    console.log(`${label}: ${status}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
