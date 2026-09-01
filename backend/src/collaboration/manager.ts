import { nanoid } from 'nanoid';
import { db, collaborationSessions, sessionParticipants } from '../db';
import { eq, and, desc } from 'drizzle-orm';
import { relayClient, relayEnabled, resolveRelayJoinCode } from './relay-client';
import { serverLog } from '../logger';
import { DEFAULT_COLLABORATION_POLICY, type CollaborationPolicy } from '@koryphaios/shared';

const log = serverLog.child({ module: 'collab-manager' });
const SAFE_TIER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function normalizePolicy(
  current: CollaborationPolicy,
  patch: Partial<CollaborationPolicy>,
): CollaborationPolicy {
  const tiers = Array.isArray(patch.accessTiers)
    ? patch.accessTiers
        .slice(0, 24)
        .map((tier) => ({
          ...tier,
          id: String(tier.id).toLowerCase().trim(),
          name: String(tier.name).trim().slice(0, 40),
          description: String(tier.description || '').slice(0, 180),
          allowedModels: [
            ...new Set((tier.allowedModels || []).filter((v) => typeof v === 'string')),
          ].slice(0, 200),
          reasoningByModel: Object.fromEntries(
            Object.entries(tier.reasoningByModel || {})
              .slice(0, 200)
              .map(([model, levels]) => [
                model,
                [
                  ...new Set(
                    (Array.isArray(levels) ? levels : []).filter((v) => typeof v === 'string'),
                  ),
                ].slice(0, 12),
              ]),
          ),
          permissions: {
            ...tier.permissions,
            readPaths: [
              ...new Set((tier.permissions?.readPaths || []).filter((v) => typeof v === 'string')),
            ].slice(0, 100),
            writePaths: [
              ...new Set((tier.permissions?.writePaths || []).filter((v) => typeof v === 'string')),
            ].slice(0, 100),
            commandAllowlist: [
              ...new Set(
                (tier.permissions?.commandAllowlist || []).filter((v) => typeof v === 'string'),
              ),
            ].slice(0, 100),
            commandBlocklist: [
              ...new Set(
                (tier.permissions?.commandBlocklist || []).filter((v) => typeof v === 'string'),
              ),
            ].slice(0, 100),
          },
        }))
        .filter((tier) => SAFE_TIER_ID.test(tier.id) && tier.name)
    : current.accessTiers;
  if (!tiers.length) throw new Error('At least one valid access tier is required');
  const defaultTierId = tiers.some((t) => t.id === patch.defaultTierId)
    ? patch.defaultTierId!
    : tiers.some((t) => t.id === current.defaultTierId)
      ? current.defaultTierId
      : tiers[0].id;
  return {
    ...DEFAULT_COLLABORATION_POLICY,
    ...current,
    ...patch,
    accessTiers: tiers,
    defaultTierId,
    sessionName:
      String(patch.sessionName ?? current.sessionName ?? 'Team session')
        .trim()
        .slice(0, 80) || 'Team session',
    workspacePaths: Array.isArray(patch.workspacePaths)
      ? [
          ...new Set(
            patch.workspacePaths
              .filter((v) => typeof v === 'string')
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        ].slice(0, 24)
      : current.workspacePaths,
    modelCatalog: Array.isArray(patch.modelCatalog)
      ? patch.modelCatalog.slice(0, 200).map((model) => ({
          id: String(model.id),
          label: String(model.label),
          provider: String(model.provider),
          reasoningLevels: [
            ...new Set((model.reasoningLevels || []).filter((v) => typeof v === 'string')),
          ].slice(0, 12),
        }))
      : current.modelCatalog,
    joinMode:
      patch.joinMode === 'auto'
        ? 'auto'
        : patch.joinMode === 'approval'
          ? 'approval'
          : current.joinMode,
  };
}

// ─── Pending approvals (in-memory projections with durable recovery) ─────────

export interface PendingPrompt {
  guestId: string;
  name: string;
  role: string;
  content: string;
  sessionId: string;
  /** Stable identity shared by auto-execution and later host approval retries. */
  sourceCommandId: string;
  timestamp: number;
  model?: string;
  reasoningLevel?: string;
  commandAllowlist?: string[];
  commandBlocklist?: string[];
  tierId?: string;
}

export interface PendingJoin {
  guestId: string;
  name: string;
  tierId: string;
  sessionId: string;
  timestamp: number;
}

/**
 * The non-secret host projection used to rebuild the desktop collaboration
 * controls after a renderer reload. Invite URLs deliberately stay out of the
 * database: each one is a bearer capability and is minted again on demand.
 */
export interface CollaborationHostSnapshot {
  id: string;
  baseSessionId: string;
  ownerId: string;
  status: string;
  joinCode: string;
  tunnelUrl: string;
  inviteLinks: Record<string, string>;
  relayEnabled: boolean;
  policy: CollaborationPolicy;
}

const pendingPrompts = new Map<string, PendingPrompt>(); // promptId → prompt
const pendingJoins = new Map<string, PendingJoin>();
type ConnectedGuest = CollaborationParticipant & { sessionId: string };

const connectedGuests = new Map<string, ConnectedGuest>();
let approvalListeners: Array<(p: PendingPrompt & { promptId: string }) => void> = [];

export type PersistedCollaborationRuntime = {
  version: 1;
  revision: number;
  pendingPrompts: Array<PendingPrompt & { promptId: string }>;
  pendingJoins: PendingJoin[];
  participants: CollaborationParticipant[];
};

export type CollaborationRuntimeSnapshotWriter = (
  sessionId: string,
  snapshot: PersistedCollaborationRuntime,
) => Promise<void>;

type CollaborationParticipant = {
  guestId: string;
  name: string;
  tierId: string;
  admitted: boolean;
};

function readStoredPolicy(aiState: string | null): CollaborationPolicy {
  if (!aiState) return DEFAULT_COLLABORATION_POLICY;
  try {
    return { ...DEFAULT_COLLABORATION_POLICY, ...JSON.parse(aiState) };
  } catch (err: unknown) {
    // A corrupt optional collaboration preference must not make an otherwise
    // durable host session impossible to inspect or end.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Could not parse stored collaboration policy; using safe defaults',
    );
    return DEFAULT_COLLABORATION_POLICY;
  }
}

