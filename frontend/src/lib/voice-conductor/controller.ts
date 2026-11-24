// The voice conductor's state machine: utterance → intent → resolved command →
// (confirmation) → execution → HUD with an optional undo.
//
// Everything that touches the workspace goes through `ConductorActions`, which
// the app implements with the existing stores. Every chat-bound action takes
// the sessionId captured when the utterance was heard, never "whatever chat is
// open when the confirmation finally lands".

import {
  isAffirmative,
  isDestructiveIntent,
  isNegative,
  parseConductorUtterance,
  type AgentTarget,
  type ConductorIntent,
  type ConductorPanel,
  type ConductorRole,
} from './grammar';

export interface ConductorAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  task?: string;
}

export interface ConductorChat {
  id: string;
  title: string;
}

export interface ConductorNote {
  id: string;
  title: string;
  content: string;
  format?: 'markdown' | 'html';
}

export interface ConductorActions {
  activeSessionId(): string;
  /** Workers of a chat (manager excluded), in the order they started. */
  listWorkers(sessionId: string): ConductorAgent[];
  managerStatus(sessionId: string): string;
  isRunning(sessionId: string): boolean;
  cancelSession(sessionId: string): Promise<void>;
  cancelAgent(sessionId: string, agentId: string): Promise<void>;
  steerManager(sessionId: string, text: string): Promise<boolean>;
  messageAgent(sessionId: string, agentId: string, text: string): Promise<boolean>;
  listChats(): ConductorChat[];
  createChat(): Promise<string | null>;
  renameChat(sessionId: string, title: string): Promise<boolean>;
  selectChat(sessionId: string): void;
  archiveChat(sessionId: string): Promise<boolean>;
  deleteChat(sessionId: string): Promise<boolean>;
  /** Ask the shell to show a panel. False when nothing can show it. */
  openPanel(panel: ConductorPanel): boolean;
  notesEnabled(): boolean;
  currentNote(): ConductorNote | null;
  updateNoteContent(noteId: string, content: string): Promise<boolean>;
  createNote(title: string, content: string): Promise<string | null>;
  trashNote(noteId: string): Promise<boolean>;
  lastReply(sessionId: string): { id: string; text: string } | null;
  speak(id: string, text: string): Promise<void>;
  stopSpeaking(): void;
  spokenRepliesEnabled(): Promise<boolean>;
}

export type HudTone = 'info' | 'success' | 'warning' | 'error' | 'confirm' | 'fallback';

export interface ConductorHud {
  id: number;
  tone: HudTone;
  /** The interpreted action, e.g. "Stop worker 2 (Ada)". */
  title: string;
  /** Longer text: a status answer, or the words that were heard. */
  detail?: string;
  heard?: string;
  canUndo: boolean;
  undoLabel?: string;
  /** Present while a confirm tap / spoken "yes" is awaited. */
  confirm?: { label: string; expiresAt: number; destructive: boolean };
}

export interface ConductorState {
  hud: ConductorHud | null;
  busy: boolean;
}

export interface ControllerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const CONFIRM_WINDOW_MS = 5_000;
export const FALLBACK_WINDOW_MS = 12_000;
export const UNDO_WINDOW_MS = 30_000;
const DONE_HUD_MS = 6_000;
const ANSWER_HUD_MS = 14_000;
const ERROR_HUD_MS = 7_000;

interface CommandOutcome {
  title?: string;
  detail?: string;
  tone?: HudTone;
  undo?: { label: string; run: () => Promise<void> | void };
  /** Text the conductor reads aloud when spoken replies are on. */
  speak?: string;
  /** Long-lived HUD for answers that take a while to read. */
  sticky?: boolean;
}

interface ResolvedCommand {
  title: string;
  destructive: boolean;
  run: () => Promise<CommandOutcome>;
}

type Resolution = ResolvedCommand | { error: string };

const ROLE_LABEL: Record<ConductorRole, string> = {
  coder: 'coder',
  critic: 'critic',
  reviewer: 'reviewer',
  task: 'task agent',
  summarizer: 'summarizer',
};

