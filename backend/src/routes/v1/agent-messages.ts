// Inter-agent messaging (AgentMail) HTTP routes.
// The frontend uses these for the Messages panel: session activity and the
// approve/decline actions for the 'approval-cross-project' policy.

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getContext } from '../../context';
import { AuthenticationError, NotFoundError } from '../../errors/types';
import { listThreadActivity } from '../../stores/agent-message-store';
import { approveAgentMessage } from '../../kory/services/agent-mail-service';

export const agentMessageRoutes = new Elysia({ prefix: '/api/v1/agent-messages' })
  .get(
    '/',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      if (!(await getContext().sessions.get(query.sessionId))) {
        throw new NotFoundError('Session', query.sessionId);
      }
      const messages = await listThreadActivity(query.sessionId, 200);
      return { ok: true, data: { messages } };
    },
    { query: t.Object({ sessionId: t.String({ minLength: 1, maxLength: 200 }) }) },
  )
  .post(
    '/:id/approve',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      const message = await approveAgentMessage(id, body.approved);
      if (!message) throw new NotFoundError('Pending agent message', id);
      return { ok: true, data: { message } };
    },
    { body: t.Object({ approved: t.Boolean() }) },
  );
