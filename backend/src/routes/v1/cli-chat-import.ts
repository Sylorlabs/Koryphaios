import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError, ConflictError } from '../../errors/types';
import { discoverCliChats, importCliChats } from '../../services/cli-chat-porting';
import { tryAcquireSessionCreationLease } from '../../services/session-erasure-service';

export const cliChatImportRoutes = new Elysia({ prefix: '/api/cli-chat-import' })
  .get('/discover', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const data = discoverCliChats();
    return { ok: true, data };
  })
  .post(
    '/import',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const creationLease = tryAcquireSessionCreationLease();
      if (!creationLease) {
        throw new ConflictError(
          'Session creation is temporarily blocked while delete-all is finishing.',
        );
      }
      try {
        const result = await importCliChats({ chatIds: body.chatIds });
        try {
          const { wsManager } = getContext();
          for (const session of result.sessions) {
            wsManager.broadcastEphemeral({
              type: 'session.updated',
              sessionId: session.id,
              timestamp: Date.now(),
              payload: { session },
            });
          }
        } catch {
          // Context might not be wired in isolated route tests
        }
        return { ok: true, data: result };
      } finally {
        creationLease.release();
      }
    },
    {
      body: t.Object({
        chatIds: t.Array(t.String(), { maxItems: 500 }),
      }),
    },
  );
