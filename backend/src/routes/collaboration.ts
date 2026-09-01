import { Elysia, t } from 'elysia';
import { collaborationManager } from '../collaboration/manager';
import { requireLocalRouteAuth } from '../auth/local-route-auth';
import { relayAvailable } from '../collaboration/relay-client';
import { getContext } from '../context';
import { AuthenticationError, NotFoundError, ConfigurationError } from '../errors/types';
import type { CollaborationAccessTier, SandboxPolicy } from '@koryphaios/shared';

export const collaborationRoutes = new Elysia({ prefix: '/api/collab' })

  // Rebuild the host-control projection after a renderer reload. If the
  // backend itself restarted, the manager creates a fresh checked relay host
  // instead of advertising a stale in-memory connection.
  .get(
    '/active',
    async ({ request, query }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      return {
        ok: true,
        data: await collaborationManager.restoreHostForBaseSession(query.baseSessionId),
      };
    },
    { query: t.Object({ baseSessionId: t.String({ minLength: 1, maxLength: 200 }) }) },
  )

  // Canonical host start endpoint. Keeping the session id in the JSON body
  // avoids route ambiguity and gives host configuration a stable contract.
  .post(
    '/host/start',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below; cast bridges the
      // inferred route type to the local handler contract.
      const input = body as { sessionId: string; ownerId?: string; workspacePaths?: string[] };
      const result = await collaborationManager.hostSession(
        input.sessionId,
        input.ownerId || 'local-user',
        input.workspacePaths || [],
      );
      return { ok: true, data: result };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        ownerId: t.Optional(t.String()),
        workspacePaths: t.Optional(t.Array(t.String())),
      }),
    },
  )

  // Start hosting — returns session info + invite links
  .post(
    '/:id/start',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below.
      const input = body as { ownerId?: string; workspacePaths?: string[] };
      const result = await collaborationManager.hostSession(
        id,
        input.ownerId || 'local-user',
        input.workspacePaths || [],
      );
      return { ok: true, data: result };
    },
    {
      body: t.Optional(
        t.Object({
          ownerId: t.Optional(t.String()),
          workspacePaths: t.Optional(t.Array(t.String())),
        }),
      ),
    },
  )

  // Join via legacy 6-char code (fallback for local network use)
  .post(
    '/join',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (!relayAvailable)
        throw new ConfigurationError('WAN collaboration relay is not configured');
      // Body shape is validated by the Elysia schema below.
      const input = body as { joinCode: string };
      const session = await collaborationManager.joinRelaySession(input.joinCode);
      return { ok: true, data: session };
    },
    {
      body: t.Object({
        joinCode: t.String(),
        userId: t.String(),
        name: t.String(),
        role: t.Optional(t.Union([t.Literal('viewer'), t.Literal('collaborator')])),
      }),
    },
  )

  .patch(
    '/:id/policy',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below.
      const input = body as {
        allowedModels?: string[];
        allowPrompts?: boolean;
        requirePromptApproval?: boolean;
        showDiffs?: boolean;
        showAgentStatus?: boolean;
        showParticipants?: boolean;
        joinMode?: 'approval' | 'auto';
        defaultTierId?: string;
        accessTiers?: CollaborationAccessTier[];
        modelCatalog?: Array<{
          id: string;
          label: string;
          provider: string;
          reasoningLevels: string[];
        }>;
        sessionName?: string;
        workspacePaths?: string[];
      };
      return { ok: true, data: await collaborationManager.updatePolicy(id, input) };
    },
    {
      body: t.Object({
        allowedModels: t.Optional(t.Array(t.String())),
        allowPrompts: t.Optional(t.Boolean()),
        requirePromptApproval: t.Optional(t.Boolean()),
        showDiffs: t.Optional(t.Boolean()),
        showAgentStatus: t.Optional(t.Boolean()),
        showParticipants: t.Optional(t.Boolean()),
        joinMode: t.Optional(t.Union([t.Literal('approval'), t.Literal('auto')])),
        defaultTierId: t.Optional(t.String()),
        accessTiers: t.Optional(t.Array(t.Any())),
        modelCatalog: t.Optional(t.Array(t.Any())),
        sessionName: t.Optional(t.String({ maxLength: 80 })),
        workspacePaths: t.Optional(t.Array(t.String(), { maxItems: 24 })),
      }),
    },
  )

  // Get pending guest prompts waiting for host approval
  .get('/:id/pending', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    if (!(await collaborationManager.hydrateRuntimeForSession(id))) {
      throw new NotFoundError('Collaboration session', id);
    }
    return {
      ok: true,
      data: {
        prompts: collaborationManager.getPendingPrompts(id),
        joins: collaborationManager.getPendingJoins(id),
        participants: collaborationManager.getConnectedGuests(id),
      },
    };
  })

  // Host approves or rejects a guest prompt
  .post(
    '/:id/approve',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below.
      const { promptId, approved } = body as { promptId: string; approved: boolean };
      await collaborationManager.hydrateRuntimeForSession(id);
      const pending = collaborationManager.getPendingPrompt(promptId);
      if (!pending || pending.sessionId !== id) {
        throw new NotFoundError('Pending guest prompt', promptId);
      }
      if (!approved) {
        const prompt = await collaborationManager.resolveGuestPrompt(promptId, false);
        return { ok: true, data: { approved: false, prompt } };
      }
      if (approved) {
        const state = await collaborationManager.getSessionState(id);
        if (!state) throw new NotFoundError('Collaboration session not found');
        const submission = await getContext().kory.startSessionTurn({
          sessionId: state.session.baseSessionId,
          source: 'collaboration',
          sourceCommandId: pending.sourceCommandId,
          userMessage: pending.content,
          preferredModel: pending.model || undefined,
          reasoningLevel: pending.reasoningLevel || undefined,
          collaborationToolPolicy: {
            commandAllowlist: pending.commandAllowlist || [],
            commandBlocklist: pending.commandBlocklist || [],
          },
        });
        if (!submission.accepted) {
          if (submission.result.status === 'rejected') {
            set.status = 409;
            return {
              ok: false,
              error: 'The target chat is busy; the guest prompt remains pending.',
            };
          }
          if (submission.result.status !== 'completed') {
            set.status = 409;
            return {
              ok: false,
              error:
                'This guest prompt has an incomplete prior execution and was not replayed. It remains pending; reject it and submit a new prompt to retry explicitly.',
            };
          }
        }
        const prompt = await collaborationManager.resolveGuestPrompt(promptId, true);
        if (submission.accepted) {
          void submission.completion.catch(() => undefined);
        }
        return {
          ok: true,
          data: {
            approved: true,
            prompt,
            runId: submission.accepted ? submission.runId : submission.result.runId,
          },
        };
      }
      throw new Error('Unreachable collaboration approval state');
    },
    { body: t.Object({ promptId: t.String(), approved: t.Boolean() }) },
  )

  .post(
    '/:id/join-decision',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below.
      const { guestId, approved, tierId } = body as {
        guestId: string;
        approved: boolean;
        tierId?: string;
      };
      await collaborationManager.hydrateRuntimeForSession(id);
      const pending = collaborationManager.getPendingJoins(id).find((join) => join.guestId === guestId);
      if (!pending) throw new NotFoundError('Pending guest join', guestId);
      return { ok: true, data: collaborationManager.resolveJoin(guestId, approved, tierId) };
    },
    {
      body: t.Object({
        guestId: t.String(),
        approved: t.Boolean(),
        tierId: t.Optional(t.String()),
      }),
    },
  )

  .post(
    '/:id/assign-tier',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below.
      const { guestId, tierId } = body as { guestId: string; tierId: string };
      await collaborationManager.hydrateRuntimeForSession(id);
      collaborationManager.assignParticipantTier(guestId, tierId, id);
      return { ok: true };
    },
    { body: t.Object({ guestId: t.String(), tierId: t.String() }) },
  )

  .post(
    '/:id/invite',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Body shape is validated by the Elysia schema below.
      const { tierId } = body as { tierId: string };
      return {
        ok: true,
        data: {
          tierId,
          url: await collaborationManager.createInvite(tierId),
        },
      };
    },
    { body: t.Object({ tierId: t.String() }) },
  )

  // Get session state
  .get('/:id/state', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const state = await collaborationManager.getSessionState(id);
    if (!state) throw new NotFoundError('Session', id);
    return { ok: true, data: state };
  })

  // End session
  .post('/:id/end', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    await collaborationManager.endSession(id);
    return { ok: true };
  })

  // ─── Shared providers (host side): which providers to serve remotely ──────
  .get('/providers/shared', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { getSharedProviders, getSharedModels, isAgenticProvider } =
      await import('../collaboration/remote-provider-host');
    // Attach the risk classification for the UI's compliance gating.
    const { classifyProviderShare } = await import('@koryphaios/shared');
    const status = getContext().providers.getStatus();
    const shared = new Set(getSharedProviders());
    return {
      ok: true,
      data: {
        shared: [...shared],
        sharedModels: getSharedModels(),
        // Show the complete provider catalog. An unavailable provider remains
        // visible (and explains why it cannot be shared) rather than vanishing
        // from the user's mental model of what Koryphaios supports.
        candidates: status.map((p) => ({
          provider: p.name,
          label: p.label ?? p.name,
          modelCount: p.allAvailableModels.length || p.models.length,
          models: p.allAvailableModels.map((model) => ({ id: model.id, name: model.name })),
          available: p.adapterAvailable && p.enabled,
          // CLI harnesses run on the host and see the guest's files.
          agentic: isAgenticProvider(p.name),
          ...classifyProviderShare(p.name),
        })),
      },
    };
  })
  .post(
    '/providers/shared',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { setSharedProviders } = await import('../collaboration/remote-provider-host');
      // Body shape is validated by the Elysia schema below.
      const input = body as { providers: string[]; models?: Record<string, string[]> };
      setSharedProviders(input.providers ?? [], input.models ?? {});
      return { ok: true };
    },
    {
      body: t.Object({
        providers: t.Array(t.String()),
        models: t.Optional(t.Record(t.String(), t.Array(t.String()))),
      }),
    },
  )

  // ─── Sandbox policy (host side): how remote CLI turns are confined ────────
  .get('/providers/sandbox', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { getSandboxPolicy } = await import('../collaboration/remote-provider-host');
    const { sandboxCapabilities } = await import('../collaboration/sandbox-runner');
    return { ok: true, data: { policy: getSandboxPolicy(), capabilities: sandboxCapabilities() } };
  })
  .post(
    '/providers/sandbox',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { setSandboxPolicy } = await import('../collaboration/remote-provider-host');
      // Body shape is validated by the Elysia schema below.
      const { policy } = body as { policy: SandboxPolicy };
      setSandboxPolicy(policy);
      return { ok: true };
    },
    {
      body: t.Object({
        policy: t.Object({
          preset: t.String(),
          filesystemIsolation: t.Boolean(),
          allowNetwork: t.Boolean(),
          allowShell: t.Boolean(),
          allowEdits: t.Boolean(),
          allowWebSearch: t.Boolean(),
          commandBlocklist: t.Array(t.String()),
          maxRuntimeSeconds: t.Number(),
        }),
      }),
    },
  )

  // ─── Remote providers (client side): consume a host's shared providers ────
  .post(
    '/providers/connect',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { connectToProviderHost } = await import('../collaboration/remote-provider-client');
      // Body shape is validated by the Elysia schema below.
      const input = body as { joinCode: string; name?: string };
      const result = await connectToProviderHost(input.joinCode, input.name || 'Koryphaios client');
      return { ok: true, data: result };
    },
    { body: t.Object({ joinCode: t.String(), name: t.Optional(t.String()) }) },
  )
  .post('/providers/disconnect', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { disconnectFromProviderHost } = await import('../collaboration/remote-provider-client');
    disconnectFromProviderHost();
    return { ok: true };
  })
  .get('/providers/remote-status', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { remoteProviderStatus } = await import('../collaboration/remote-provider-client');
    return { ok: true, data: remoteProviderStatus() };
  });