const STATUS_PHRASE: Record<string, string> = {
  idle: 'idle',
  thinking: 'thinking',
  analyzing: 'analyzing',
  tool_calling: 'using tools',
  streaming: 'writing a reply',
  verifying: 'verifying',
  compacting: 'compacting context',
  waiting_user: 'waiting for you',
  waiting: 'waiting',
  error: 'stopped with an error',
  done: 'done',
  reading: 'reading files',
};

export function describeAgentStatus(status: string): string {
  return STATUS_PHRASE[status] ?? status.replace(/_/g, ' ');
}

const ORDINAL_NAMES = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

function targetLabel(target: AgentTarget): string {
  switch (target.kind) {
    case 'all':
      return 'everything';
    case 'manager':
      return 'the manager';
    case 'ordinal':
      return `worker ${target.index}`;
    case 'role':
      return `the ${ROLE_LABEL[target.role]}`;
    case 'name':
      return target.name;
  }
}

/** Find the worker a target names. */
export function resolveWorker(
  workers: ConductorAgent[],
  target: AgentTarget,
): ConductorAgent | { error: string } {
  if (target.kind === 'ordinal') {
    const worker = workers[target.index - 1];
    if (worker) return worker;
    if (!workers.length) return { error: 'No workers are in this chat yet.' };
    return {
      error: `There is no ${ORDINAL_NAMES[target.index - 1] ?? `#${target.index}`} worker; this chat has ${workers.length}.`,
    };
  }
  if (target.kind === 'role') {
    const active = workers.filter((w) => w.role === target.role && !isFinished(w.status));
    const worker = active.at(-1) ?? workers.filter((w) => w.role === target.role).at(-1);
    return worker ?? { error: `No ${ROLE_LABEL[target.role]} is in this chat.` };
  }
  if (target.kind === 'name') {
    const name = target.name.toLowerCase();
    const worker =
      workers.find((w) => w.name.toLowerCase() === name) ??
      workers.find((w) => w.name.toLowerCase().split(/\s+/).includes(name));
    return worker ?? { error: `No agent named “${target.name}” is in this chat.` };
  }
  return { error: 'That command needs a single worker.' };
}

function isFinished(status: string): boolean {
  return status === 'done' || status === 'idle' || status === 'error';
}

function workerLabel(worker: ConductorAgent, workers: ConductorAgent[]): string {
  const index = workers.findIndex((w) => w.id === worker.id) + 1;
  return `worker ${index} (${worker.name})`;
}

/** The text of a status answer. Always shown, spoken when replies are on. */
export function describeStatus(
  managerStatus: string,
  workers: ConductorAgent[],
  target: AgentTarget = { kind: 'all' },
): string {
  if (target.kind !== 'all' && target.kind !== 'manager') {
    const worker = resolveWorker(workers, target);
    if ('error' in worker) return worker.error;
    const task = worker.task && !/^orchestrating/i.test(worker.task) ? ` on “${worker.task}”` : '';
    return `${capitalizeFirst(workerLabel(worker, workers))} is ${describeAgentStatus(worker.status)}${isFinished(worker.status) ? '' : task}.`;
  }
  const manager = `Kory is ${describeAgentStatus(managerStatus)}.`;
  if (target.kind === 'manager') return manager;
  if (!workers.length) return `${manager} No workers have started in this chat.`;
  const active = workers.filter((w) => !isFinished(w.status));
  const finished = workers.length - active.length;
  const parts = active.map((w) => `${workerLabel(w, workers)} is ${describeAgentStatus(w.status)}`);
  const activeText = active.length
    ? `${active.length} ${active.length === 1 ? 'worker is' : 'workers are'} active: ${parts.join('; ')}.`
    : 'No workers are active.';
  const finishedText = finished ? ` ${finished} finished.` : '';
  return `${manager} ${activeText}${finishedText}`;
}

function capitalizeFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Best title match for "open chat <title>". */
export function findChat(chats: ConductorChat[], query: string): ConductorChat | null {
  const q = normalizeTitle(query);
  if (!q) return null;
  const scored = chats
    .map((chat) => ({ chat, title: normalizeTitle(chat.title) }))
    .map(({ chat, title }) => {
      if (title === q) return { chat, score: 100 };
      if (title.startsWith(q)) return { chat, score: 80 };
      if (title.includes(q)) return { chat, score: 60 };
      const words = q.split(' ').filter((w) => w.length > 1);
      const hits = words.filter((w) => title.split(' ').includes(w)).length;
      return { chat, score: words.length && hits === words.length ? 40 : hits ? 10 * hits : 0 };
    })
    .filter((entry) => entry.score >= 20)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.chat ?? null;
}

function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function appendToNoteContent(note: ConductorNote, text: string): string {
  if (note.format === 'html') return `${note.content}<p>${escapeHtml(text)}</p>`;
  const base = note.content.replace(/\s+$/, '');
  return base ? `${base}\n\n${text}` : text;
}

const PANEL_LABEL: Record<ConductorPanel, string> = {
  notes: 'Notes',
  terminal: 'Terminal',
  settings: 'Settings',
  voice_settings: 'Voice settings',
  agents: 'Agents',
};

export interface VoiceConductorController {
  readonly state: ConductorState;
  handleUtterance(text: string): Promise<void>;
  confirm(): Promise<void>;
  dismiss(): void;
  undo(): Promise<void>;
  /** True while a confirm tap or spoken answer is awaited. */
  readonly awaitingConfirmation: boolean;
  dispose(): void;
}

