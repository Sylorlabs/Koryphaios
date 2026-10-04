import type { SharedTeamFolder } from '@koryphaios/shared';

export interface JoinedTeamSessionRecord {
  sessionId: string;
  sessionName: string;
  inviteUrl: string;
  tierId: string;
  joinedAt: number;
  hostName?: string;
  sharedFolders?: SharedTeamFolder[];
}

/** Older joins restore without invented folder names; never accept host paths. */
export function parseSharedTeamFolders(value: unknown): SharedTeamFolder[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((folder) =>
    typeof folder?.id === 'string' && typeof folder?.name === 'string' &&
    folder.name.trim() && !/[\\/]/.test(folder.name) && !['.', '..'].includes(folder.name)
      ? [{ id: folder.id.slice(0, 64), name: folder.name.slice(0, 160) }]
      : []);
}

export function upsertJoinedTeamSession<T extends JoinedTeamSessionRecord>(
  sessions: T[],
  joined: T,
): T[] {
  return [...sessions.filter((session) => session.sessionId !== joined.sessionId), joined];
}

export function activateJoinedTeamSession<T extends JoinedTeamSessionRecord>(
  sessions: T[],
  sessionId: string,
): string | null {
  return sessions.some((session) => session.sessionId === sessionId) ? sessionId : null;
}

export function leaveJoinedTeamSession<T extends JoinedTeamSessionRecord>(
  sessions: T[],
  activeSessionId: string | null,
  sessionId: string,
): { sessions: T[]; activeSessionId: string | null } {
  return {
    sessions: sessions.filter((session) => session.sessionId !== sessionId),
    activeSessionId: activeSessionId === sessionId ? null : activeSessionId,
  };
}
