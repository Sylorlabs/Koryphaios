import { Elysia, t } from 'elysia';
import { collaborationManager } from '../collaboration/manager';
import { requireLocalRouteAuth } from '../auth/local-route-auth';
import { relayEnabled } from '../collaboration/relay-client';

export const collaborationRoutes = new Elysia({ prefix: '/api/collab' })

  // Start hosting — returns session info + invite links
  .post(
    '/:id/start',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const ownerId = (body as any)?.ownerId || 'local-user';
      try {
        const result = await collaborationManager.hostSession(id, ownerId);
        return { ok: true, data: { ...result, relayEnabled } };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    { body: t.Optional(t.Object({ ownerId: t.Optional(t.String()) })) },
  )

  // Join via legacy 6-char code (fallback for local network use)
  .post(
    '/join',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const session = await collaborationManager.joinSession(
          (body as any).joinCode,
          (body as any).userId,
          (body as any).name,
        );
        return { ok: true, data: session };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    { body: t.Object({ joinCode: t.String(), userId: t.String(), name: t.String() }) },
  )

  // Get pending guest prompts waiting for host approval
  .get('/:id/pending', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: collaborationManager.getPendingPrompts() };
  })

  // Host approves or rejects a guest prompt
  .post(
    '/:id/approve',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { promptId, approved } = body as any;
      const prompt = collaborationManager.resolveGuestPrompt(promptId, approved);
      // If approved and collaborator/copilot, the caller will inject into the session queue
      return { ok: true, data: { approved, prompt } };
    },
    { body: t.Object({ promptId: t.String(), approved: t.Boolean() }) },
  )

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