const realClock: ControllerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createConductorController(
  actions: ConductorActions,
  onChange: (state: ConductorState) => void = () => {},
  clock: ControllerClock = realClock,
): VoiceConductorController {
  let state: ConductorState = { hud: null, busy: false };
  let hudSeq = 0;
  let hudTimer: unknown = null;
  let pending: { command: ResolvedCommand; timer: unknown; kind: 'confirm' | 'fallback' } | null =
    null;
  let lastUndo: { label: string; run: () => Promise<void> | void; expiresAt: number } | null = null;

  function publish(next: Partial<ConductorState>) {
    state = { ...state, ...next };
    onChange(state);
  }

  function showHud(hud: Omit<ConductorHud, 'id'>, lifetimeMs: number | null) {
    if (hudTimer !== null) clock.clearTimeout(hudTimer);
    hudTimer = null;
    const id = ++hudSeq;
    publish({ hud: { ...hud, id } });
    if (lifetimeMs !== null) {
      hudTimer = clock.setTimeout(() => {
        hudTimer = null;
        if (state.hud?.id === id) publish({ hud: null });
      }, lifetimeMs);
    }
  }

  function clearPending() {
    if (pending) clock.clearTimeout(pending.timer);
    pending = null;
  }

  function undoAvailable(): boolean {
    if (lastUndo && lastUndo.expiresAt <= clock.now()) lastUndo = null;
    return !!lastUndo;
  }

  function resolve(intent: ConductorIntent, sessionId: string): Resolution {
    const needChat = (): { error: string } | null =>
      sessionId ? null : { error: 'Open a chat first.' };

    switch (intent.type) {
      case 'status': {
        const missing = needChat();
        if (missing) return missing;
        return {
          title:
            intent.target.kind === 'all' ? 'Status' : `Status of ${targetLabel(intent.target)}`,
          destructive: false,
          run: async () => {
            const text = describeStatus(
              actions.managerStatus(sessionId),
              actions.listWorkers(sessionId),
              intent.target,
            );
            return { title: 'Status', detail: text, tone: 'info', speak: text, sticky: true };
          },
        };
      }

      case 'stop': {
        const missing = needChat();
        if (missing) return missing;
        if (intent.target.kind === 'all' || intent.target.kind === 'manager') {
          const title =
            intent.target.kind === 'all' ? 'Stop all agents in this chat' : 'Stop the manager';
          return {
            title,
            destructive: true,
            run: async () => {
              await actions.cancelSession(sessionId);
              return {
                title: intent.target.kind === 'all' ? 'Stopped all agents' : 'Stopped the manager',
                tone: 'success',
              };
            },
          };
        }
        const workers = actions.listWorkers(sessionId);
        const worker = resolveWorker(workers, intent.target);
        if ('error' in worker) return worker;
        const label = workerLabel(worker, workers);
        return {
          title: `Stop ${label}`,
          destructive: true,
          run: async () => {
            await actions.cancelAgent(sessionId, worker.id);
            return { title: `Stopped ${label}`, tone: 'success' };
          },
        };
      }

      case 'steer': {
        const missing = needChat();
        if (missing) return missing;
        if (intent.target.kind === 'manager') {
          return {
            title: `Tell the manager: “${truncate(intent.message)}”`,
            destructive: false,
            run: async () => {
              const ok = await actions.steerManager(sessionId, intent.message);
              return ok
                ? { title: 'Sent to the manager', detail: intent.message, tone: 'success' }
                : { title: 'The manager did not accept the message', tone: 'error' };
            },
          };
        }
        const workers = actions.listWorkers(sessionId);
        const worker = resolveWorker(workers, intent.target);
        if ('error' in worker) return worker;
        const label = workerLabel(worker, workers);
        return {
          title: `Tell ${label}: “${truncate(intent.message)}”`,
          destructive: false,
          run: async () => {
            const ok = await actions.messageAgent(sessionId, worker.id, intent.message);
            return ok
              ? { title: `Sent to ${label}`, detail: intent.message, tone: 'success' }
              : { title: `${capitalizeFirst(label)} did not accept the message`, tone: 'error' };
          },
        };
      }

      case 'new_chat':
        return {
          title: intent.topic ? `New chat: ${truncate(intent.topic, 60)}` : 'New chat',
          destructive: false,
          run: async () => {
            const previous = sessionId;
            const created = await actions.createChat();
            if (!created) return { title: 'Could not create a chat', tone: 'error' };
            if (intent.topic) await actions.renameChat(created, intent.topic);
            return {
              title: intent.topic
                ? `Started “${truncate(intent.topic, 60)}”`
                : 'Started a new chat',
              tone: 'success',
              undo: {
                label: 'Undo new chat',
                // Archive, not delete: undo must itself be reversible.
                run: async () => {
                  if (previous) actions.selectChat(previous);
                  await actions.archiveChat(created);
                },
              },
            };
          },
        };

      case 'switch_chat': {
        const chat = findChat(
          actions.listChats().filter((c) => c.id !== sessionId),
          intent.query,
        );
        if (!chat) return { error: `No chat matches “${intent.query}”.` };
        return {
          title: `Open chat “${truncate(chat.title, 60)}”`,
          destructive: false,
          run: async () => {
            const previous = sessionId;
            actions.selectChat(chat.id);
            return {
              title: `Opened “${truncate(chat.title, 60)}”`,
              tone: 'success',
              undo: previous
                ? { label: 'Back to previous chat', run: () => actions.selectChat(previous) }
                : undefined,
            };
          },
        };
      }

      case 'open_panel':
        return {
          title: `Open ${PANEL_LABEL[intent.panel]}`,
          destructive: false,
          run: async () =>
            actions.openPanel(intent.panel)
              ? { title: `Opened ${PANEL_LABEL[intent.panel]}`, tone: 'success' }
              : { title: `${PANEL_LABEL[intent.panel]} is not available here`, tone: 'warning' },
        };

      case 'note': {
        if (!actions.notesEnabled())
          return { error: 'Notes are turned off. Enable Notes in Settings.' };
        const note = actions.currentNote();
        if (note) {
          return {
            title: `Add to note “${truncate(note.title, 40)}”`,
            destructive: false,
            run: async () => {
              const before = note.content;
              const ok = await actions.updateNoteContent(
                note.id,
                appendToNoteContent(note, intent.text),
              );
              if (!ok) return { title: 'Could not update the note', tone: 'error' };
              return {
                title: `Added to “${truncate(note.title, 40)}”`,
                detail: intent.text,
                tone: 'success',
                undo: {
                  label: 'Undo note',
                  run: async () => {
                    await actions.updateNoteContent(note.id, before);
                  },
                },
              };
            },
          };
        }
        const title = truncate(intent.text.split(/[.!?\n]/)[0] || 'Voice note', 60);
        return {
          title: `New note “${title}”`,
          destructive: false,
          run: async () => {
            const id = await actions.createNote(title, intent.text);
            if (!id) return { title: 'Could not create the note', tone: 'error' };
            return {
              title: `Created note “${title}”`,
              detail: intent.text,
              tone: 'success',
              undo: {
                label: 'Undo note',
                // Trash, not purge: the note stays restorable from Notes.
                run: async () => {
                  await actions.trashNote(id);
                },
              },
            };
          },
        };
      }

      case 'read_aloud': {
        const missing = needChat();
        if (missing) return missing;
        const reply = actions.lastReply(sessionId);
        if (!reply) return { error: 'There is no reply to read in this chat yet.' };
        return {
          title: 'Read the last reply',
          destructive: false,
          run: async () => {
            void actions.speak(reply.id, reply.text).catch(() => undefined);
            return {
              title: 'Reading the last reply',
              detail: truncate(reply.text, 160),
              tone: 'info',
            };
          },
        };
      }

      case 'stop_reading':
        return {
          title: 'Stop reading',
          destructive: false,
          run: async () => {
            actions.stopSpeaking();
            return { title: 'Stopped reading', tone: 'success' };
          },
        };

      case 'delete_chat': {
        const missing = needChat();
        if (missing) return missing;
        const chat = actions.listChats().find((c) => c.id === sessionId);
        const name = chat?.title ? `“${truncate(chat.title, 50)}”` : 'this chat';
        return {
          title: `Delete ${name}`,
          destructive: true,
          run: async () => {
            const ok = await actions.deleteChat(sessionId);
            return ok
              ? { title: `Deleted ${name}`, tone: 'success' }
              : { title: `Could not delete ${name}`, tone: 'error' };
          },
        };
      }

      case 'undo':
      case 'confirm':
      case 'deny':
      case 'unknown':
        return { error: 'Not a command.' };
    }
  }

  async function execute(command: ResolvedCommand, heard?: string) {
    publish({ busy: true });
    let outcome: CommandOutcome;
    try {
      outcome = await command.run();
    } catch (error) {
      outcome = {
        title: `${command.title} failed`,
        detail: error instanceof Error ? error.message : String(error),
        tone: 'error',
      };
    }
    publish({ busy: false });
    if (outcome.undo) {
      lastUndo = { ...outcome.undo, expiresAt: clock.now() + UNDO_WINDOW_MS };
    }
    showHud(
      {
        tone: outcome.tone ?? 'success',
        title: outcome.title ?? command.title,
        detail: outcome.detail,
        heard,
        canUndo: !!outcome.undo,
        undoLabel: outcome.undo?.label,
      },
      outcome.sticky ? ANSWER_HUD_MS : outcome.tone === 'error' ? ERROR_HUD_MS : DONE_HUD_MS,
    );
    if (outcome.speak) {
      const text = outcome.speak;
      void actions
        .spokenRepliesEnabled()
        .then((enabled) => (enabled ? actions.speak(`conductor-${hudSeq}`, text) : undefined))
        .catch(() => undefined);
    }
  }

  function askToConfirm(
    command: ResolvedCommand,
    kind: 'confirm' | 'fallback',
    heard: string,
    detail?: string,
  ) {
    clearPending();
    const windowMs = kind === 'confirm' ? CONFIRM_WINDOW_MS : FALLBACK_WINDOW_MS;
    const timer = clock.setTimeout(() => {
      if (pending?.timer !== timer) return;
      pending = null;
      if (kind === 'confirm') {
        showHud(
          { tone: 'info', title: 'Not confirmed — nothing changed', heard, canUndo: false },
          DONE_HUD_MS,
        );
      } else {
        publish({ hud: null });
      }
    }, windowMs);
    pending = { command, timer, kind };
    showHud(
      {
        tone: kind === 'confirm' ? 'confirm' : 'fallback',
        title: command.title,
        detail,
        heard,
        canUndo: false,
        confirm: {
          label: kind === 'confirm' ? 'Confirm' : 'Send',
          expiresAt: clock.now() + windowMs,
          destructive: kind === 'confirm',
        },
      },
      null,
    );
  }

  async function confirm() {
    if (!pending) return;
    const { command } = pending;
    const heard = state.hud?.heard;
    clearPending();
    await execute(command, heard);
  }

  function dismiss() {
    const wasPending = !!pending;
    clearPending();
    if (hudTimer !== null) clock.clearTimeout(hudTimer);
    hudTimer = null;
    if (wasPending) {
      showHud({ tone: 'info', title: 'Cancelled — nothing changed', canUndo: false }, 2_500);
    } else {
      publish({ hud: null });
    }
  }

  async function undo() {
    if (!undoAvailable() || !lastUndo) {
      showHud({ tone: 'info', title: 'Nothing to undo', canUndo: false }, ERROR_HUD_MS);
      return;
    }
    const entry = lastUndo;
    lastUndo = null;
    try {
      await entry.run();
      showHud({ tone: 'success', title: `${entry.label} — done`, canUndo: false }, DONE_HUD_MS);
    } catch (error) {
      showHud(
        {
          tone: 'error',
          title: 'Undo failed',
          detail: error instanceof Error ? error.message : String(error),
          canUndo: false,
        },
        ERROR_HUD_MS,
      );
    }
  }

  async function handleUtterance(text: string) {
    const heard = text.trim();
    if (pending) {
      if (isAffirmative(heard)) return confirm();
      if (isNegative(heard)) return dismiss();
      // Anything else replaces the question with the new command.
      clearPending();
    }
    if (!heard) {
      showHud(
        { tone: 'info', title: 'Listening — say a command after the wake phrase', canUndo: false },
        DONE_HUD_MS,
      );
      return;
    }
    // Capture the chat now: a confirmation that lands after the user switched
    // chats must still act on the chat the command was spoken in.
    const sessionId = actions.activeSessionId();
    const intent = parseConductorUtterance(heard);

    if (intent.type === 'undo') return undo();
    if (intent.type === 'confirm' || intent.type === 'deny') {
      showHud(
        { tone: 'info', title: 'Nothing is waiting for confirmation', heard, canUndo: false },
        DONE_HUD_MS,
      );
      return;
    }
    if (intent.type === 'unknown') {
      if (!sessionId) {
        showHud(
          { tone: 'warning', title: 'Not a command I know', detail: heard, heard, canUndo: false },
          ERROR_HUD_MS,
        );
        return;
      }
      const message = intent.text;
      askToConfirm(
        {
          title: 'Send to the manager as steering?',
          destructive: false,
          run: async () => {
            const ok = await actions.steerManager(sessionId, message);
            return ok
              ? { title: 'Sent to the manager', detail: message, tone: 'success' }
              : { title: 'The manager did not accept the message', tone: 'error' };
          },
        },
        'fallback',
        heard,
        message,
      );
      return;
    }

    const resolved = resolve(intent, sessionId);
    if ('error' in resolved) {
      showHud({ tone: 'warning', title: resolved.error, heard, canUndo: false }, ERROR_HUD_MS);
      return;
    }
    if (resolved.destructive || isDestructiveIntent(intent)) {
      askToConfirm(resolved, 'confirm', heard, 'Tap Confirm or say “yes” within 5 seconds.');
      return;
    }
    await execute(resolved, heard);
  }

  return {
    get state() {
      return state;
    },
    get awaitingConfirmation() {
      return !!pending;
    },
    handleUtterance,
    confirm,
    dismiss,
    undo,
    dispose() {
      clearPending();
      if (hudTimer !== null) clock.clearTimeout(hudTimer);
      hudTimer = null;
    },
  };
}
