/**
 * Copy for the session archive and delete warning screens.
 *
 * Archiving and deleting a session both tear down the session's agent tree, so
 * both screens must carry the same warning and differ only by verb. Keeping the
 * copy in one place is what stops the two screens from drifting apart — the
 * archive screen and the delete screen are generated from the same templates.
 */

export type SessionLifecycleAction = 'archive' | 'delete';

const GERUNDS: Record<SessionLifecycleAction, string> = {
  archive: 'Archiving',
  delete: 'Deleting',
};

export function sessionLifecycleTitle(action: SessionLifecycleAction): string {
  return action === 'archive' ? 'Archive Session?' : 'Delete Session?';
}

/**
 * The warning body. The only difference between the archive and delete variants
 * is the leading verb.
 */
export function sessionLifecycleWarning(action: SessionLifecycleAction): string {
  return (
    `${GERUNDS[action]} this session will stop the current agent and all of its sub-agents. ` +
    'Any work still in progress is cancelled.'
  );
}

export function sessionLifecycleConfirmLabel(action: SessionLifecycleAction): string {
  return action === 'archive' ? 'Archive Session' : 'Delete Session';
}
