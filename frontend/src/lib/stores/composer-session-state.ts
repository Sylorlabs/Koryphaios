import type { FusionSelection } from '@koryphaios/shared';
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

import { isCriticMode, type CriticMode, type SessionAgentOverrides } from '@koryphaios/shared';
export type ComposerPermissionMode = 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom';
export type ComposerAgentExecutionMode = 'auto' | 'single' | 'multi';

export type ComposerSessionState = {
  criticMode?: CriticMode;
  model?: string;
  reasoningLevel?: string;
  /** Retired Fast switch — kept so a saved true still migrates onto the
   * model's first speed tier on restore. */
  fastMode?: boolean;
  /** The chat's chosen faster serving tier id (`null` = explicit Off). */
  speedTier?: string | null;
  /** The chat's "Model settings" overrides — absent keys use the provider
   * default. */
  modelParameters?: Record<string, number | string>;
  /** The chat's Devin Fusion slot selection — only on `devin:fusion`. */
  fusion?: FusionSelection;
  permissionMode?: ComposerPermissionMode;
  agentExecutionMode?: ComposerAgentExecutionMode;
  worktreeMode?: 'auto' | 'always' | 'never';
  /** Legacy saved checkbox form: true → 'auto', false → 'never'. */
  worktreeIsolation?: boolean;
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
  'custom',
];
const AGENT_EXECUTION_MODES: readonly ComposerAgentExecutionMode[] = ['auto', 'single', 'multi'];

function sanitize(raw: Record<string, unknown>): ComposerSessionState {
  return {
    ...(isCriticMode(raw.criticMode) ? { criticMode: raw.criticMode } : {}),
    ...(typeof raw.model === 'string' && raw.model
      ? { model: raw.model.slice(0, MAX_MODEL_CHARS) }
      : {}),
    ...(typeof raw.reasoningLevel === 'string' && raw.reasoningLevel
      ? { reasoningLevel: raw.reasoningLevel.slice(0, MAX_REASONING_CHARS) }
      : {}),
    ...(typeof raw.fastMode === 'boolean' ? { fastMode: raw.fastMode } : {}),
    ...(typeof raw.speedTier === 'string' && raw.speedTier
      ? { speedTier: raw.speedTier.slice(0, 64) }
      : raw.speedTier === null
        ? { speedTier: null }
        : {}),
    ...sanitizeModelParameterRecord(raw.modelParameters),
    ...(isFusionSelection(raw.fusion) ? { fusion: raw.fusion } : {}),
    ...(typeof raw.permissionMode === 'string' &&
    PERMISSION_MODES.includes(raw.permissionMode as ComposerPermissionMode)
      ? { permissionMode: raw.permissionMode as ComposerPermissionMode }
      : {}),
    ...(typeof raw.agentExecutionMode === 'string' &&
    AGENT_EXECUTION_MODES.includes(raw.agentExecutionMode as ComposerAgentExecutionMode)
      ? { agentExecutionMode: raw.agentExecutionMode as ComposerAgentExecutionMode }
      : {}),
    ...(raw.worktreeMode === 'auto' || raw.worktreeMode === 'always' || raw.worktreeMode === 'never'
      ? { worktreeMode: raw.worktreeMode }
      : typeof raw.worktreeIsolation === 'boolean'
        ? // Legacy saved state: the checkbox tracked auto (on) vs never (off).
          { worktreeMode: raw.worktreeIsolation ? 'auto' : ('never' as const) }
        : {}),
    ...(typeof raw.criticGateEnabled === 'boolean'
      ? { criticGateEnabled: raw.criticGateEnabled }
      : {}),
  };
}

function isEmpty(state: ComposerSessionState): boolean {
  return (
    state.criticMode === undefined &&
    state.model === undefined &&
    state.reasoningLevel === undefined &&
    state.fastMode === undefined &&
    state.speedTier === undefined &&
    state.modelParameters === undefined &&
    state.fusion === undefined &&
    state.permissionMode === undefined &&
    state.agentExecutionMode === undefined &&
    state.worktreeMode === undefined &&
    state.criticGateEnabled === undefined
  );
}

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

/** Loose shape check for a stored Fusion selection — the composer validates
 * it against the live catalog before sending. */
function isFusionSelection(raw: unknown): raw is FusionSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  return (
    typeof v.lead === 'string' &&
    v.lead.length <= 256 &&
    typeof v.leadEffort === 'string' &&
    v.leadEffort.length <= 32 &&
    typeof v.leadFast === 'boolean' &&
    typeof v.sidekick === 'string' &&
    v.sidekick.length <= 256 &&
    (v.sidekickEffort === null ||
      (typeof v.sidekickEffort === 'string' && v.sidekickEffort.length <= 32))
  );
}

/** Loose shape check for session-scoped settings — the adapter re-sanitizes
 * against the live parameter list before anything reaches the wire. */
function sanitizeModelParameterRecord(raw: unknown): {
  modelParameters?: Record<string, number | string>;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 32)) {
    const k = key.slice(0, 64);
    if (typeof value === 'number' && Number.isFinite(value)) out[k] = value;
    else if (typeof value === 'string' && value.length <= 64) out[k] = value;
  }
  return Object.keys(out).length > 0 ? { modelParameters: out } : {};
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

/**
 * The subset of a chat's control choices that is also a project default.
 *
 * Model and reasoning effort are intentionally absent: they belong to the
 * conversation (model has its own last-used preference), not to how a new chat
 * should start. Every other posture a user flips in the composer becomes the
 * starting value for the next new chat.
 */
export function composerApprovalDefaults(patch: SessionAgentOverrides): SessionAgentOverrides {
  return {
    ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
    ...(patch.agentExecutionMode ? { agentExecutionMode: patch.agentExecutionMode } : {}),
    ...(patch.worktreeMode ? { worktreeMode: patch.worktreeMode } : {}),
    ...(patch.criticMode ? { criticMode: patch.criticMode } : {}),
    ...(typeof patch.criticGateEnabled === 'boolean'
      ? { criticGateEnabled: patch.criticGateEnabled }
      : {}),
  };
}

export function clearComposerSessionState(scope: string | undefined): void {
  const all = readAll();
  delete all[safeScope(scope)];
  writeAll(all);
}

/**
 * Drop the approval posture saved for a draft once that draft's session exists.
 *
 * The session row is authoritative from then on. Keeping the draft's copy
 * would shadow the project default on the *next* new chat, which is how a chat
 * set to YOLO could still open as Ask. Composer preferences (model, reasoning,
 * fast mode) are unrelated and stay put.
 */
export function clearComposerApprovalState(scope: string | undefined): void {
  const key = safeScope(scope);
  const all = readAll();
  const state = all[key];
  if (!state) return;
  const rest: ComposerSessionState = {
    ...(state.model ? { model: state.model } : {}),
    ...(state.reasoningLevel ? { reasoningLevel: state.reasoningLevel } : {}),
    ...(typeof state.fastMode === 'boolean' ? { fastMode: state.fastMode } : {}),
    ...(state.speedTier !== undefined ? { speedTier: state.speedTier } : {}),
  };
  if (isEmpty(rest)) delete all[key];
  else all[key] = rest;
  writeAll(all);
}
