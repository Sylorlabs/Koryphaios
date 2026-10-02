/**
 * Per-chat composer control state.
 *
 * The selected model, reasoning effort, and fast/priority toggle used to be a
 * single global value: picking a model in one chat changed the picker for every
 * other chat. State here is scoped by chat (the same scope as composer drafts)
 * so each chat keeps its own controls. Chats without a saved state fall back
 * to the last model the user picked anywhere (`koryphaios-selected-model`),
 * which preserves the previous first-open behavior for brand-new chats.
 *
 * The approval preset, agent mode, and critic toggle are per-chat for the same
 * reason: flipping YOLO in one conversation must not reconfigure every other
 * conversation in the project. Their durable home is the session row (the
 * backend enforces them per session); this map only covers the brief window
 * before a session exists — the welcome panel and a chat created a moment ago —
 * so those choices survive the hand-off to the real session.
 */

export type ComposerPermissionMode = 'yolo' | 'guarded' | 'edits' | 'ask' | 'plan' | 'custom';
export type ComposerAgentExecutionMode = 'auto' | 'single' | 'multi';

export type ComposerSessionState = {
  model?: string;
  reasoningLevel?: string;
  fastMode?: boolean;
  permissionMode?: ComposerPermissionMode;
  agentExecutionMode?: ComposerAgentExecutionMode;
  criticGateEnabled?: boolean;
};

const STORAGE_KEY = 'koryphaios-composer-session-state-v1';
const MAX_SCOPES = 48;
const MAX_MODEL_CHARS = 300;
const MAX_REASONING_CHARS = 80;
const PERMISSION_MODES: readonly ComposerPermissionMode[] = [
  'yolo',
  'guarded',
  'edits',
  'ask',
  'plan',
  'custom',
];
const AGENT_EXECUTION_MODES: readonly ComposerAgentExecutionMode[] = ['auto', 'single', 'multi'];

function sanitize(raw: Record<string, unknown>): ComposerSessionState {
  return {
    ...(typeof raw.model === 'string' && raw.model
      ? { model: raw.model.slice(0, MAX_MODEL_CHARS) }
      : {}),
    ...(typeof raw.reasoningLevel === 'string' && raw.reasoningLevel
      ? { reasoningLevel: raw.reasoningLevel.slice(0, MAX_REASONING_CHARS) }
      : {}),
    ...(typeof raw.fastMode === 'boolean' ? { fastMode: raw.fastMode } : {}),
    ...(typeof raw.permissionMode === 'string' &&
    PERMISSION_MODES.includes(raw.permissionMode as ComposerPermissionMode)
      ? { permissionMode: raw.permissionMode as ComposerPermissionMode }
      : {}),
    ...(typeof raw.agentExecutionMode === 'string' &&
    AGENT_EXECUTION_MODES.includes(raw.agentExecutionMode as ComposerAgentExecutionMode)
      ? { agentExecutionMode: raw.agentExecutionMode as ComposerAgentExecutionMode }
      : {}),
    ...(typeof raw.criticGateEnabled === 'boolean'
      ? { criticGateEnabled: raw.criticGateEnabled }
      : {}),
  };
}

function isEmpty(state: ComposerSessionState): boolean {
  return (
    state.model === undefined &&
    state.reasoningLevel === undefined &&
    state.fastMode === undefined &&
    state.permissionMode === undefined &&
    state.agentExecutionMode === undefined &&
    state.criticGateEnabled === undefined
  );
}

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function safeScope(scope: string | undefined): string {
  const normalized = scope?.trim();
  return normalized ? normalized.slice(0, 256) : 'welcome';
}

function readAll(
  storage: Storage | undefined = safeStorage(),
): Record<string, ComposerSessionState> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, ComposerSessionState> = {};
    for (const [scope, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const state = sanitize(raw as Record<string, unknown>);
      if (!isEmpty(state)) {
        result[safeScope(scope)] = state;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(
  states: Record<string, ComposerSessionState>,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(states));
  } catch {}
}

function trimScopes(
  states: Record<string, ComposerSessionState>,
): Record<string, ComposerSessionState> {
  return Object.fromEntries(Object.entries(states).slice(-MAX_SCOPES));
}

export function loadComposerSessionState(scope: string | undefined): ComposerSessionState {
  return readAll()[safeScope(scope)] ?? {};
}

export function saveComposerSessionState(
  scope: string | undefined,
  next: ComposerSessionState,
): void {
  const key = safeScope(scope);
  if (!key) return;
  const all = readAll();
  const state = sanitize(next as unknown as Record<string, unknown>);
  if (isEmpty(state)) {
    delete all[key];
  } else {
    all[key] = state;
  }
  writeAll(trimScopes(all));
}

export function clearComposerSessionState(scope: string | undefined): void {
  const all = readAll();
  delete all[safeScope(scope)];
  writeAll(all);
}
