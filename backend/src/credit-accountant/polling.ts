/**
 * Polling: every 15 minutes, fetch OpenAI credit_grants and GitHub Copilot
 * metrics to reconcile Local Estimate with Cloud Reality.
 */

import { serverLog } from "../logger";
import { saveCloudSnapshot } from "./db";

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const OPENAI_CREDIT_GRANTS_URL = "https://api.openai.com/v1/dashboard/billing/credit_grants";
const GITHUB_COPILOT_METRICS_PATH = "/enterprises/{id}/copilot/metrics/reports/users-1-day";

export interface PollingConfig {
  /** OpenAI API key for GET /v1/dashboard/billing/credit_grants */
  openaiApiKey?: string;
  /** GitHub enterprise ID for Copilot metrics (e.g. "my-org") */
  githubEnterpriseId?: string;
  /** GitHub token with copilot metrics scope */
  githubToken?: string;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchOpenAICreditGrants(apiKey: string): Promise<void> {
  try {
    const res = await fetch(OPENAI_CREDIT_GRANTS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await res.text();
    let totalUsed: number | undefined;
    let totalGranted: number | undefined;
    let totalAvailable: number | undefined;
    try {
      const data = JSON.parse(text);
      totalUsed = data.total_used ?? data.total_used_amount;
      totalGranted = data.total_granted ?? data.total_granted_amount;
      totalAvailable = data.total_available ?? data.total_available_amount;
    } catch {
      // keep raw payload
    }
    saveCloudSnapshot("openai", text, totalUsed, totalGranted, totalAvailable);
    serverLog.debug({ totalUsed, totalGranted, totalAvailable }, "OpenAI credit_grants snapshot saved");
  } catch (err: any) {
    serverLog.warn({ err: err?.message }, "OpenAI credit_grants poll failed");
  }
}

async function fetchGitHubCopilotMetrics(enterpriseId: string, token: string): Promise<void> {
  const path = GITHUB_COPILOT_METRICS_PATH.replace("{id}", encodeURIComponent(enterpriseId));
  const url = `https://api.github.com${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const text = await res.text();
    saveCloudSnapshot("github_copilot", text);
    serverLog.debug("GitHub Copilot metrics snapshot saved");
  } catch (err: any) {
    serverLog.warn({ err: err?.message }, "GitHub Copilot metrics poll failed");
  }
}

export function startCreditPolling(config: PollingConfig): void {
  if (pollTimer) return;

  const run = async () => {
    if (config.openaiApiKey) await fetchOpenAICreditGrants(config.openaiApiKey);
    if (config.githubEnterpriseId && config.githubToken) {
      await fetchGitHubCopilotMetrics(config.githubEnterpriseId, config.githubToken);
    }
  };

  run();
  pollTimer = setInterval(run, POLL_INTERVAL_MS);
  serverLog.info({ intervalMinutes: 15 }, "CreditAccountant polling started");
}

export function stopCreditPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    serverLog.info("CreditAccountant polling stopped");
  }
}
