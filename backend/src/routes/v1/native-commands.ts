// Native CLI slash command routes.
//
// `GET  /api/native-commands?provider=<name>` → the native `/command` list for
//   a CLI provider harness, so the composer can surface them in the slash
//   picker (clearly labeled with the provider's name).
// `POST /api/native-commands/run` → execute a native `/command` for the
//   active CLI provider and stream the output back over WebSocket as
//   `native.command` events attributed to that provider harness.

import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { serverLog } from '../../logger';
import { AuthenticationError, NotFoundError, ValidationError } from '../../errors/types';
import { resolveModel } from '../../providers';
import {
  executeNativeSlashCommand,
  getNativeProviderLabel,
  getNativeSlashCommands,
  isNativeCliProvider,
  newNativeMessageId,
  parseNativeCommandLine,
  type NativeCommandExecContext,
} from '../../providers/native-slash-commands';
import type { NativeCommandPayload, WSMessage } from '@koryphaios/shared';

export const nativeCommandRoutes = new Elysia({ prefix: '/api/native-commands' })
  .get('/', async ({ request, query }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const provider = (query.provider ?? '').toString();
    if (!provider || !isNativeCliProvider(provider)) {
      return { ok: true, data: { provider: provider || null, label: null, commands: [] } };
    }
    return {
      ok: true,
      data: {
        provider,
        label: getNativeProviderLabel(provider),
        commands: getNativeSlashCommands(provider),
      },
    };
  })
  .post(
    '/run',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { kory, sessions, providers, wsManager } = getContext();

      const session = await sessions.get(body.sessionId);
      if (!session) {
        throw new NotFoundError('Session', body.sessionId);
      }

      const parsed = parseNativeCommandLine(body.command);
      if (!parsed) {
        throw new ValidationError('Command must start with /');
      }

      // Resolve the active provider for this session: an explicit model pick
      // (e.g. "claude:sonnet") wins; otherwise fall back to the manager's
      // last-resolved routing for the session, then the first available CLI.
      let providerName = '';
      if (body.model && body.model.includes(':')) {
        providerName = body.model.split(':')[0];
      }
      if (!providerName) {
        const routing = kory.getLastManagerRouting(body.sessionId);
        if (routing?.provider) providerName = String(routing.provider);
      }
      if (!providerName || !isNativeCliProvider(providerName)) {
        // Try to infer from the model id via the catalog.
        const modelDef = body.model ? resolveModel(body.model) : undefined;
        if (modelDef && isNativeCliProvider(modelDef.provider)) {
          providerName = modelDef.provider;
        }
      }
      if (!providerName || !isNativeCliProvider(providerName)) {
        // Last resort: the first available CLI harness provider.
        const cliProvider = providers
          .getStatus()
          .find((p) => p.authenticated && isNativeCliProvider(p.name));
        if (cliProvider) providerName = cliProvider.name;
      }
      if (!providerName || !isNativeCliProvider(providerName)) {
        throw new ValidationError(
          'No CLI provider is active. Select a CLI-backed provider (Claude Code, Codex, Devin, Grok, Cursor, Cline, Antigravity, Kimi Code) to use its /commands.',
        );
      }

      const workingDirectory =
        (session.workingDirectory && session.workingDirectory.trim()) ||
        (await kory.resolveSessionWorkingDirectoryPublic(body.sessionId));

      const messageId = newNativeMessageId();
      const providerLabel = getNativeProviderLabel(providerName);

      const emit: NativeCommandExecContext['emit'] = (text, opts) => {
        const payload: NativeCommandPayload = {
          provider: providerName,
          providerLabel,
          command: parsed.command,
          rawCommand: body.command,
          text,
          isPartial: opts?.isPartial,
          isError: opts?.isError,
          messageId,
        };
        const wsMessage: WSMessage = {
          type: 'native.command',
          payload,
          timestamp: Date.now(),
          sessionId: body.sessionId,
        };
        wsManager.broadcastToSession(body.sessionId, wsMessage);
      };

      // Run the executor in the background; the route returns immediately and
      // output streams over WebSocket. The executor always emits at least one
      // final chunk so the frontend finalizes the feed entry.
      void (async () => {
        try {
          const handled = await executeNativeSlashCommand({
            provider: providerName,
            model: body.model,
            workingDirectory,
            command: parsed.command,
            args: parsed.args,
            rawCommand: body.command,
            emit,
          });
          if (!handled) {
            emit(`/${parsed.command} is not a recognized ${providerLabel} command.`, {
              isError: true,
            });
          }
        } catch (err: unknown) {
          serverLog.warn({ err, providerName, command: body.command }, 'Native command failed');
          emit(
            `Failed to run /${parsed.command}: ${err instanceof Error ? err.message : String(err)}`,
            { isError: true },
          );
        }
      })();

      return { ok: true, data: { status: 'running', provider: providerName, messageId } };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        command: t.String(),
        model: t.Optional(t.String()),
      }),
    },
  );
