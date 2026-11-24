import { CONTEXT_BUDGET_MAX_TOKENS, CONTEXT_BUDGET_MIN_TOKENS } from '@koryphaios/shared';

export interface MemoryPromptBudget {
  maxContextTokensEnabled: boolean;
  maxContextTokens: number;
  autoIncludeInContext?: boolean;
}

/** Apply the configured memory budget exactly once at the prompt boundary.
 * `formatMemoryForContext` already orders and structures the sources; this
 * helper prevents manager and worker call sites from silently re-enabling a
 * budget the user explicitly turned off. Off means off: a disabled budget
 * passes the formatted context through without a hidden ceiling.
 */
export function applyMemoryPromptBudget(formatted: string, settings: MemoryPromptBudget): string {
  if (!settings.maxContextTokensEnabled) return formatted;
  return formatted.slice(
    0,
    Math.max(
      CONTEXT_BUDGET_MIN_TOKENS * 4,
      Math.min(CONTEXT_BUDGET_MAX_TOKENS, settings.maxContextTokens) * 4,
    ),
  );
}

/** Build an automatic Memory prompt fragment without bypassing the user's
 * inclusion toggle. Manager, worker, and critic paths share this predicate. */
export function automaticMemoryPrompt(formatted: string, settings: MemoryPromptBudget): string {
  if (settings.autoIncludeInContext === false || !formatted.trim()) return '';
  return applyMemoryPromptBudget(formatted, settings);
}
