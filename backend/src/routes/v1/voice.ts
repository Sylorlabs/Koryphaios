// Voice API routes.
//
// Error handling: route handlers throw KoryphaiosError subclasses for
// operational errors and let unknown errors propagate to the global
// error-handling middleware (middleware/error-handling.ts), which logs with
// context and formats the response. Per AGENTS.md, route handlers do not
// try/catch just to format errors.

import { Elysia, t } from 'elysia';
import {
  assertNoCloudFallback,
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
  .post(
    '/transcribe',
    async () => {
      const settings = await loadVoiceSettings();
      assertNoCloudFallback(settings, 'stt');
      return { ok: true, data: await transcribeCloud() };
    },
    { body: t.Any() },
  )
  .post(
    '/synthesize',
    async ({ body }) => {
      const settings = await loadVoiceSettings();
      assertNoCloudFallback(settings, 'tts');
      // Elysia body is typed as t.Any() (unvalidated); cast to the shape the
      // synthesis adapter expects. The adapter validates internally.
      return { ok: true, data: await synthesizeCloud(body as SynthesisRequest) };
    },
    { body: t.Any() },
  );
