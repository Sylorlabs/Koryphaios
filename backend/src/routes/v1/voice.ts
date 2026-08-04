import { Elysia, t } from 'elysia';
import { assertNoCloudFallback, downloadVoicePack, listVoicePacks, listVoiceProviders, loadVoiceSettings, saveVoiceSettings, synthesizeCloud, transcribeCloud } from '../../voice/voice-service';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const voiceRoutes = new Elysia({ prefix: '/api/voice' })
  .onBeforeHandle(({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
  })
  .get('/settings', async () => ({ ok: true, data: await loadVoiceSettings() }))
  .put('/settings', async ({ body, set }) => { try { return { ok: true, data: await saveVoiceSettings(body) }; } catch (e) { set.status = 400; return { ok: false, error: e instanceof Error ? e.message : 'Invalid settings' }; } }, { body: t.Any() })
  .get('/providers', async () => ({ ok: true, data: await listVoiceProviders() }))
  .get('/packs', async () => ({ ok: true, data: await listVoicePacks() }))
  .post('/packs/:id/download', async ({ params, set }) => {
    try {
      return { ok: true, data: await downloadVoicePack(params.id) };
    } catch (error) {
      set.status = 502;
      return { ok: false, error: error instanceof Error ? error.message : 'Voice pack download failed' };
    }
  })
  .post('/transcribe', async ({ body, set }) => { const settings = await loadVoiceSettings(); try { if (settings.input.provider === 'local') assertNoCloudFallback(settings, 'stt'); return { ok: true, data: await transcribeCloud() }; } catch (e) { set.status = 503; return { ok: false, error: e instanceof Error ? e.message : 'Transcription failed' }; } }, { body: t.Any() })
  .post('/synthesize', async ({ body, set }) => { const settings = await loadVoiceSettings(); try { if (settings.output.provider === 'local') assertNoCloudFallback(settings, 'tts'); return { ok: true, data: await synthesizeCloud(body as never) }; } catch (e) { set.status = 503; return { ok: false, error: e instanceof Error ? e.message : 'Synthesis failed' }; } }, { body: t.Any() });
