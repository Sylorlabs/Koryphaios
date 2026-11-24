import { Elysia, t } from 'elysia';
import type { SessionAgentOverrides } from '@koryphaios/shared';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { processSupervisor } from '../../process-supervisor/supervisor';
import { serializeProcess } from '../../process-supervisor/serialize';
import {
  setSessionAgentOverrides,
  clearSessionAgentOverrides,
} from '../../stores/session-agent-overrides';
import { serverLog } from '../../logger';
import { writeAllCliRulesAndSkills } from '../../providers/cli-rules-skills';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors/types';
import { SESSION } from '../../constants';
import { sessionSettingsRoot } from '../../kory/session-workspace';
import { listToolServerIdentities } from '../../mcp/server-service';
import { koryMcpServerIdentity } from '../../providers/cli-bridges';
import { timeTravelDegradedResponse, withSessionRecoveryGuard } from './session-recovery-guard';
import {
  eraseSessionsCoordinated,
  tryAcquireSessionCreationLease,
} from '../../services/session-erasure-service';
import {
  archiveSessionCoordinated,
  restoreSessionCoordinated,
} from '../../services/session-archive-service';
import { forkSessionAtMessage } from '../../services/session-fork-service';
import { stopChatRun } from '../../services/chat-run-control';
import { projectRootFromRequest } from '../../runtime/source-control-scope';
import { sourceControlService } from '../../services/source-control-service';

async function requireActiveSession(sessionId: string) {
  const { sessions } = getContext();
  const session = await sessions.get(sessionId);
  if (!session) throw new NotFoundError('Session', sessionId);
  if (session.archivedAt !== undefined) {
    throw new ConflictError('Recover this archived chat before changing or continuing its work.');
  }
  return session;
}

