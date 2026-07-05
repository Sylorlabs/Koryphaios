import { nanoid } from 'nanoid';
import { db, collaborationSessions, sessionParticipants } from '../db';
import { eq, and } from 'drizzle-orm';
import { relayClient, relayEnabled, resolveRelayJoinCode } from './relay-client';
import { serverLog } from '../logger';
import { DEFAULT_COLLABORATION_POLICY, type CollaborationPolicy } from '@koryphaios/shared';

const log = serverLog.child({ module: 'collab-manager' });
const SAFE_TIER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function normalizePolicy(current: CollaborationPolicy, patch: Partial<CollaborationPolicy>): CollaborationPolicy {
  const tiers = Array.isArray(patch.accessTiers) ? patch.accessTiers.slice(0, 24).map((tier) => ({
    ...tier,
    id: String(tier.id).toLowerCase().trim(),
    name: String(tier.name).trim().slice(0, 40),
    description: String(tier.description || '').slice(0, 180),
    allowedModels: [...new Set((tier.allowedModels || []).filter(v => typeof v === 'string'))].slice(0, 200),
    reasoningByModel: Object.fromEntries(Object.entries(tier.reasoningByModel || {}).slice(0, 200).map(([model, levels]) => [model, [...new Set((Array.isArray(levels) ? levels : []).filter(v => typeof v === 'string'))].slice(0, 12)])),
    permissions: {
      ...tier.permissions,
      readPaths: [...new Set((tier.permissions?.readPaths || []).filter(v => typeof v === 'string'))].slice(0, 100),
      writePaths: [...new Set((tier.permissions?.writePaths || []).filter(v => typeof v === 'string'))].slice(0, 100),
      commandAllowlist: [...new Set((tier.permissions?.commandAllowlist || []).filter(v => typeof v === 'string'))].slice(0, 100),
      commandBlocklist: [...new Set((tier.permissions?.commandBlocklist || []).filter(v => typeof v === 'string'))].slice(0, 100),
    },
  })).filter(tier => SAFE_TIER_ID.test(tier.id) && tier.name) : current.accessTiers;
  if (!tiers.length) throw new Error('At least one valid access tier is required');
  const defaultTierId = tiers.some(t => t.id === patch.defaultTierId) ? patch.defaultTierId! : (tiers.some(t => t.id === current.defaultTierId) ? current.defaultTierId : tiers[0].id);
  return { ...DEFAULT_COLLABORATION_POLICY, ...current, ...patch, accessTiers: tiers, defaultTierId,
    sessionName: String(patch.sessionName ?? current.sessionName ?? 'Team session').trim().slice(0, 80) || 'Team session',
    workspacePaths: Array.isArray(patch.workspacePaths)
      ? [...new Set(patch.workspacePaths.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))].slice(0, 24)
      : current.workspacePaths,
    modelCatalog: Array.isArray(patch.modelCatalog) ? patch.modelCatalog.slice(0, 200).map(model => ({ id: String(model.id), label: String(model.label), provider: String(model.provider), reasoningLevels: [...new Set((model.reasoningLevels || []).filter(v => typeof v === 'string'))].slice(0, 12) })) : current.modelCatalog,
    joinMode: patch.joinMode === 'auto' ? 'auto' : patch.joinMode === 'approval' ? 'approval' : current.joinMode };
}

// ─── Pending approvals (in-memory, cleared on restart) ──────────────────────

export interface PendingPrompt {
  guestId: string;
  name: string;
  role: string;
  content: string;
  sessionId: string;
  timestamp: number;
  model?: string;
  reasoningLevel?: string;
  commandAllowlist?: string[];
  commandBlocklist?: string[];
  tierId?: string;
}

export interface PendingJoin { guestId: string; name: string; tierId: string; sessionId: string; timestamp: number }

