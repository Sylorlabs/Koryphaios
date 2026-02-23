/**
 * Integration sample: Intelligent Auto-Mode with User Preference Constraints.
 *
 * Run after DB is initialized (e.g. from server.ts after initDb).
 * Wire this to your session handler: get userId from session, use askUser/spawnWorker from WS or HTTP.
 *
 * Example:
 *   import { runAutoMode, getCheckedModelsForUser } from "./core";
 *   const result = await runAutoMode(message, { userId, sessionId, askUser, spawnWorker, notifyUser });
 */

import {
  runAutoMode,
  getCheckedModelsForUser,
  triage,
  selectModel,
  runSafe,
  getEnabledModelIds,
} from "./core";

export async function sampleAutoModeIntegration(
  userMessage: string,
  userId: string,
  sessionId: string | null,
  askUser: (q: string, opts?: string[]) => Promise<string>,
  spawnWorker: (task: string, modelId: string, provider: string) => Promise<string>,
  notifyUser?: (msg: string) => void
): Promise<string> {
  const checked = getCheckedModelsForUser(userId);
  if (checked.length === 0) {
    return "No models enabled in Settings. Please check at least one model for Auto-Mode.";
  }

  return runAutoMode(userMessage, {
    userId,
    sessionId,
    askUser,
    spawnWorker,
    notifyUser,
    useLocalSlm: false,
  });
}

/** Sample: triage only (e.g. for UI to show intent before running). */
export async function sampleTriageOnly(userMessage: string, userId: string, useLocalSlm = false) {
  return triage(userMessage, { userId, sessionId: null, useLocalSlm });
}

/** Sample: resolve model for intent from checked list (downgrade if needed). */
export function sampleSelectModel(intent: "SMALL" | "MEDIUM" | "LARGE", userId: string) {
  const checked = getEnabledModelIds(userId);
  return selectModel(intent, checked);
}

/** Sample: SafeTerminal for any shell command to prevent Bun deadlocks. */
export { runSafe };
