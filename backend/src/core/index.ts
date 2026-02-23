/**
 * Intelligent Auto-Mode — Integration sample.
 *
 * This module wires:
 * - TriageEngine (SQLite permission check, Gemma 3 or heuristic triage)
 * - SelectionEngine (intent -> best enabled model, downgrade if unchecked)
 * - ManagerSession (LARGE: interview 3–4 questions, then spawn_worker with checked-model only)
 * - SafeTerminal for any shell/terminal calls to prevent Bun deadlocks
 * - Routing audit log in SQLite
 *
 * Usage: ensure DB is initialized (migrations run), then call runAutoMode() with session context.
 */

import { triage, getCheckedModelsForUser, auditRoutingDecision } from "./routing/TriageEngine";
import { selectModel } from "./routing/SelectionEngine";
import { runManagerSession } from "./orchestration/ManagerSession";
import { runSafe } from "./safe-terminal";
import type { TriageIntent } from "./routing/types";

export { triage, getCheckedModelsForUser, auditRoutingDecision };
export { selectModel } from "./routing/SelectionEngine";
export { runManagerSession, runManagerInterview, resolveWorkerModel } from "./orchestration";
export { runSafe } from "./safe-terminal";
export { getEnabledModelIds, getEnabledModelsForRouting, setModelChecked } from "./model-settings";

export type { TriageIntent, TriageResult, SelectionResult, ModelTier } from "./routing/types";

/**
 * Run Intelligent Auto-Mode: triage -> select model (from checked list only) -> for LARGE run ManagerSession else direct.
 *
 * @param userMessage - Raw user input
 * @param options - userId, sessionId, askUser, spawnWorker, notifyUser; useLocalSlm to try Gemma 3
 * @returns Result summary from the worker or direct run
 */
export async function runAutoMode(
  userMessage: string,
  options: {
    userId: string;
    sessionId: string | null;
    askUser: (question: string, options?: string[]) => Promise<string>;
    spawnWorker: (task: string, modelId: string, provider: string) => Promise<string>;
    notifyUser?: (message: string) => void;
    useLocalSlm?: boolean;
  }
): Promise<string> {
  const result = await triage(userMessage, {
    userId: options.userId,
    sessionId: options.sessionId,
    useLocalSlm: options.useLocalSlm ?? false,
  });

  return runManagerSession(result.intent, userMessage, {
    userId: options.userId,
    sessionId: options.sessionId,
    askUser: options.askUser,
    spawnWorker: options.spawnWorker,
    notifyUser: options.notifyUser,
  });
}

/**
 * Example: use SafeTerminal for any CLI/shell call to avoid deadlocks.
 */
export async function exampleSafeTerminalUsage(): Promise<void> {
  const res = await runSafe(["node", "--version"], { timeoutMs: 5000 });
  if (res.timedOut) {
    console.warn("Command timed out");
  } else {
    console.log("stdout:", res.stdout.trim());
  }
}