const pendingPrompts = new Map<string, PendingPrompt>(); // promptId → prompt
const pendingJoins = new Map<string, PendingJoin>();
const connectedGuests = new Map<string, { guestId: string; name: string; tierId: string; admitted: boolean }>();
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

  async hostSession(baseSessionId: string, ownerId: string, workspacePaths: string[] = []): Promise<{
    id: string;
    joinCode: string;
    tunnelUrl: string;
    inviteLinks: Record<string, string>;
    relayEnabled: boolean;
    relayError?: string;
    policy: CollaborationPolicy;
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
    let localJoinCode: string;
    let tunnelUrl = '';
    let relayReady = false;
    let relayError: string | undefined;

    const requestedWorkspacePaths = [...new Set(workspacePaths.map(path => path.trim()).filter(Boolean))].slice(0, 24);

    if (existing) {
      sessionId = existing.id;
      joinCode = existing.joinCode;
      localJoinCode = existing.joinCode;
      tunnelUrl = existing.tunnelUrl ?? '';
    } else {
      sessionId = nanoid();
      joinCode = this.generateJoinCode();
      localJoinCode = joinCode;

      // Start relay session if configured
      if (relayEnabled && relayClient) {
        try {
          const { sessionId: relaySessionId, inviteBase, joinCode: relayJoinCode } = await relayClient.startSession(sessionId);
          tunnelUrl = `${inviteBase}/join`;
          if (relayJoinCode) joinCode = relayJoinCode;
          log.info({ relaySessionId }, 'Relay session started');
          relayReady = true;

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
                model: String(msg.model || ''),
                reasoningLevel: String(msg.reasoningLevel || ''),
                commandAllowlist: Array.isArray(msg.commandAllowlist) ? msg.commandAllowlist.map(String) : [],
                commandBlocklist: Array.isArray(msg.commandBlocklist) ? msg.commandBlocklist.map(String) : [],
                tierId: String(msg.tierId || msg.role || ''),
              };
              if (msg.autoExecute === true) {
                void import('../context').then(({ getContext }) => getContext().kory.processTask(baseSessionId, pending.content, pending.model || undefined, pending.reasoningLevel || undefined, undefined, { commandAllowlist: pending.commandAllowlist || [], commandBlocklist: pending.commandBlocklist || [] }));
                return;
              }
              pendingPrompts.set(promptId, pending);
              emitPendingPrompt(promptId, pending);
            } else if (msg.type === 'join-request') {
              const guestId = String(msg.guestId);
              pendingJoins.set(guestId, { guestId, name: String(msg.name || 'Guest'), tierId: String(msg.tierId || 'viewer'), sessionId, timestamp: Date.now() });
            } else if (msg.type === 'guest-list' && Array.isArray(msg.guests)) {
              connectedGuests.clear();
              for (const guest of msg.guests as any[]) connectedGuests.set(String(guest.guestId), { guestId: String(guest.guestId), name: String(guest.name || 'Guest'), tierId: String(guest.tierId || 'viewer'), admitted: guest.admitted !== false });
            } else if (msg.type === 'guest-joined') {
              connectedGuests.set(String(msg.guestId), { guestId: String(msg.guestId), name: String(msg.name || 'Guest'), tierId: String(msg.role || 'viewer'), admitted: true });
            } else if (msg.type === 'guest-left') {
              connectedGuests.delete(String(msg.guestId)); pendingJoins.delete(String(msg.guestId));
            }
          });
        } catch (err: any) {
          log.error({ err: err.message }, 'Failed to start relay session');
        }
      }

      const initialPolicy = normalizePolicy(DEFAULT_COLLABORATION_POLICY, { workspacePaths: requestedWorkspacePaths });
      await db.insert(collaborationSessions).values({
        id: sessionId,
        baseSessionId,
        ownerId,
        joinCode,
        tunnelUrl,
        status: 'active',
        aiState: JSON.stringify(initialPolicy),
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

    let policy: CollaborationPolicy = existing?.aiState
      ? { ...DEFAULT_COLLABORATION_POLICY, ...JSON.parse(existing.aiState) }
      : normalizePolicy(DEFAULT_COLLABORATION_POLICY, { workspacePaths: requestedWorkspacePaths });
    if (existing && requestedWorkspacePaths.length) {
      policy = normalizePolicy(policy, { workspacePaths: requestedWorkspacePaths });
      await db.update(collaborationSessions).set({ aiState: JSON.stringify(policy) })
        .where(eq(collaborationSessions.id, sessionId));
    }
    if (relayClient?.isConnected) {
      try {
        await relayClient.updatePolicy(policy);
        relayReady = true;
      } catch (err: any) {
        // An older relay may support session creation but not host-owned policy.
        // Never expose guests through a relay that cannot enforce the policy;
        // keep the local collaboration session usable instead.
        log.error({ err: err.message }, 'Relay does not support required host policy; continuing locally');
        await relayClient.disconnect();
        relayReady = false;
        relayError = 'The configured relay is outdated and does not support enforced host policies. Hosting is active locally; upgrade the relay to restore internet invites.';
        joinCode = localJoinCode;
        tunnelUrl = '';
        await db.update(collaborationSessions).set({ joinCode, tunnelUrl })
          .where(eq(collaborationSessions.id, sessionId));
      }
    }

    // Generate an invite link for every host-defined access tier.
    const inviteLinks: Record<string, string> = {};
    if (relayReady && relayClient) {
      for (const role of policy.accessTiers.map(t => t.id)) {
        try {
          inviteLinks[role] = await relayClient.createInvite(role);
        } catch (err: any) {
          log.warn({ role, err: err.message }, 'Failed to create invite link');
        }
      }
    }

    return { id: sessionId, joinCode, tunnelUrl, inviteLinks, relayEnabled: relayReady, relayError, policy };
  }

  async updatePolicy(id: string, patch: Partial<CollaborationPolicy>): Promise<CollaborationPolicy> {
    const [session] = await db.select().from(collaborationSessions)
      .where(and(eq(collaborationSessions.id, id), eq(collaborationSessions.status, 'active'))).limit(1);
    if (!session) throw new Error('Active collaboration session not found');
    const current: CollaborationPolicy = session.aiState
      ? { ...DEFAULT_COLLABORATION_POLICY, ...JSON.parse(session.aiState) }
      : DEFAULT_COLLABORATION_POLICY;
    const policy = normalizePolicy(current, patch);
    await db.update(collaborationSessions).set({ aiState: JSON.stringify(policy) })
      .where(eq(collaborationSessions.id, id));
    if (relayClient?.isConnected) await relayClient.updatePolicy(policy);
    return policy;
  }

  async joinRelaySession(joinCode: string) {
    return resolveRelayJoinCode(joinCode.trim().toUpperCase());
  }

  getPendingJoins() { return [...pendingJoins.values()]; }
  getConnectedGuests() { return [...connectedGuests.values()]; }
  resolveJoin(guestId: string, approved: boolean, tierId?: string) {
    const join = pendingJoins.get(guestId);
    if (!join) return null;
    pendingJoins.delete(guestId);
    relayClient?.decideJoin(guestId, approved, tierId || join.tierId);
    if (approved) connectedGuests.set(guestId, { guestId, name: join.name, tierId: tierId || join.tierId, admitted: true });
    return join;
  }
  assignParticipantTier(guestId: string, tierId: string) { relayClient?.assignTier(guestId, tierId); const guest = connectedGuests.get(guestId); if (guest) guest.tierId = tierId; }
  async createInvite(tierId: string) {
    if (!relayClient) throw new Error('Internet relay is not configured');
    return relayClient.createInvite(tierId);
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
