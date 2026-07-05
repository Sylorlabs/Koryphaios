import { Elysia, t } from 'elysia';
import { collaborationManager } from '../collaboration/manager';
import { requireLocalRouteAuth } from '../auth/local-route-auth';
import { relayAvailable } from '../collaboration/relay-client';
import { getContext } from '../context';

export const collaborationRoutes = new Elysia({ prefix: '/api/collab' })

  // Canonical host start endpoint. Keeping the session id in the JSON body
  // avoids route ambiguity and gives host configuration a stable contract.
  .post(
    '/host/start',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const input = body as { sessionId: string; ownerId?: string; workspacePaths?: string[] };
      try {
        const result = await collaborationManager.hostSession(
          input.sessionId,
          input.ownerId || 'local-user',
          input.workspacePaths || [],
        );
        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    { body: t.Object({ sessionId: t.String(), ownerId: t.Optional(t.String()), workspacePaths: t.Optional(t.Array(t.String())) }) },
  )

  // Start hosting — returns session info + invite links
  .post(
    '/:id/start',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const ownerId = (body as any)?.ownerId || 'local-user';
      try {
        const result = await collaborationManager.hostSession(id, ownerId, (body as any)?.workspacePaths || []);
        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    { body: t.Optional(t.Object({ ownerId: t.Optional(t.String()), workspacePaths: t.Optional(t.Array(t.String())) })) },
  )

  // Join via legacy 6-char code (fallback for local network use)
  .post(
    '/join',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        let session;
        if (relayAvailable) {
          try {
            session = await collaborationManager.joinRelaySession((body as any).joinCode);
          } catch {
            // A host may be running in secure local fallback mode when its
            // configured relay is older or temporarily unavailable.
            session = await collaborationManager.joinSession((body as any).joinCode, (body as any).userId, (body as any).name);
          }
        } else {
          session = await collaborationManager.joinSession((body as any).joinCode, (body as any).userId, (body as any).name);
        }
        return { ok: true, data: session };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    { body: t.Object({ joinCode: t.String(), userId: t.String(), name: t.String(), role: t.Optional(t.Union([t.Literal('viewer'), t.Literal('collaborator')])) }) },
  )

  .patch('/:id/policy', async ({ request, params: { id }, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      return { ok: true, data: await collaborationManager.updatePolicy(id, body as any) };
    } catch (err: any) {
      set.status = 400;
      return { ok: false, error: err.message };
    }
  }, { body: t.Object({
    allowedModels: t.Optional(t.Array(t.String())),
    allowPrompts: t.Optional(t.Boolean()),
    requirePromptApproval: t.Optional(t.Boolean()),
    showDiffs: t.Optional(t.Boolean()),
    showAgentStatus: t.Optional(t.Boolean()),
    showParticipants: t.Optional(t.Boolean()),
    joinMode: t.Optional(t.Union([t.Literal('approval'), t.Literal('auto')])),
    defaultTierId: t.Optional(t.String()),
    accessTiers: t.Optional(t.Array(t.Any())),
    modelCatalog: t.Optional(t.Array(t.Any())),
    sessionName: t.Optional(t.String({ maxLength: 80 })),
    workspacePaths: t.Optional(t.Array(t.String(), { maxItems: 24 })),
  }) })

  // Get pending guest prompts waiting for host approval
  .get('/:id/pending', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: { prompts: collaborationManager.getPendingPrompts(), joins: collaborationManager.getPendingJoins(), participants: collaborationManager.getConnectedGuests() } };
  })

  // Host approves or rejects a guest prompt
  .post(
    '/:id/approve',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { promptId, approved } = body as any;
      const prompt = collaborationManager.resolveGuestPrompt(promptId, approved);
      if (approved && prompt) {
        const state = await collaborationManager.getSessionState(id);
        if (state) void getContext().kory.processTask(state.session.baseSessionId, prompt.content, prompt.model || undefined, prompt.reasoningLevel || undefined, undefined, { commandAllowlist: prompt.commandAllowlist || [], commandBlocklist: prompt.commandBlocklist || [] });
      }
      return { ok: true, data: { approved, prompt } };
    },
    { body: t.Object({ promptId: t.String(), approved: t.Boolean() }) },
  )

  .post('/:id/join-decision', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { guestId, approved, tierId } = body as any;
    return { ok: true, data: collaborationManager.resolveJoin(guestId, approved, tierId) };
  }, { body: t.Object({ guestId: t.String(), approved: t.Boolean(), tierId: t.Optional(t.String()) }) })

  .post('/:id/assign-tier', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    collaborationManager.assignParticipantTier((body as any).guestId, (body as any).tierId);
    return { ok: true };
  }, { body: t.Object({ guestId: t.String(), tierId: t.String() }) })

  .post('/:id/invite', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try { return { ok: true, data: { tierId: (body as any).tierId, url: await collaborationManager.createInvite((body as any).tierId) } }; }
    catch (err: any) { set.status = 400; return { ok: false, error: err.message }; }
  }, { body: t.Object({ tierId: t.String() }) })

  // Get session state
  .get('/:id/state', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const state = await collaborationManager.getSessionState(id);
      if (!state) { set.status = 404; return { ok: false, error: 'Session not found' }; }
      return { ok: true, data: state };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  })

  // End session
  .post('/:id/end', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      await collaborationManager.endSession(id);
      return { ok: true };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  });