function parseRuntimeSnapshot(
  input: string | null,
  sessionId: string,
): PersistedCollaborationRuntime | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Partial<PersistedCollaborationRuntime>;
    if (parsed?.version !== 1) return null;
    const pendingPrompts = Array.isArray(parsed.pendingPrompts)
      ? parsed.pendingPrompts.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const prompt = candidate as Partial<PendingPrompt & { promptId: string }>;
          if (
            typeof prompt.promptId !== 'string' ||
            typeof prompt.guestId !== 'string' ||
            typeof prompt.content !== 'string'
          ) {
            return [];
          }
          return [
            {
              promptId: prompt.promptId,
              guestId: prompt.guestId,
              name: typeof prompt.name === 'string' ? prompt.name : 'Guest',
              role: typeof prompt.role === 'string' ? prompt.role : 'viewer',
              content: prompt.content,
              sessionId,
              sourceCommandId:
                typeof prompt.sourceCommandId === 'string'
                  ? prompt.sourceCommandId
                  : `collaboration:${sessionId}:${prompt.promptId}`,
              timestamp: typeof prompt.timestamp === 'number' ? prompt.timestamp : Date.now(),
              ...(typeof prompt.model === 'string' ? { model: prompt.model } : {}),
              ...(typeof prompt.reasoningLevel === 'string'
                ? { reasoningLevel: prompt.reasoningLevel }
                : {}),
              ...(Array.isArray(prompt.commandAllowlist)
                ? { commandAllowlist: prompt.commandAllowlist.filter((item): item is string => typeof item === 'string') }
                : {}),
              ...(Array.isArray(prompt.commandBlocklist)
                ? { commandBlocklist: prompt.commandBlocklist.filter((item): item is string => typeof item === 'string') }
                : {}),
              ...(typeof prompt.tierId === 'string' ? { tierId: prompt.tierId } : {}),
            },
          ];
        })
      : [];
    const pendingJoins = Array.isArray(parsed.pendingJoins)
      ? parsed.pendingJoins.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const join = candidate as Partial<PendingJoin>;
          if (typeof join.guestId !== 'string') return [];
          return [
            {
              guestId: join.guestId,
              name: typeof join.name === 'string' ? join.name : 'Guest',
              tierId: typeof join.tierId === 'string' ? join.tierId : 'viewer',
              sessionId,
              timestamp: typeof join.timestamp === 'number' ? join.timestamp : Date.now(),
            },
          ];
        })
      : [];
    const participants = Array.isArray(parsed.participants)
      ? parsed.participants.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') return [];
          const participant = candidate as Partial<CollaborationParticipant>;
          if (typeof participant.guestId !== 'string') return [];
          return [
            {
              guestId: participant.guestId,
              name: typeof participant.name === 'string' ? participant.name : 'Guest',
              tierId: typeof participant.tierId === 'string' ? participant.tierId : 'viewer',
              admitted: participant.admitted !== false,
            },
          ];
        })
      : [];
    return {
      version: 1,
      revision:
        typeof parsed.revision === 'number' &&
        Number.isSafeInteger(parsed.revision) &&
        parsed.revision >= 0
          ? parsed.revision
          : 0,
      pendingPrompts,
      pendingJoins,
      participants,
    };
  } catch (err: unknown) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), sessionId },
      'Could not parse collaboration runtime recovery snapshot',
    );
    return null;
  }
}

