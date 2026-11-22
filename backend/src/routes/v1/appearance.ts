import { Elysia, t } from 'elysia';
import {
  loadAppearanceSettings,
  saveAppearanceSettings,
  type AppearanceSettings,
} from '../../appearance-settings';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

const themePresetV1 = t.Union([
  t.Literal('kintsugi'),
  t.Literal('midnight'),
  t.Literal('nord'),
  t.Literal('dracula'),
  t.Literal('catppuccin'),
  t.Literal('gruvbox'),
  t.Literal('tokyo'),
  t.Literal('solarized'),
  t.Literal('kintsugi-light'),
  t.Literal('light'),
  t.Literal('nord-light'),
  t.Literal('tokyo-day'),
  t.Literal('lagoon'),
  t.Literal('everforest-light'),
  t.Literal('gruvbox-light'),
  t.Literal('rose-pine-dawn'),
  t.Literal('catppuccin-latte'),
  t.Literal('system'),
]);

const themePreset = t.Union([
  t.Literal('kintsugi'),
  t.Literal('midnight'),
  t.Literal('nord'),
  t.Literal('dracula'),
  t.Literal('catppuccin'),
  t.Literal('gruvbox'),
  t.Literal('tokyo'),
  t.Literal('solarized'),
  t.Literal('kintsugi-light'),
  t.Literal('light'),
  t.Literal('nord-light'),
  t.Literal('tokyo-day'),
  t.Literal('lagoon'),
  t.Literal('everforest-light'),
  t.Literal('gruvbox-light'),
  t.Literal('rose-pine-dawn'),
  t.Literal('catppuccin-latte'),
]);

const accent = t.Union([
  t.Literal('gold'),
  t.Literal('indigo'),
  t.Literal('cyan'),
  t.Literal('emerald'),
  t.Literal('amber'),
  t.Literal('rose'),
  t.Literal('violet'),
  t.Literal('custom'),
]);

const font = t.Union([
  t.Literal('inter'),
  t.Literal('geist'),
  t.Literal('jetbrains'),
  t.Literal('roboto'),
  t.Literal('outfit'),
  t.Literal('space-grotesk'),
  t.Literal('dm-sans'),
  t.Literal('plus-jakarta'),
  t.Literal('source-code-pro'),
  t.Literal('ibm-plex-mono'),
  t.Literal('fira-code'),
  t.Literal('berkeley-mono'),
  t.Literal('source-serif'),
  t.Literal('roboto-slab'),
]);

const customAccent = t.Object({
  main: t.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
  hover: t.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
});

const modeAppearance = t.Object({
  preset: themePreset,
  accent,
  secondaryAccent: accent,
  customAccent: t.Optional(customAccent),
  customSecondaryAccent: t.Optional(customAccent),
});

const appearanceBodyV2 = t.Object({
  version: t.Literal(2),
  mode: t.Union([t.Literal('dark'), t.Literal('light'), t.Literal('system')]),
  font,
  dark: modeAppearance,
  light: modeAppearance,
});

const appearanceBodyV1 = t.Object({
  preset: themePresetV1,
  accent,
  secondaryAccent: accent,
  font,
  customAccent: t.Optional(customAccent),
  customSecondaryAccent: t.Optional(customAccent),
});

// Both shapes are accepted so an older frontend can keep writing while a newer
// backend serves either surface.
const appearanceBody = t.Union([appearanceBodyV2, appearanceBodyV1]);

export const appearanceRoutes = new Elysia({ prefix: '/api/appearance' })
  .get('/', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: loadAppearanceSettings() };
  })
  .put(
    '/',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const saved = saveAppearanceSettings(body as AppearanceSettings);
      return { ok: true, data: saved };
    },
    { body: appearanceBody },
  );
