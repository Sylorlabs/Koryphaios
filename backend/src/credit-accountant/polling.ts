/**
 * Polling: every 15 minutes, fetch OpenAI credit_grants and GitHub Copilot
 * metrics to reconcile Local Estimate with Cloud Reality.
 */

import { serverLog } from '../logger';
import { saveCloudSnapshot } from './db';

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const OPENAI_CREDIT_GRANTS_URL = 'https://api.openai.com/v1/dashboard/billing/credit_grants';
const GITHUB_COPILOT_METRICS_PATH = '/enterprises/{id}/copilot/metrics/reports/users-1-day';
// Skip polling when no usage has been recorded in the last 30 minutes —
// avoids hitting OpenAI/GitHub APIs when nobody is chatting.
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export interface PollingConfig {
  /** OpenAI API key for GET /v1/dashboard/billing/credit_grants */
  openaiApiKey?: string;
  /** GitHub enterprise ID for Copilot metrics (e.g. "my-org") */
  githubEnterpriseId?: string;
  /** GitHub token with copilot metrics scope */
  githubToken?: string;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastUsageAt = Date.now();

/** Mark that token usage was recorded (called from recordUsage). Resets the
 *  idle timer so the next poll interval will fire. */
export function markCreditUsage(): void {
  lastUsageAt = Date.now();
}

async function fetchOpenAICreditGrants(apiKey: string): Promise<void> {
  try {
    const res = await fetch(OPENAI_CREDIT_GRANTS_URL, {
      method: 'GET',
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
    } catch (err: unknown) {
      // keep raw payload
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'OpenAI credit_grants JSON parse failed — keeping raw payload');
    }
    saveCloudSnapshot('openai', text, totalUsed, totalGranted, totalAvailable);
    serverLog.debug(
      { totalUsed, totalGranted, totalAvailable },
      'OpenAI credit_grants snapshot saved',
    );
  } catch (err: unknown) {
    serverLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'OpenAI credit_grants poll failed');
  }
}

async function fetchGitHubCopilotMetrics(enterpriseId: string, token: string): Promise<void> {
  const path = GITHUB_COPILOT_METRICS_PATH.replace('{id}', encodeURIComponent(enterpriseId));
  const url = `https://api.github.com${path}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const text = await res.text();
    saveCloudSnapshot('github_copilot', text);
    serverLog.debug('GitHub Copilot metrics snapshot saved');
  } catch (err: unknown) {
    serverLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'GitHub Copilot metrics poll failed');
  }
}

export function startCreditPolling(config: PollingConfig): void {
  if (pollTimer) return;

  const run = async () => {
    // Skip when idle — no token usage in the last 30 minutes.
    if (Date.now() - lastUsageAt > IDLE_THRESHOLD_MS) return;
    if (config.openaiApiKey) await fetchOpenAICreditGrants(config.openaiApiKey);
    if (config.githubEnterpriseId && config.githubToken) {
      await fetchGitHubCopilotMetrics(config.githubEnterpriseId, config.githubToken);
    }
  };

  run();
  pollTimer = setInterval(run, POLL_INTERVAL_MS);
  serverLog.info({ intervalMinutes: 15 }, 'CreditAccountant polling started');
}

export function stopCreditPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    serverLog.info('CreditAccountant polling stopped');
  }
}
