// Agent registry routes: the official ACP registry (read-only), PATH-detected
// agents, and user-registered ACP agents with capability probes.
//
//   GET    /api/agents/registry            merged listing with source + status
//   POST   /api/agents/custom              register a command (probes unless probe=false)
//   DELETE /api/agents/custom/:id          remove a registered agent
//   POST   /api/agents/:id/probe           re-run the capability probe for a registered agent
//
// Env values are accepted on POST /custom and never echoed back.

import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { wsManager } from '../../ws/ws-manager';
import { serverLog } from '../../logger';
import {
  addCustomAcpAgent,
  AcpAgentConflictError,
  listAcpAgents,
  probeCustomAcpAgent,
  removeCustomAcpAgent,
} from '../../providers/acp/agent-service';
import { AcpAgentValidationError } from '../../providers/acp/agent-definitions';

function broadcastProviderStatus(): void {
  try {
    const { providers } = getContext();
    wsManager?.broadcastEphemeral({
      type: 'provider.status',
      payload: { providers: providers.getStatus() },
      timestamp: Date.now(),
    });
  } catch {
    // A push failure must not fail the change the user asked for.
  }
}

const AGENT_ID = t.String({ minLength: 1, maxLength: 48, pattern: '^[a-z0-9][a-z0-9-]{0,47}$' });

export const agentRoutes = new Elysia({ prefix: '/api/agents' })
  .get('/registry', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const refresh = new URL(request.url).searchParams.get('refresh') === '1';
    return { ok: true, data: await listAcpAgents({ refresh }) };
  })
  .post(
    '/custom',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { providers } = getContext();
      try {
        const result = await addCustomAcpAgent(providers, {
          id: body.id,
          label: body.label,
          command: body.command,
          args: body.args,
          env: body.env,
          cwdPolicy: body.cwdPolicy,
          permissionProfile: body.permissionProfile,
          registryId: body.registryId,
          probe: body.probe,
        });
        serverLog.info(
          { agent: result.id, status: result.status },
          'ACP agent registered',
        );
        broadcastProviderStatus();
        return { ok: true, data: result };
      } catch (err) {
        if (err instanceof AcpAgentConflictError) {
          set.status = 409;
          return { ok: false, error: err.message };
        }
        if (err instanceof AcpAgentValidationError) {
          set.status = 422;
          return { ok: false, error: err.message };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        id: t.Optional(AGENT_ID),
        label: t.String({ minLength: 1, maxLength: 80 }),
        command: t.String({ minLength: 1, maxLength: 512 }),
        args: t.Optional(t.Array(t.String({ maxLength: 1024 }), { maxItems: 32 })),
        env: t.Optional(t.Record(t.String({ maxLength: 128 }), t.String({ maxLength: 8192 }))),
        cwdPolicy: t.Optional(t.Union([t.Literal('workspace'), t.Literal('private')])),
        permissionProfile: t.Optional(
          t.Union([t.Literal('bridge-only'), t.Literal('read-only')]),
        ),
        registryId: t.Optional(t.String({ maxLength: 128 })),
        probe: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/custom/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const removed = removeCustomAcpAgent(providers, id);
    if (!removed) {
      set.status = 404;
      return { ok: false, error: 'Agent not found' };
    }
    broadcastProviderStatus();
    return { ok: true };
  })
  .post('/:id/probe', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const verdict = await probeCustomAcpAgent(providers, id);
    if (!verdict) {
      set.status = 404;
      return { ok: false, error: 'Agent not found' };
    }
    broadcastProviderStatus();
    return { ok: true, data: verdict };
  });
