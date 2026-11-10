import { Elysia, t } from 'elysia';
import type { DesktopUiSettings } from '@koryphaios/shared';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getContext } from '../../context';
import {
  loadDesktopUiSettings,
  requestOnboardingReplay,
  resetDesktopShortcuts,
  saveDesktopShortcuts,
  saveWelcomePreferences,
} from '../../desktop-ui-settings';
import { cloneDefaultWelcomePreferences } from '@koryphaios/shared';
import { serverLog } from '../../logger';

function broadcast(settings: DesktopUiSettings, replayWalkthrough = false): void {
  try {
    getContext().wsManager.broadcast({
      type: 'desktop.ui.updated',
      payload: { settings, replayWalkthrough },
      timestamp: Date.now(),
    });
  } catch (error) {
    serverLog.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'desktop UI settings broadcast skipped',
    );
  }
}

const welcomeBody = t.Object({
  enabled: t.Object({ suggestions: t.Boolean() }),
  homeTitle: t.String({ maxLength: 160 }),
  homeSubtitle: t.String({ maxLength: 300 }),
  suggestionPrompts: t.Record(t.String(), t.String({ maxLength: 20_000 })),
  suggestionCards: t.Record(
    t.String({ maxLength: 120 }),
    t.Object({
      label: t.String({ maxLength: 120 }),
      icon: t.String({ maxLength: 40 }),
      iconSource: t.Optional(t.String({ maxLength: 350_000 })),
      prompt: t.String({ maxLength: 20_000 }),
      provider: t.Optional(t.String({ maxLength: 120 })),
      model: t.Optional(t.String({ maxLength: 240 })),
      reasoning: t.Optional(t.String({ maxLength: 80 })),
      permission: t.Optional(t.String({ maxLength: 80 })),
      skills: t.Array(t.String({ maxLength: 120 }), { maxItems: 30 }),
      enabled: t.Boolean(),
    }),
  ),
  background: t.Optional(
    t.Object({
      source: t.String({ maxLength: 7_000_000 }),
      fit: t.Union([t.Literal('cover'), t.Literal('contain'), t.Literal('fill')]),
      position: t.String({ maxLength: 40 }),
      opacity: t.Number({ minimum: 0, maximum: 1 }),
    }),
  ),
});

const shortcutBody = t.Array(
  t.Object({
    id: t.String({ minLength: 1, maxLength: 80 }),
    keys: t.Array(t.String({ minLength: 1, maxLength: 40 }), {
      minItems: 1,
      maxItems: 5,
    }),
    action: t.Optional(t.String()),
    description: t.Optional(t.String()),
  }),
);

export const desktopUiRoutes = new Elysia({ prefix: '/api/desktop-ui' })
  .get('/', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: loadDesktopUiSettings() };
  })
  .put(
    '/welcome',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const settings = saveWelcomePreferences(body);
      broadcast(settings);
      return { ok: true, data: settings };
    },
    { body: welcomeBody },
  )
  .post('/welcome/reset', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = saveWelcomePreferences(cloneDefaultWelcomePreferences());
    broadcast(settings);
    return { ok: true, data: settings };
  })
  .put(
    '/shortcuts',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const settings = saveDesktopShortcuts(body);
      broadcast(settings);
      return { ok: true, data: settings };
    },
    { body: shortcutBody },
  )
  .post('/shortcuts/reset', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = resetDesktopShortcuts();
    broadcast(settings);
    return { ok: true, data: settings };
  })
  .post('/onboarding/replay', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = requestOnboardingReplay();
    broadcast(settings, true);
    return { ok: true, data: settings };
  });
