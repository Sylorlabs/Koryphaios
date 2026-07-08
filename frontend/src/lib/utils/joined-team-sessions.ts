export interface JoinedTeamSessionRecord {
  sessionId: string;
  sessionName: string;
  inviteUrl: string;
  tierId: string;
  joinedAt: number;
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