async function timeTravelForSession(sessionId: string) {
  const { kory, timeTravel } = getContext();
  await requireActiveSession(sessionId);
  const workingDirectory = await kory.resolveSessionWorkingDirectoryPublic(sessionId);
  return timeTravel.forWorkingDirectory(workingDirectory);
}

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })
  .get('/', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions, runs } = getContext();
    const list = await sessions.listActive();
    // One lightweight durable projection hydrates all sidebar chats, including
    // sessions never opened in this renderer. No worker history is inferred.
    const runStates = list.map((session) => runs.store.getOrIdle(session.id));
    return { ok: true, data: list, runStates };
  })
  .post(
    '/',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { sessions } = getContext();
      const creationLease = tryAcquireSessionCreationLease();
      if (!creationLease) {
        throw new ConflictError(
          'Session creation is temporarily blocked while delete-all is finishing.',
        );
      }
      let session;
      try {
        // A revision choice always creates an isolated, persistent checkout.
        // Never switch a directory which another chat/provider may be using.
        const workspace = body.git
          ? await sourceControlService.createChatWorkspace(
              projectRootFromRequest(request),
              body.git,
            )
          : undefined;
        try {
          session = await sessions.create(
            'local-user',
            body.title,
            body.parentId,
            workspace?.repositoryPath ?? body.workingDirectory,
            workspace,
          );
        } catch (error) {
          if (workspace) {
            throw new ConflictError(
              `The isolated repository was created at ${workspace.path}, but its chat could not be saved. Your branch ${workspace.branch} is preserved; open that folder to recover it.`,
            );
          }
          throw error;
        }
      } finally {
        creationLease.release();
      }
      // Write Koryphaios rules + skills files to every CLI's isolated home so
      // the native CLIs (claude, codex, devin, grok, cursor, antigravity)
      // discover Kory's tool-usage + orchestration conventions on startup.
      try {
        writeAllCliRulesAndSkills(session.id, '');
      } catch (err: unknown) {
        // Expected failure: CLI rules are supplementary, not request-critical.
        serverLog.warn({ err, sessionId: session.id }, 'Failed to write CLI rules + skills');
      }
      getContext().wsManager.broadcastEphemeral({
        type: 'session.updated',
        sessionId: session.id,
        timestamp: Date.now(),
        payload: { session },
      });
      return { ok: true, data: session };
    },
    {
      body: t.Object({
        userId: t.Optional(t.String()),
        title: t.Optional(t.String()),
        parentId: t.Optional(t.String()),
        workingDirectory: t.Optional(t.String()),
        git: t.Optional(
          t.Object({
            ref: t.String({ minLength: 1, maxLength: 1024 }),
            expectedHash: t.Optional(t.String({ pattern: '^[a-fA-F0-9]{40,64}$' })),
            branch: t.String({ minLength: 1, maxLength: 255 }),
          }),
        ),
      }),
    },
  )
  .delete('/', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const result = await eraseSessionsCoordinated({ kind: 'all' });
    return { ok: true, deleted: result.deleted, operationId: result.operationId };
  })
  .get('/archived', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const list = await getContext().sessions.listArchived();
    return { ok: true, data: list };
  })
  .get('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions } = getContext();
    const session = await sessions.get(id);
    if (!session) throw new NotFoundError('Session', id);
    return { ok: true, data: session };
  })
  .patch(
    '/:id',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { sessions } = getContext();
      const current = await sessions.get(id);
      if (!current) throw new NotFoundError('Session', id);
      if (
        current.archivedAt !== undefined &&
        (body.title === undefined || Object.keys(body).some((field) => field !== 'title'))
      ) {
        throw new ConflictError('Archived chats can only be renamed, recovered, or deleted.');
      }
      const title = body.title?.trim();
      if (body.title !== undefined) {
        if (!title) throw new ValidationError('Chat name cannot be empty.');
        if (title.length > SESSION.MAX_TITLE_LENGTH) {
          throw new ValidationError(
            `Chat name cannot exceed ${SESSION.MAX_TITLE_LENGTH} characters.`,
          );
        }
        if (/\p{Cc}/u.test(title)) {
          throw new ValidationError('Chat name cannot contain control characters.');
        }
      }
      // Composer PATCH requests replace only the settings they own. Manager
      // controls and agent-owned skill-feed blocks are separate durable
      // surfaces and must survive a YOLO/critic toggle that happens to
      // serialize a fresh agentOverrides object.
      const preservedOverrides: SessionAgentOverrides = current.agentOverrides?.managerControls
        ? { managerControls: current.agentOverrides.managerControls }
        : {};
      if (current.agentOverrides?.blockedSkillFeeds) {
        preservedOverrides.blockedSkillFeeds = current.agentOverrides.blockedSkillFeeds;
      }
      const agentOverrides =
        body.agentOverrides === undefined
          ? undefined
          : Object.keys(body.agentOverrides).length === 0
            ? preservedOverrides
            : {
                ...current.agentOverrides,
                ...body.agentOverrides,
                ...(body.agentOverrides.managerControls === undefined &&
                current.agentOverrides?.managerControls
                  ? { managerControls: current.agentOverrides.managerControls }
                  : {}),
              };
      const updated = await sessions.update(id, {
        ...body,
        ...(agentOverrides !== undefined ? { agentOverrides } : {}),
        ...(title !== undefined ? { title } : {}),
      });
      if (!updated) throw new NotFoundError('Session', id);
      // Keep the in-process turn-path mirror in step with the durable row so the
      // next turn enforces this chat's approval preset, agent mode, and critic
      // toggle instead of the project-wide defaults.
      if (updated.agentOverrides !== undefined) {
        setSessionAgentOverrides(id, updated.agentOverrides);
      }
      return { ok: true, data: updated };
    },
    {
      body: t.Partial(
        t.Object({
          title: t.String(),
          messageCount: t.Number(),
          totalTokensIn: t.Number(),
          totalTokensOut: t.Number(),
          totalCost: t.Number(),
          interactionMode: t.Union([t.Literal('act'), t.Literal('plan')]),
          agentOverrides: t.Object({
            permissionMode: t.Optional(
              t.Union([
                t.Literal('yolo'),
                t.Literal('guarded'),
                t.Literal('edits'),
                t.Literal('ask'),
                t.Literal('custom'),
              ]),
            ),
            agentExecutionMode: t.Optional(
              t.Union([t.Literal('auto'), t.Literal('single'), t.Literal('multi')]),
            ),
            worktreeMode: t.Optional(
              t.Union([t.Literal('auto'), t.Literal('always'), t.Literal('never')]),
            ),
            worktreeIsolation: t.Optional(t.Boolean()),
            criticGateEnabled: t.Optional(t.Boolean()),
            criticMode: t.Optional(
              t.Union([t.Literal('auto'), t.Literal('always'), t.Literal('off')]),
            ),
            managerControls: t.Optional(
              t.Record(
                t.String(),
                t.Object({
                  model: t.String(),
                  provider: t.Optional(t.String()),
                  reasoningLevel: t.Optional(t.String()),
                  fallbacks: t.Optional(
                    t.Array(
                      t.Object({
                        model: t.String(),
                        reasoningLevel: t.Optional(t.String()),
                      }),
                      { maxItems: 20 },
                    ),
                  ),
                }),
              ),
            ),
          }),
        }),
      ),
    },
  )
  .post('/:id/archive', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const session = await archiveSessionCoordinated(id);
    return { ok: true, data: session };
  })
  .post('/:id/restore', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const session = await restoreSessionCoordinated(id);
    return { ok: true, data: session };
  })
  .post(
    '/:id/fork',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const creationLease = tryAcquireSessionCreationLease();
      if (!creationLease) {
        throw new ConflictError(
          'Session creation is temporarily blocked while delete-all is finishing.',
        );
      }
      let result;
      try {
        result = forkSessionAtMessage({ sourceSessionId: id, messageId: body.messageId });
      } finally {
        creationLease.release();
      }
      const { session } = result;
      try {
        writeAllCliRulesAndSkills(session.id, '');
      } catch (err: unknown) {
        // Expected failure: CLI rules are supplementary, not request-critical.
        serverLog.warn({ err, sessionId: session.id }, 'Failed to write CLI rules + skills');
      }
      if (session.agentOverrides) setSessionAgentOverrides(session.id, session.agentOverrides);
      getContext().wsManager.broadcastEphemeral({
        type: 'session.updated',
        sessionId: session.id,
        timestamp: Date.now(),
        payload: { session },
      });
      return { ok: true, data: session, copiedMessageCount: result.copiedMessageCount };
    },
    {
      body: t.Object({
        messageId: t.String({ minLength: 1, maxLength: 256 }),
      }),
    },
  )
  .delete('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const result = await eraseSessionsCoordinated({ kind: 'selected', sessionId: id });
    clearSessionAgentOverrides(id);
    return { ok: true, operationId: result.operationId };
  })
  .get('/:id/processes', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const processes = await processSupervisor.getProcessesBySession(id);
    return {
      ok: true,
      processes: await Promise.all(processes.map((process) => serializeProcess(process))),
    };
  })
  .post(
    '/:id/cancel',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const steering = body?.purpose === 'steer';
      // A steer is an intentional cancel-and-continuation handoff: no visible
      // "Session cancelled" banner between the partial response and the
      // replacement instruction. Shared with the agent interrupt_chat tool.
      await stopChatRun(id, { steering });
      return { ok: true, message: steering ? 'Session ready for steering' : 'Session cancelled' };
    },
    {
      body: t.Optional(
        t.Object({
          purpose: t.Optional(t.Literal('steer')),
        }),
      ),
    },
  )
  .post(
    '/:id/compact',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      await requireActiveSession(id);
      const result = await getContext().kory.compactSession({
        sessionId: id,
        selectedModel: body.model,
        reasoningLevel: body.reasoningLevel,
        automatic: body.automatic,
      });
      return { ok: true, data: result };
    },
    {
      body: t.Object({
        model: t.String(),
        reasoningLevel: t.Optional(t.String()),
        automatic: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id/context', async ({ request, params: { id }, query }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions, messages } = getContext();
    // A chat is opened one page of messages at a time, so only the archived
    // tool evidence belonging to that window is worth sending. Without this
    // bound a reopened long chat carried the whole session's tool history
    // (hundreds of rows at up to 4 KB each) to render a single page.
    const sinceRaw = Number((query as { since?: string } | undefined)?.since);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    const session = await sessions.get(id);
    if (!session) throw new NotFoundError('Session', id);
    const sourceRoot = session.gitWorkspace?.repositoryPath ?? session.workingDirectory;
    const mcpServers = sourceRoot ? listToolServerIdentities(sessionSettingsRoot(sourceRoot)) : [];
    // CLI-harness providers inject the kory MCP bridge (kory__* tools) into
    // their turns — it is not project configuration, so surface its identity
    // here too. The session's provider comes from its most recent assistant
    // message; this makes the injected tool surface visible in the feed
    // (server identity, icons, labels) for every kory__ call the turn makes.
    const recent = await messages.getRecent(id, 10);
    const turnProvider = [...recent].reverse().find((m) => m.provider)?.provider;
    const koryIdentity = turnProvider ? koryMcpServerIdentity(turnProvider) : null;
    if (koryIdentity && !mcpServers.some((server) => server.name === koryIdentity.name)) {
      mcpServers.push(koryIdentity);
    }
    // Archived tool activity for this session — used to restore tool entries
    // in the feed after a reload (they're not part of the message history).
    const { getContextArchive, usageSnapshotMatchesBoundary } =
      await import('../../kory/context-archive');
    const archive = getContextArchive();
    // Return an explicit null snapshot so a client refreshing after a branch
    // switch can clear usage measured against the previous active response.
    if (!archive) return { ok: true, lastUsage: null, data: [], mcpServers };
    const [entries, lastUsage, boundary] = await Promise.all([
      archive.listRecent(id, 500),
      archive.getLastUsage(id),
      messages.getActiveBoundary(id),
    ]);
    return {
      ok: true,
      lastUsage: usageSnapshotMatchesBoundary(lastUsage, boundary) ? lastUsage : null,
      mcpServers,
      data: entries.filter((e) => since === undefined || e.ts >= since).map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        label: e.label,
        toolInput: e.toolInput,
        content: e.content.slice(0, 4000),
        originalByteCount: e.originalByteCount,
        contentSha256: e.contentSha256,
        truncated: e.truncated,
        redacted: e.redacted,
        isError: e.isError,
        ...(e.runRef ? { runRef: e.runRef } : {}),
        prunedForAgent: e.prunedForAgent === true,
      })),
    };
  })
  .post(
    '/:id/context/model-preview',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Model switched in the composer: re-baseline the context bar from the
      // backend's trusted window data (never a frontend guess).
      const { kory, sessions } = getContext();
      if (!(await sessions.get(id))) throw new NotFoundError('Session', id);
      // previewModelContext types provider as `never` to force literal callers;
      // the runtime value is a valid provider string from the client request.
      // This is a read-only response. It deliberately does not acquire the
      // session mutation barrier, emit websocket usage, or persist anything,
      // so the picker can refresh during a turn without racing run state.
      const usage = await kory.previewModelContext(
        id,
        body.model,
        body.provider as never,
        body.contextWindow,
      );
      return { ok: true, usage };
    },
    {
      body: t.Object({
        model: t.String(),
        provider: t.String(),
        contextWindow: t.Optional(t.Number()),
      }),
    },
  )
  .post(
    '/:id/context/:archiveId/visibility',
    async ({ request, params: { id, archiveId }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // User-driven "hide from agent": stubs this entry out of the model's
      // context on the next turn. Its bounded, redacted preview stays archived.
      const { kory } = getContext();
      const lease = kory.tryAcquireSessionMutationBarrier(id);
      if (!lease) {
        throw new ConflictError('Wait for active session work or deletion to finish.');
      }
      const { getContextArchive } = await import('../../kory/context-archive');
      const archive = getContextArchive();
      try {
        await requireActiveSession(id);
        if (!archive) return { ok: false, error: 'Context archive unavailable' };
        // Body has no t.Object schema so it is untyped — cast to the expected shape.
        const hidden =
          (body as { hiddenFromAgent?: boolean } | undefined)?.hiddenFromAgent === true;
        const changed = await archive.setPrunedForAgent(id, archiveId, hidden);
        if (!changed) throw new NotFoundError('Archive entry', archiveId);
        return { ok: true };
      } finally {
        lease.release();
      }
    },
  )
  .post(
    '/:id/rewind/preview',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const busy = () => ({
        ok: false,
        data: {
          canTravel: false,
          currentHash: '',
          targetHash: body.hash,
          description: '',
          evidence: { timestamp: 0 },
          diff: '',
          filesChanged: [],
          conversationEffect: 'code-only' as const,
          message: 'Stop or wait for active agent work before rewinding this session.',
        },
        message: 'Stop or wait for active agent work before rewinding this session.',
      });
      return withSessionRecoveryGuard({
        tryAcquireManager: () => getContext().kory.tryAcquireSessionMutationBarrier(id),
        tryAcquireProcess: () => processSupervisor.tryAcquireAgentToolBarrier(id),
        onBusy: busy,
        run: async () => {
          const preview = await (await timeTravelForSession(id)).previewTravel(body.hash, id);
          return { ok: preview.canTravel, data: preview, message: preview.message };
        },
      });
    },
    { body: t.Object({ hash: t.String() }) },
  )
  .post(
    '/:id/rewind',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const busy = () => ({
        ok: false,
        message: 'Stop or wait for active agent work before rewinding this session.',
      });
      return withSessionRecoveryGuard({
        tryAcquireManager: () => getContext().kory.tryAcquireSessionMutationBarrier(id),
        tryAcquireProcess: () => processSupervisor.tryAcquireAgentToolBarrier(id),
        onBusy: busy,
        run: async () => {
          const result = await (
            await timeTravelForSession(id)
          ).travelTo(body.hash, id, body.expectedCurrentHash);
          const eventEpoch =
            result.success && result.conversationEffect === 'rewind'
              ? getContext().wsManager.rewriteSessionTimeline(id).epoch
              : undefined;
          return {
            ok: result.success,
            message: result.message,
            ...(eventEpoch !== undefined ? { eventEpoch } : {}),
          };
        },
      });
    },
    {
      body: t.Object({
        hash: t.String(),
        confirmed: t.Literal(true),
        expectedCurrentHash: t.String(),
      }),
    },
  )
  .get('/:id/timetravel', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    try {
      const state = await (await timeTravelForSession(id)).getState(id);
      return { ok: true, data: state };
    } catch (err: unknown) {
      // Preserve the session while truthfully surfacing missing/corrupt shadow
      // storage or an unreconciled journal. This remains an HTTP-successful
      // route response so panel loading does not create a console-level 500.
      serverLog.warn({ err, sessionId: id }, 'Failed to load time travel timeline');
      return timeTravelDegradedResponse(err);
    }
  });