export function onGuestPrompt(fn: (typeof approvalListeners)[0]) {
  approvalListeners.push(fn);
  return () => {
    approvalListeners = approvalListeners.filter((l) => l !== fn);
  };
}

function emitPendingPrompt(promptId: string, p: PendingPrompt) {
  approvalListeners.forEach((fn) => {
    try {
      fn({ ...p, promptId });
    } catch (err) {
      // A single misbehaving listener must not break fan-out to the rest.
      log.debug(
        { err: err instanceof Error ? err.message : String(err), promptId },
        'Approval listener threw; continuing to remaining listeners',
      );
    }
  });
}

// ─── CollaborationManager ────────────────────────────────────────────────────

export class CollaborationManager {
  private readonly runtimePersistenceTails = new Map<string, Promise<void>>();
  private readonly runtimeRevisions = new Map<string, number>();
  private readonly hydratedRuntimeSessions = new Set<string>();

  constructor(
    private readonly runtimeSnapshotWriter: CollaborationRuntimeSnapshotWriter = async (
      sessionId,
      snapshot,
    ) => {
      const updated = await db
        .update(collaborationSessions)
        .set({ contextSnapshot: JSON.stringify(snapshot) })
        .where(eq(collaborationSessions.id, sessionId))
        .returning({ id: collaborationSessions.id });
      if (updated.length !== 1) {
        throw new Error(`Collaboration session ${sessionId} no longer exists`);
      }
    },
  ) {}

  private generateJoinCode(): string {
    // Legacy local join code — kept for DB compat, not used by relay flow
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(
      '',
    );
  }

  private buildRuntimeSnapshot(
    sessionId: string,
    revision: number,
  ): PersistedCollaborationRuntime {
    return {
      version: 1,
      revision,
      pendingPrompts: Array.from(pendingPrompts.entries())
        .filter(([, prompt]) => prompt.sessionId === sessionId)
        .map(([promptId, prompt]) => ({ ...prompt, promptId })),
      pendingJoins: Array.from(pendingJoins.values()).filter((join) => join.sessionId === sessionId),
      participants: Array.from(connectedGuests.values())
        .filter((participant) => participant.sessionId === sessionId)
        .map(({ sessionId: _sessionId, ...participant }) => participant),
    };
  }

