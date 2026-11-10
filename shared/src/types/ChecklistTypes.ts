/**
 * Lightweight checklist contracts.
 *
 * A checklist is the app-wide, notes-style counterpart to a Goal's checklist:
 * a durable, freely-writable list of steps that any agent or human can create,
 * add to, check off, and delete in any chat. It carries no evidence gate and
 * no verification semantics -- that is what `Goal.checklist` is for. Use a
 * checklist to track work in progress; use a Goal when completion must be
 * independently verified.
 */

export type ChecklistItemStatus = 'pending' | 'done' | 'skipped';

/**
 * Ownership scope. A workspace checklist is reachable from every chat;
 * `session` and `project` narrow visibility to one chat or one project.
 * A checklist created from a chat defaults to `session` for that chat.
 */
export type ChecklistScope = 'workspace' | 'project' | 'session';

export interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistItemStatus;
  order: number;
  /** Optional free-text note, e.g. a command output or a decision. */
  note?: string;
  completedAt?: number;
  createdAt: number;
}

export interface ChecklistActivity {
  id: string;
  /** `actor` is a human; an agent actor carries its role so the UI can label it. */
  type: string;
  message: string;
  actor?: string;
  actorRole?: 'human' | 'manager' | 'worker' | 'critic';
  createdAt: number;
  sessionId?: string;
}

export interface Checklist {
  id: string;
  title: string;
  scope: ChecklistScope;
  projectPath?: string;
  sessionId?: string;
  items: ChecklistItem[];
  /** Append-only audit trail. Every entry records who made the change, so a
   *  list edited by a worker agent reads differently from one you edited. */
  activity: ChecklistActivity[];
  /** Cleared when the checklist is finished; finished lists stay readable. */
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Fraction of items that are done, as a whole percentage. */
export const checklistProgress = (checklist: Pick<Checklist, 'items'>): number => {
  const total = checklist.items.length;
  if (total === 0) return 0;
  const settled = checklist.items.filter(
    (item) => item.status === 'done' || item.status === 'skipped',
  ).length;
  return Math.round((settled / total) * 100);
};

/**
 * A change to a checklist's contents. Any actor -- human or agent -- submits
 * the same shape, so there is exactly one write path to authorize, render, and
 * test.
 */
export interface ChecklistMutation {
  id?: Checklist['id'];
  title: string;
  scope?: ChecklistScope;
  projectPath?: string;
  sessionId?: string;
  /**
   * Full replacement plan. Items absent from this array are removed, so an
   * actor that wants to clear a list sends an empty array.
   */
  items?: { id?: string; title: string; order?: number }[];
}

/** Tool names that operate on checklists. Used for permission categorization. */
export const CHECKLIST_TOOL_NAMES = [
  'create_checklist',
  'list_checklists',
  'read_checklist',
  'update_checklist',
  'add_checklist_item',
  'check_checklist_item',
  'delete_checklist',
  'edit_goal_checklist',
] as const;

export type ChecklistToolName = (typeof CHECKLIST_TOOL_NAMES)[number];

export const isChecklistToolName = (name: string): name is ChecklistToolName =>
  (CHECKLIST_TOOL_NAMES as readonly string[]).includes(name);
