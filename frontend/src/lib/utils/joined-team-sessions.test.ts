import { describe, expect, it } from 'bun:test';
import {
  activateJoinedTeamSession,
  leaveJoinedTeamSession,
  upsertJoinedTeamSession,
  type JoinedTeamSessionRecord,
} from './joined-team-sessions';

const team = (sessionId: string, joinedAt: number): JoinedTeamSessionRecord => ({
  sessionId,
  sessionName: `Team ${sessionId}`,
  inviteUrl: `https://relay.example/join?team=${sessionId}`,
  tierId: 'collaborator',
  joinedAt,
});

describe('joined team session state', () => {
  it('retains multiple teams and refreshes an existing team without duplicating it', () => {
    let sessions = upsertJoinedTeamSession([], team('alpha', 1));
    sessions = upsertJoinedTeamSession(sessions, team('beta', 2));
    sessions = upsertJoinedTeamSession(sessions, team('alpha', 3));

    expect(sessions.map((session) => session.sessionId)).toEqual(['beta', 'alpha']);
    expect(sessions[1]?.joinedAt).toBe(3);
  });

  it('only activates known teams and clears selection when the active team is left', () => {
    const sessions = [team('alpha', 1), team('beta', 2)];
    expect(activateJoinedTeamSession(sessions, 'missing')).toBeNull();
    expect(activateJoinedTeamSession(sessions, 'beta')).toBe('beta');

    const next = leaveJoinedTeamSession(sessions, 'beta', 'beta');
    expect(next.sessions.map((session) => session.sessionId)).toEqual(['alpha']);
    expect(next.activeSessionId).toBeNull();
  });
});