  private enqueueRuntimeOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runtimePersistenceTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.runtimePersistenceTails.set(sessionId, settled);
    void settled.finally(() => {
      if (this.runtimePersistenceTails.get(sessionId) === settled) {
        this.runtimePersistenceTails.delete(sessionId);
      }
    });
    return result;
  }

  private async persistRuntimeState(sessionId: string): Promise<void> {
    await this.enqueueRuntimeOperation(sessionId, async () => {
      const revision = (this.runtimeRevisions.get(sessionId) ?? 0) + 1;
      await this.runtimeSnapshotWriter(
        sessionId,
        this.buildRuntimeSnapshot(sessionId, revision),
      );
      this.runtimeRevisions.set(sessionId, revision);
    });
  }

  private async hydrateRuntimeState(
    session: typeof collaborationSessions.$inferSelect,
  ): Promise<void> {
    await this.enqueueRuntimeOperation(session.id, async () => {
      if (this.hydratedRuntimeSessions.has(session.id)) return;
      const snapshot = parseRuntimeSnapshot(session.contextSnapshot, session.id);
      if (snapshot) {
        for (const prompt of snapshot.pendingPrompts) {
          if (!pendingPrompts.has(prompt.promptId)) {
            const { promptId, ...pending } = prompt;
            pendingPrompts.set(promptId, pending);
          }
        }
        for (const join of snapshot.pendingJoins) {
          if (!pendingJoins.has(join.guestId)) pendingJoins.set(join.guestId, join);
        }
        for (const participant of snapshot.participants) {
          if (!connectedGuests.has(participant.guestId)) {
            connectedGuests.set(participant.guestId, { ...participant, sessionId: session.id });
          }
        }
        this.runtimeRevisions.set(
          session.id,
          Math.max(this.runtimeRevisions.get(session.id) ?? 0, snapshot.revision),
        );
      }
      this.hydratedRuntimeSessions.add(session.id);
    });
  }

  /**
   * Stage a relay prompt in the durable snapshot before publishing it to the
   * process-local approval projection. Callers may emit only after this
   * promise resolves.
   */
  async createPendingGuestPrompt(promptId: string, prompt: PendingPrompt): Promise<void> {
    await this.enqueueRuntimeOperation(prompt.sessionId, async () => {
      if (pendingPrompts.has(promptId)) {
        throw new Error(`Pending collaboration prompt ${promptId} already exists`);
      }
      const revision = (this.runtimeRevisions.get(prompt.sessionId) ?? 0) + 1;
      const snapshot = this.buildRuntimeSnapshot(prompt.sessionId, revision);
      snapshot.pendingPrompts.push({ ...prompt, promptId });
      await this.runtimeSnapshotWriter(prompt.sessionId, snapshot);
      pendingPrompts.set(promptId, prompt);
      this.runtimeRevisions.set(prompt.sessionId, revision);
    });
  }

  private async handleRelayMessage(
    msg: Record<string, unknown>,
    sessionId: string,
    baseSessionId: string,
    relaySessionId: string,
  ): Promise<void> {
    if (msg.type === 'guest-prompt') {
      const promptId = nanoid();
      const pending: PendingPrompt = {
        guestId: msg.guestId as string,
        name: msg.name as string,
        role: msg.role as string,
        content: msg.content as string,
        sessionId,
        sourceCommandId: `collaboration:${relaySessionId}:${promptId}`,
        timestamp: Date.now(),
        model: String(msg.model || ''),
        reasoningLevel: String(msg.reasoningLevel || ''),
        commandAllowlist: Array.isArray(msg.commandAllowlist)
          ? msg.commandAllowlist.map(String)
          : [],
        commandBlocklist: Array.isArray(msg.commandBlocklist)
          ? msg.commandBlocklist.map(String)
          : [],
        tierId: String(msg.tierId || msg.role || ''),
      };

      try {
        await this.createPendingGuestPrompt(promptId, pending);
      } catch (error) {
        // The prompt never became durable or visible. Tell the guest it was
        // rejected instead of pretending that host approval is pending.
        relayClient?.approveGuestPrompt(pending.guestId, false);
        throw error;
      }

      if (msg.autoExecute !== true) {
        emitPendingPrompt(promptId, pending);
        return;
      }

      try {
        const { getContext } = await import('../context');
        const submission = await getContext().kory.startSessionTurn({
          sessionId: baseSessionId,
          source: 'collaboration',
          sourceCommandId: pending.sourceCommandId,
          userMessage: pending.content,
          preferredModel: pending.model || undefined,
          reasoningLevel: pending.reasoningLevel || undefined,
          collaborationToolPolicy: {
            commandAllowlist: pending.commandAllowlist || [],
            commandBlocklist: pending.commandBlocklist || [],
          },
        });
        if (!submission.accepted) {
          if (submission.result.status === 'completed') {
            await this.resolveGuestPrompt(promptId, true);
          } else {
            log.warn(
              {
                promptId,
                status: submission.result.status,
                reason: submission.result.reason,
              },
              'Auto-executed guest prompt was not admitted; retaining approval',
            );
            emitPendingPrompt(promptId, pending);
          }
          return;
        }
        await this.resolveGuestPrompt(promptId, true);
        void submission.completion.catch((error) =>
          log.error({ error, promptId }, 'Auto-executed guest prompt failed'),
        );
      } catch (error) {
        log.error({ error, promptId }, 'Could not admit auto-executed guest prompt');
        const retained = this.getPendingPrompt(promptId);
        if (retained) emitPendingPrompt(promptId, retained);
      }
      return;
    }

    if (msg.type === 'join-request') {
      const guestId = String(msg.guestId);
      pendingJoins.set(guestId, {
        guestId,
        name: String(msg.name || 'Guest'),
        tierId: String(msg.tierId || 'viewer'),
        sessionId,
        timestamp: Date.now(),
      });
      await this.persistRuntimeState(sessionId);
    } else if (msg.type === 'guest-list' && Array.isArray(msg.guests)) {
      // A relay snapshot only owns this host session. Do not erase guests
      // restored for another active collaboration host.
      for (const [guestId, guest] of connectedGuests) {
        if (guest.sessionId === sessionId) connectedGuests.delete(guestId);
      }
      for (const guest of msg.guests as any[]) {
        connectedGuests.set(String(guest.guestId), {
          guestId: String(guest.guestId),
          name: String(guest.name || 'Guest'),
          tierId: String(guest.tierId || 'viewer'),
          admitted: guest.admitted !== false,
          sessionId,
        });
      }
      await this.persistRuntimeState(sessionId);
    } else if (msg.type === 'guest-joined') {
      connectedGuests.set(String(msg.guestId), {
        guestId: String(msg.guestId),
        name: String(msg.name || 'Guest'),
        tierId: String(msg.role || 'viewer'),
        admitted: true,
        sessionId,
      });
      await this.persistRuntimeState(sessionId);
    } else if (msg.type === 'guest-left') {
      const guestId = String(msg.guestId);
      if (connectedGuests.get(guestId)?.sessionId === sessionId) {
        connectedGuests.delete(guestId);
      }
      if (pendingJoins.get(guestId)?.sessionId === sessionId) {
        pendingJoins.delete(guestId);
      }
      await this.persistRuntimeState(sessionId);
    }
  }

  async hostSession(
    baseSessionId: string,
    ownerId: string,
    workspacePaths: string[] = [],
  ): Promise<CollaborationHostSnapshot> {
    if (!relayEnabled || !relayClient) {
      throw new Error('WAN collaboration relay is not configured. Hosting was not started.');
    }
    // Check if already hosting this session
    const existingRows = await db
      .select()
      .from(collaborationSessions)
      .where(
        and(
          eq(collaborationSessions.baseSessionId, baseSessionId),
          eq(collaborationSessions.status, 'active'),
        ),
      )
      .limit(1);
    let existing: (typeof existingRows)[number] | undefined = existingRows[0];

    // Relay sessions are in-memory on the WAN service. After either side
    // restarts, a stale local row must not masquerade as an internet-reachable
    // host. End it and create a fresh relay-backed session.
    if (existing && !relayClient.isConnected) {
      await db
        .update(collaborationSessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(eq(collaborationSessions.id, existing.id));
      // The old relay transport is gone. Drop only its process-local
      // projections; the durable row remains an honest ended record and must
      // not leak stale prompts/guests into the replacement host.
      this.hydratedRuntimeSessions.delete(existing.id);
      this.runtimeRevisions.delete(existing.id);
      for (const [promptId, prompt] of pendingPrompts) {
        if (prompt.sessionId === existing.id) pendingPrompts.delete(promptId);
      }
      for (const [guestId, join] of pendingJoins) {
        if (join.sessionId === existing.id) pendingJoins.delete(guestId);
      }
      for (const [guestId, guest] of connectedGuests) {
        if (guest.sessionId === existing.id) connectedGuests.delete(guestId);
      }
      existing = undefined;
    }

    let sessionId: string;
    let joinCode: string;
    let tunnelUrl = '';
    let relayReady = false;

    const requestedWorkspacePaths = [
      ...new Set(workspacePaths.map((path) => path.trim()).filter(Boolean)),
    ].slice(0, 24);

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
          const {
            sessionId: relaySessionId,
            inviteBase,
            joinCode: relayJoinCode,
          } = await relayClient.startSession(sessionId);
          tunnelUrl = `${inviteBase}/join`;
          if (relayJoinCode) joinCode = relayJoinCode;
          log.info({ relaySessionId }, 'Relay session started');
          relayReady = true;

          // Serve shared providers to remote clients over this relay
          // connection (separate from the guest-prompt/session path below).
          const hostRelay = relayClient;
          void import('./remote-provider-host').then(({ startProviderHost }) =>
            startProviderHost(hostRelay, 'Host'),
          );

          // Relay dispatch is synchronous, so explicitly observe the durable
          // handler promise rather than leaking an unhandled rejection.
          relayClient.onMessage((msg) => {
            void this.handleRelayMessage(msg, sessionId, baseSessionId, relaySessionId).catch(
              (err: unknown) => {
                log.error(
                  { err: err instanceof Error ? err.message : String(err), msgType: msg.type },
                  'Failed to durably apply relay collaboration event',
                );
              },
            );
          });
        } catch (err: unknown) {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to start relay session',
          );
        }
      }

      const initialPolicy = normalizePolicy(DEFAULT_COLLABORATION_POLICY, {
        workspacePaths: requestedWorkspacePaths,
      });
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

    let policy: CollaborationPolicy = existing
      ? readStoredPolicy(existing.aiState)
      : normalizePolicy(DEFAULT_COLLABORATION_POLICY, { workspacePaths: requestedWorkspacePaths });
    if (existing && requestedWorkspacePaths.length) {
      policy = normalizePolicy(policy, { workspacePaths: requestedWorkspacePaths });
      await db
        .update(collaborationSessions)
        .set({ aiState: JSON.stringify(policy) })
        .where(eq(collaborationSessions.id, sessionId));
    }
    if (relayClient?.isConnected) {
      try {
        await relayClient.updatePolicy(policy);
        relayReady = true;
      } catch (err: unknown) {
        // Never expose guests through a relay that cannot enforce host policy.
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'WAN relay does not support required host policy',
        );
        await relayClient.disconnect();
        relayReady = false;
        await db
          .update(collaborationSessions)
          .set({ status: 'ended', endedAt: new Date() })
          .where(eq(collaborationSessions.id, sessionId));
        throw new Error(
          'WAN relay upgrade required: the configured relay does not support enforced host policies. Hosting was not started.',
        );
      }
    }

    // Generate an invite link for every host-defined access tier.
    const inviteLinks: Record<string, string> = {};
    if (relayReady && relayClient) {
      for (const role of policy.accessTiers.map((t) => t.id)) {
        try {
          inviteLinks[role] = await relayClient.createInvite(role);
        } catch (err: unknown) {
          log.warn(
            { role, err: err instanceof Error ? err.message : String(err) },
            'Failed to create invite link',
          );
        }
      }
    }

    return {
      id: sessionId,
      baseSessionId,
      ownerId: existing?.ownerId ?? ownerId,
      status: 'active',
      joinCode,
      tunnelUrl,
      inviteLinks,
      relayEnabled: relayReady,
      policy,
    };
  }

  /**
   * Return the durable host record for a local chat. This is intentionally a
   * projection rather than a stored invite: renderer reloads regain control
   * and polling, while bearer invite URLs are never written to disk.
   */
  async getActiveHostForBaseSession(baseSessionId: string): Promise<CollaborationHostSnapshot | null> {
    const [session] = await db
      .select()
      .from(collaborationSessions)
      .where(
        and(
          eq(collaborationSessions.baseSessionId, baseSessionId),
          eq(collaborationSessions.status, 'active'),
        ),
      )
      .orderBy(desc(collaborationSessions.createdAt))
      .limit(1);
    if (!session) return null;
    await this.hydrateRuntimeState(session);

    return {
      id: session.id,
      baseSessionId: session.baseSessionId,
      ownerId: session.ownerId,
      status: session.status ?? 'active',
      joinCode: session.joinCode,
      tunnelUrl: session.tunnelUrl ?? '',
      inviteLinks: {},
      relayEnabled: relayClient?.isConnected === true,
      policy: readStoredPolicy(session.aiState),
    };
  }

  /**
   * Restore host controls after a renderer reload. If the process-local relay
   * connection has gone away, `hostSession` closes the stale local host record
   * and creates a fresh, policy-checked relay session. We never pretend that
   * the old guest transport or its bearer invites still exist.
   */
  async restoreHostForBaseSession(
    baseSessionId: string,
  ): Promise<CollaborationHostSnapshot | null> {
    const existing = await this.getActiveHostForBaseSession(baseSessionId);
    if (!existing) return null;
    if (!relayEnabled || !relayClient) return existing;
    if (relayClient.isConnected) return existing;
    return this.hostSession(baseSessionId, existing.ownerId, existing.policy.workspacePaths ?? []);
  }

  async updatePolicy(
    id: string,
    patch: Partial<CollaborationPolicy>,
  ): Promise<CollaborationPolicy> {
    const [session] = await db
      .select()
      .from(collaborationSessions)
      .where(and(eq(collaborationSessions.id, id), eq(collaborationSessions.status, 'active')))
      .limit(1);
    if (!session) throw new Error('Active collaboration session not found');
    const current = readStoredPolicy(session.aiState);
    const policy = normalizePolicy(current, patch);
    await db
      .update(collaborationSessions)
      .set({ aiState: JSON.stringify(policy) })
      .where(eq(collaborationSessions.id, id));
    if (relayClient?.isConnected) await relayClient.updatePolicy(policy);
    return policy;
  }

  async joinRelaySession(joinCode: string) {
    return resolveRelayJoinCode(joinCode.trim().toUpperCase());
  }

  async hydrateRuntimeForSession(id: string): Promise<boolean> {
    const [session] = await db
      .select()
      .from(collaborationSessions)
      .where(eq(collaborationSessions.id, id))
      .limit(1);
    if (!session) return false;
    await this.hydrateRuntimeState(session);
    return true;
  }

  getPendingJoins(sessionId?: string) {
    return [...pendingJoins.values()].filter((join) => !sessionId || join.sessionId === sessionId);
  }
  getConnectedGuests(sessionId?: string): CollaborationParticipant[] {
    return [...connectedGuests.values()]
      .filter((guest) => !sessionId || guest.sessionId === sessionId)
      .map(({ sessionId: _sessionId, ...guest }) => guest);
  }
  resolveJoin(guestId: string, approved: boolean, tierId?: string) {
    const join = pendingJoins.get(guestId);
    if (!join) return null;
    pendingJoins.delete(guestId);
    relayClient?.decideJoin(guestId, approved, tierId || join.tierId);
    if (approved)
      connectedGuests.set(guestId, {
        guestId,
        name: join.name,
        tierId: tierId || join.tierId,
        admitted: true,
        sessionId: join.sessionId,
      });
    void this.persistRuntimeState(join.sessionId);
    return join;
  }
  assignParticipantTier(guestId: string, tierId: string, sessionId?: string) {
    relayClient?.assignTier(guestId, tierId);
    const guest = connectedGuests.get(guestId);
    if (guest && (!sessionId || guest.sessionId === sessionId)) guest.tierId = tierId;
    if (sessionId) void this.persistRuntimeState(sessionId);
  }
  async createInvite(tierId: string) {
    if (!relayClient) throw new Error('Internet relay is not configured');
    return relayClient.createInvite(tierId);
  }

  /** Approve or reject a pending guest prompt. Returns the prompt content if approved. */
  getPendingPrompt(promptId: string): PendingPrompt | null {
    return pendingPrompts.get(promptId) ?? null;
  }

  async resolveGuestPrompt(promptId: string, approved: boolean): Promise<PendingPrompt | null> {
    const knownPrompt = pendingPrompts.get(promptId);
    if (!knownPrompt) return null;
    return this.enqueueRuntimeOperation(knownPrompt.sessionId, async () => {
      const prompt = pendingPrompts.get(promptId);
      if (!prompt || prompt.sessionId !== knownPrompt.sessionId) return null;

      const revision = (this.runtimeRevisions.get(prompt.sessionId) ?? 0) + 1;
      const snapshot = this.buildRuntimeSnapshot(prompt.sessionId, revision);
      snapshot.pendingPrompts = snapshot.pendingPrompts.filter(
        (candidate) => candidate.promptId !== promptId,
      );
      await this.runtimeSnapshotWriter(prompt.sessionId, snapshot);

      pendingPrompts.delete(promptId);
      this.runtimeRevisions.set(prompt.sessionId, revision);
      relayClient?.approveGuestPrompt(prompt.guestId, approved);
      return approved ? prompt : null;
    });
  }

  getPendingPrompts(sessionId?: string): Array<PendingPrompt & { promptId: string }> {
    return Array.from(pendingPrompts.entries())
      .filter(([, prompt]) => !sessionId || prompt.sessionId === sessionId)
      .map(([promptId, p]) => ({ ...p, promptId }));
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
      .where(
        and(
          eq(collaborationSessions.joinCode, joinCode),
          eq(collaborationSessions.status, 'active'),
        ),
      )
      .limit(1);

    if (!session) throw new Error('Invalid or inactive join code');

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
        role: 'viewer',
        lastActive: new Date(),
      });
    } else {
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

    this.hydratedRuntimeSessions.delete(id);
    this.runtimeRevisions.delete(id);
    for (const [promptId, prompt] of pendingPrompts) {
      if (prompt.sessionId === id) pendingPrompts.delete(promptId);
    }
    for (const [guestId, join] of pendingJoins) {
      if (join.sessionId === id) pendingJoins.delete(guestId);
    }
    for (const [guestId, guest] of connectedGuests) {
      if (guest.sessionId === id) connectedGuests.delete(guestId);
    }

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
