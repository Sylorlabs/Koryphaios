import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError } from '../../errors/types';
import { deviceService } from '../../devices/service';

export const deviceRoutes = new Elysia({ prefix: '/api/devices' })
  .onBeforeHandle(async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    await deviceService.initialize();
  })
  .get('/', () => ({ ok: true, data: deviceService.status() }))
  .patch(
    '/relay',
    async ({ body }) => ({ ok: true, data: await deviceService.configureRelay(body.url) }),
    {
      body: t.Object({ url: t.String({ maxLength: 2048 }) }),
    },
  )
  .patch(
    '/access',
    ({ body }) => ({
      ok: true,
      data: deviceService.configureAccountWideDeviceAccess(body.enabled),
    }),
    { body: t.Object({ enabled: t.Boolean() }) },
  )
  .patch('/name', async ({ body }) => ({ ok: true, data: await deviceService.rename(body.name) }), {
    body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }),
  })
  .post('/pairing', async () => ({ ok: true, data: await deviceService.invite() }))
  .delete('/pairing', async () => {
    await deviceService.stopInvite();
    return { ok: true };
  })
  .post('/pair', async ({ body }) => ({ ok: true, data: await deviceService.pair(body.code) }), {
    body: t.Object({ code: t.String({ maxLength: 30 }) }),
  })
  .post(
    '/decision',
    async ({ body }) => ({ ok: true, data: await deviceService.decide(body.id, body.approved) }),
    { body: t.Object({ id: t.String({ maxLength: 64 }), approved: t.Boolean() }) },
  )
  .delete('/:id', async ({ params }) => {
    await deviceService.unlink(params.id);
    return { ok: true };
  })
  .patch(
    '/:id/grants',
    ({ params, body }) => ({
      ok: true,
      data: deviceService.grants(params.id, body.allowAgents, body.agentRouting),
    }),
    { body: t.Object({ allowAgents: t.Boolean(), agentRouting: t.Boolean() }) },
  )
  .post(
    '/:id/rpc',
    async ({ params, body, request }) => ({
      ok: true,
      data:
        params.id === deviceService.status().local?.id
          ? await deviceService.execute(
              null,
              body.operation,
              body.input ?? {},
              'user',
              crypto.randomUUID(),
            )
          : await deviceService.rpc(
              params.id,
              body.operation,
              body.input ?? {},
              'user',
              request.signal,
            ),
    }),
    {
      body: t.Object({
        operation: t.String({ maxLength: 80 }),
        input: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  );
