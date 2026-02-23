/**
 * ManagerSession — For LARGE tasks: interviews the user (3–4 questions) then spawns workers.
 * model_tier selection strictly obeys the user's checked model list; uses fallback or notifies if tier unavailable.
 */

import type { TriageIntent, ModelTier, SelectionResult } from "../routing/types";
import { getEnabledModelIds } from "../model-settings";
import {
  selectModel,
  selectModelForTier,
  selectFallbackWhenTierUnavailable,
} from "../routing/SelectionEngine";
import { auditRoutingDecision } from "../routing/TriageEngine";

export const MANAGER_INTERVIEW_QUESTION_COUNT = 4;

export interface ManagerSessionOptions {
  userId: string;
  sessionId: string | null;
  /** Ask the user a question; returns their answer. */
  askUser: (question: string, options?: string[]) => Promise<string>;
  /** Spawn a worker with the given task and resolved model (already constrained to checked list). */
  spawnWorker: (task: string, modelId: string, provider: string) => Promise<string>;
  /** Emit a notification to the user (e.g. "No flagship model enabled; using Sonnet"). */
  notifyUser?: (message: string) => void;
}

const DEFAULT_LARGE_TIER: ModelTier = "flagship";

/**
 * Run the Manager interview: ask 3–4 questions to clarify the LARGE task.
 * Returns the refined task description and answers for context.
 */
export async function runManagerInterview(
  initialTask: string,
  askUser: ManagerSessionOptions["askUser"]
): Promise<{ refinedTask: string; answers: string[] }> {
  const questions = [
    "What is the main deliverable? (e.g. a new API, a refactored module, a full feature)",
    "Are there constraints? (e.g. existing patterns, tests required, no breaking changes)",
    "Which area of the codebase does this touch? (e.g. frontend, backend, both)",
    "Anything else the agent should know before starting?",
  ].slice(0, MANAGER_INTERVIEW_QUESTION_COUNT);

  const answers: string[] = [];
  let refinedTask = initialTask;

  for (const q of questions) {
    const answer = await askUser(q);
    answers.push(answer);
    refinedTask += `\n[Q] ${q}\n[A] ${answer}`;
  }

  return { refinedTask, answers };
}

/**
 * Resolve model_tier to a concrete model from the user's checked list.
 * If no model in that tier is checked, notifies user and uses fallback.
 */
export function resolveWorkerModel(
  modelTier: ModelTier,
  userId: string,
  notifyUser?: (msg: string) => void
): SelectionResult | null {
  const checked = getEnabledModelIds(userId);
  let result = selectModelForTier(modelTier, checked);

  if (!result) {
    const fallback = selectFallbackWhenTierUnavailable(modelTier, checked);
    if (fallback && notifyUser) {
      notifyUser(
        `No model in tier "${modelTier}" is enabled in your settings. Using ${fallback.modelId} (${fallback.tier}) instead.`
      );
    }
    result = fallback;
  }

  return result ?? null;
}

/**
 * Execute the Manager flow for a LARGE task: interview then spawn worker with checked-model resolution.
 */
export async function runManagerSession(
  intent: TriageIntent,
  initialTask: string,
  options: ManagerSessionOptions
): Promise<string> {
  const { userId, sessionId, askUser, spawnWorker, notifyUser } = options;

  if (intent !== "LARGE") {
    const checked = getEnabledModelIds(userId);
    const selection = selectModel(intent, checked);
    if (selection) {
      auditRoutingDecision({
        userId,
        sessionId,
        intent,
        selectedModelId: `${selection.provider}:${selection.modelId}`,
        checkedModels: checked,
      });
      return spawnWorker(initialTask, selection.modelId, selection.provider);
    }
    if (notifyUser) notifyUser("No enabled models in settings. Please enable at least one model.");
    return "No model available.";
  }

  const { refinedTask } = await runManagerInterview(initialTask, askUser);

  const modelTier = DEFAULT_LARGE_TIER;
  const selection = resolveWorkerModel(modelTier, userId, notifyUser);

  if (!selection) {
    if (notifyUser) notifyUser("No enabled model could be used for this task. Please enable at least one model in Settings.");
    return "No model available.";
  }

  const checked = getEnabledModelIds(userId);
  auditRoutingDecision({
    userId,
    sessionId,
    intent: "LARGE",
    selectedModelId: `${selection.provider}:${selection.modelId}`,
    checkedModels: checked,
  });

  return spawnWorker(refinedTask, selection.modelId, selection.provider);
}
