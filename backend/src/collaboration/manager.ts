import { nanoid } from 'nanoid';
import { db, collaborationSessions, sessionParticipants } from '../db';
import { eq, and } from 'drizzle-orm';
import { relayClient, relayEnabled } from './relay-client';
import { serverLog } from '../logger';

const log = serverLog.child({ module: 'collab-manager' });

// ─── Pending approvals (in-memory, cleared on restart) ──────────────────────

export interface PendingPrompt {
  guestId: string;
  name: string;
  role: string;
  content: string;
  sessionId: string;
  timestamp: number;
}

const pendingPrompts = new Map<string, PendingPrompt>(); // promptId → prompt
let approvalListeners: Array<(p: PendingPrompt & { promptId: string }) => void> = [];

export function onGuestPrompt(fn: typeof approvalListeners[0]) {
  approvalListeners.push(fn);
  return () => { approvalListeners = approvalListeners.filter(l => l !== fn); };
}

function emitPendingPrompt(promptId: string, p: PendingPrompt) {
  approvalListeners.forEach(fn => { try { fn({ ...p, promptId }); } catch {} });
}

// ─── CollaborationManager ────────────────────────────────────────────────────

export class CollaborationManager {
  private generateJoinCode(): string {
    // Legacy local join code — kept for DB compat, not used by relay flow
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  async hostSession(baseSessionId: string, ownerId: string): Promise<{
    id: string;
    joinCode: string;
    tunnelUrl: string;
    inviteLinks: Record<string, string>;
    relayEnabled: boolean;
  }> {
    // Check if already hosting this session
    const [existing] = await db
      .select()
      .from(collaborationSessions)
      .where(and(
        eq(collaborationSessions.baseSessionId, baseSessionId),
        eq(collaborationSessions.status, 'active'),
      ))
      .limit(1);

    let sessionId: string;
    let joinCode: string;
    let tunnelUrl = '';

    if (existing) {
      sessionId = existing.id;
      joinCode = existing.joinCode;
      tunnelUrl = existing.tunnelUrl ?? '';
    } else {
      sessionId = nanoid();
      joinCode = this.generateJoinCode();

      // Start relay session if configured
      if (relayEnabled && relayClient) {
        try {
          const { sessionId: relaySessionId, inviteBase } = await relayClient.startSession(sessionId);
          tunnelUrl = `${inviteBase}/join`;
          log.info({ relaySessionId }, 'Relay session started');

          // Wire up guest prompt handler
          relayClient.onMessage((msg) => {
            if (msg.type === 'guest-prompt') {
              const promptId = nanoid();
              const pending: PendingPrompt = {
                guestId: msg.guestId as string,
                name: msg.name as string,
                role: msg.role as string,
                content: msg.content as string,
                sessionId,
                timestamp: Date.now(),
              };
              pendingPrompts.set(promptId, pending);
              emitPendingPrompt(promptId, pending);
            }
          });
        } catch (err: any) {
          log.error({ err: err.message }, 'Failed to start relay session');
        }
      }

      await db.insert(collaborationSessions).values({
        id: sessionId,
        baseSessionId,
        ownerId,
        joinCode,
        tunnelUrl,
        status: 'active',
        createdAt: new Date(),
      });

      await db.insert(sessionParticipants).values({
        id: nanoid(),
        sessionId,
        userId: ownerId,
        name: 'Host',
        role: 'owner',
        lastActive: new Date(),
      });
    }

    // Generate invite links for all roles
    const inviteLinks: Record<string, string> = {};
    if (relayEnabled && relayClient) {
      for (const role of ['viewer', 'collaborator', 'copilot'] as const) {
        try {
          inviteLinks[role] = await relayClient.createInvite(role);
        } catch (err: any) {
          log.warn({ role, err: err.message }, 'Failed to create invite link');
        }
      }
    }

    return { id: sessionId, joinCode, tunnelUrl, inviteLinks, relayEnabled };
  }

  /** Approve or reject a pending guest prompt. Returns the prompt content if approved. */
  resolveGuestPrompt(promptId: string, approved: boolean): PendingPrompt | null {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt) return null;
    pendingPrompts.delete(promptId);
    if (relayClient) relayClient.approveGuestPrompt(prompt.guestId, approved);
    return approved ? prompt : null;
  }

  getPendingPrompts(): Array<PendingPrompt & { promptId: string }> {
    return Array.from(pendingPrompts.entries()).map(([promptId, p]) => ({ ...p, promptId }));
  }

  /** Broadcast an event to all guests via relay. Call this from the agent event loop. */
  broadcastEvent(event: Record<string, unknown>) {
    if (relayClient?.isConnected) {
      relayClient.broadcast(event);
    }
  }

  async joinSession(joinCode: string, userId: string, name: string) {
    const [session] = await db
      .select()
      .from(collaborationSessions)
      .where(and(
        eq(collaborationSessions.joinCode, joinCode),
        eq(collaborationSessions.status, 'active'),
      ))
      .limit(1);

    if (!session) throw new Error('Invalid or inactive join code');

    const [existingParticipant] = await db
      .select()
      .from(sessionParticipants)
      .where(and(
        eq(sessionParticipants.sessionId, session.id),
        eq(sessionParticipants.userId, userId),
      ))
      .limit(1);

    if (!existingParticipant) {
      await db.insert(sessionParticipants).values({
        id: nanoid(),
        sessionId: session.id,
        userId,
        name,
        role: 'viewer',
        lastActive: new Date(),
      });
    } else {
      await db.update(sessionParticipants)
        .set({ lastActive: new Date() })
        .where(eq(sessionParticipants.id, existingParticipant.id));
    }

    return session;
  }

  async endSession(id: string) {
    await db.update(collaborationSessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(collaborationSessions.id, id));

    if (relayClient) await relayClient.disconnect();
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

    return { session, participants };
  }
}

export const collaborationManager = new CollaborationManager();
