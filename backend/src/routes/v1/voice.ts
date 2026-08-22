// Voice API routes.
//
// Error handling: route handlers throw KoryphaiosError subclasses for
// operational errors and let unknown errors propagate to the global
// error-handling middleware (middleware/error-handling.ts), which logs with
// context and formats the response. Per AGENTS.md, route handlers do not
// try/catch just to format errors.

import { Elysia, t } from 'elysia';
import {
  downloadVoicePack,
  listVoicePacks,
  listVoiceProviders,
  loadVoiceSettings,
  saveVoiceSettings,
  synthesizeCloud,
  transcribeCloud,
} from '../../voice/voice-service';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError } from '../../errors/types';
import type { SynthesisRequest } from '@koryphaios/shared';

export const voiceRoutes = new Elysia({ prefix: '/api/voice' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })
  .get('/settings', async () => ({ ok: true, data: await loadVoiceSettings() }))
  .put('/settings', async ({ body }) => ({ ok: true, data: await saveVoiceSettings(body) }), {
    body: t.Any(),
  })
  .get('/providers', async () => ({ ok: true, data: await listVoiceProviders() }))
  .get('/packs', async () => ({ ok: true, data: await listVoicePacks() }))
  .post('/packs/:id/download', async ({ params }) => ({
    ok: true,
    data: await downloadVoicePack(params.id),
  }))
  .post('/transcribe', async ({ body }) => ({ ok: true, data: await transcribeCloud(body) }), {
    body: t.Object({
      audioBase64: t.String(),
      mimeType: t.Optional(t.String()),
      language: t.Optional(t.String()),
    }),
  })
  .post(
    '/synthesize',
    async ({ body }) => ({
      ok: true,
      data: await synthesizeCloud(body as SynthesisRequest),
    }),
    { body: t.Any() },
  );
