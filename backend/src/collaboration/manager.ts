import { nanoid } from 'nanoid';
import { db, collaborationSessions, sessionParticipants } from '../db';
import { eq, and } from 'drizzle-orm';
import { tunnelManager } from './tunnel';
import { randomBytes } from 'crypto';

export class CollaborationManager {
  private generateJoinCode(): string {
    return randomBytes(4).toString('hex').toUpperCase(); // 8 character code
  }

  async hostSession(baseSessionId: string, ownerId: string) {
    // 1. Check if already hosting this session
    const [existing] = await db
      .select()
      .from(collaborationSessions)
      .where(
        and(
          eq(collaborationSessions.baseSessionId, baseSessionId),
          eq(collaborationSessions.status, 'active'),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }

    // 2. Start the localtunnel
    const tunnelUrl = await tunnelManager.startTunnel();

    // 3. Create the collaboration session record
    const id = nanoid();
    const joinCode = this.generateJoinCode();

    const [session] = await db
      .insert(collaborationSessions)
      .values({
        id,
        baseSessionId,
        ownerId,
        joinCode,
        tunnelUrl,
        status: 'active',
        createdAt: new Date(),
      })
      .returning();

    // 4. Add owner as a participant
    await db.insert(sessionParticipants).values({
      id: nanoid(),
      sessionId: id,
      userId: ownerId,
      name: 'Host', // Could pull from user profile later
      role: 'owner',
      lastActive: new Date(),
    });

    return {
      id: session.id,
      joinCode: session.joinCode,
      tunnelUrl: session.tunnelUrl,
    };
  }

  async joinSession(joinCode: string, userId: string, name: string) {
    // 1. Find active session with this code
    const [session] = await db
      .select()
      .from(collaborationSessions)
      .where(
        and(
          eq(collaborationSessions.joinCode, joinCode),
          eq(collaborationSessions.status, 'active'),
        ),
      )
      .limit(1);

    if (!session) {
      throw new Error('Invalid or inactive join code');
    }

    // 2. Check if user is already a participant
    const [existingParticipant] = await db
      .select()
      .from(sessionParticipants)
      .where(
        and(eq(sessionParticipants.sessionId, session.id), eq(sessionParticipants.userId, userId)),
      )
      .limit(1);

    if (!existingParticipant) {
      await db.insert(sessionParticipants).values({
        id: nanoid(),
        sessionId: session.id,
        userId,
        name,
        role: 'viewer', // Default to viewer
        lastActive: new Date(),
      });
    } else {
      // Update last active
      await db
        .update(sessionParticipants)
        .set({ lastActive: new Date() })
        .where(eq(sessionParticipants.id, existingParticipant.id));
    }

    return session;
  }

  async endSession(id: string) {
    await db
      .update(collaborationSessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(collaborationSessions.id, id));

    // Check if any other sessions are active, if not, we can close the tunnel
    const activeSessions = await db
      .select()
      .from(collaborationSessions)
      .where(eq(collaborationSessions.status, 'active'));

    if (activeSessions.length === 0) {
      tunnelManager.stopTunnel();
    }
  }

  async getSessionState(id: string) {
    const [session] = await db
      .select()
      .from(collaborationSessions)
      .where(eq(collaborationSessions.id, id))
      .limit(1);

    if (!session) return null;

    const participants = await db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, id));

    return {
      session,
      participants,
    };
  }
}

export const collaborationManager = new CollaborationManager();
