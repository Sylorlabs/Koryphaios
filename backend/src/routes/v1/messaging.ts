import { Elysia, t } from 'elysia';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../runtime/paths';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import type { KoryphaiosConfig } from '@koryphaios/shared';

const configPath = join(PROJECT_ROOT, 'koryphaios.json');

function readMessagingConfig(): Partial<KoryphaiosConfig> {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<KoryphaiosConfig>;
  } catch {
    return {};
  }
}

function writeMessagingConfig(nextConfig: Partial<KoryphaiosConfig>): void {
  if (process.env.NODE_ENV === 'test') return;
  writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
}

function formatMessagingState(config: Partial<KoryphaiosConfig>) {
  return {
    telegram: {
      enabled: !!config.telegram,
      adminId: config.telegram?.adminId ?? null,
      botTokenSet: !!config.telegram?.botToken,
    },
  };
}

export const messagingRoutes = new Elysia({ prefix: '/api/messaging' })
  .get('/', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const config = readMessagingConfig();
    return {
      ok: true,
      data: formatMessagingState(config),
    };
  })
  .put(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      const current = readMessagingConfig();
      const nextConfig: Partial<KoryphaiosConfig> = { ...current };

      if (body.telegram === null) {
        delete nextConfig.telegram;
      } else if (body.telegram) {
        const existing = current.telegram;
        nextConfig.telegram = {
          botToken: body.telegram.botToken?.trim() || existing?.botToken || '',
          adminId: body.telegram.adminId,
          secretToken: existing?.secretToken,
          webhookUrl: existing?.webhookUrl,
        };
      }

      writeMessagingConfig(nextConfig);
      return {
        ok: true,
        data: formatMessagingState(nextConfig),
      };
    },
    {
      body: t.Object({
        telegram: t.Nullable(
          t.Optional(
            t.Object({
              botToken: t.Optional(t.String()),
              adminId: t.Number(),
            }),
          ),
        ),
      }),
    },
  );
