import { Elysia, t } from 'elysia';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { getContext } from '../../context';
import {
  loadAgentSettings,
  saveAgentSettings,
  mergeAgentSettings,
  resetAgentSettings,
  initializePreferences,
  readPreferences,
  writePreferences,
  assembleAgentContext,
  criticReview,
  getAgentSettingsStats,
  enforceRules,
  DEFAULT_AGENT_SETTINGS,
} from '../../agent-settings';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import {
  activateSkill,
  applyDefaultUpdate,
  compareSkillRevisions,
  listSkills,
  resolveSkills,
  saveSkillDraft,
  testSkill,
  validateSkillContent,
  enforceSkillLearningPolicy,
  type SkillSource,
} from '../../kory/skills';
import { createTaskContract } from '../../kory/prompts';
import {
  listHarnessQualifications,
  saveHarnessQualification,
} from '../../kory/skill-qualifications';
import {
  buildSkillEvaluationCard,
  listSkillEvaluationRuns,
  recordSkillEvaluationRun,
} from '../../kory/skill-evaluations';

export const agentSettingsRoutes = new Elysia({ prefix: '/api/agent' })
  .get(
    '/skills/evaluations',
    ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      return {
        ok: true,
        data: listSkillEvaluationRuns(getRequestProjectRoot(request), query.skill),
      };
    },
    { query: t.Object({ skill: t.Optional(t.String()) }) },
  )
  .post(
    '/skills/evaluations',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        const run = recordSkillEvaluationRun(root, body);
        const related = listSkillEvaluationRuns(root, run.skill).filter(
          (item) =>
            item.provider === run.provider &&
            item.model === run.model &&
            item.harnessVersion === run.harnessVersion &&
            item.role === run.role &&
            item.medium === run.medium,
        );
        saveHarnessQualification(root, {
          provider: run.provider,
          model: run.model,
          harnessVersion: run.harnessVersion,
          skill: run.skill,
          role: run.role,
          medium: run.medium,
          sampleSize: related.length,
          successes: related.filter((item) => item.passed && !item.integrityFailure).length,
          quality: related.reduce((sum, item) => sum + item.quality, 0) / related.length,
          verification: related.reduce((sum, item) => sum + item.verification, 0) / related.length,
          updatedAt: run.recordedAt,
          evidence: related.flatMap((item) => item.evidence).slice(-10),
        });
        return { ok: true, data: run };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Invalid evaluation run' };
      }
    },
    {
      body: t.Object({
        id: t.String(),
        skill: t.String(),
        revisionHash: t.String(),
        caseId: t.String(),
        provider: t.String(),
        model: t.String(),
        harnessVersion: t.String(),
        role: t.Union([t.Literal('worker'), t.Literal('critic')]),
        medium: t.Optional(t.String()),
        evaluator: t.Union([
          t.Literal('deterministic'),
          t.Literal('human-blind-review'),
          t.Literal('human-review'),
        ]),
        passed: t.Boolean(),
        quality: t.Number({ minimum: 0, maximum: 1 }),
        verification: t.Number({ minimum: 0, maximum: 1 }),
        integrityFailure: t.Boolean(),
        evidence: t.Array(t.String()),
        notes: t.Optional(t.String()),
        recordedAt: t.String(),
      }),
    },
  )
  .get(
    '/skills/:name/evaluation-card',
    ({ request, params: { name }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const skill = listSkills(getRequestProjectRoot(request)).find(
        (item) => item.name === name && item.source === query.source && item.state === query.state,
      );
      if (!skill) {
        set.status = 404;
        return { ok: false, error: 'Skill revision not found' };
      }
      return {
        ok: true,
        data: buildSkillEvaluationCard(getRequestProjectRoot(request), skill, query.baselineHash),
      };
    },
    {
      query: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        state: t.Union([t.Literal('active'), t.Literal('draft')]),
        baselineHash: t.Optional(t.String()),
      }),
    },
  )
  .get('/skills/qualifications', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: listHarnessQualifications(getRequestProjectRoot(request)) };
  })
  .post(
    '/skills/qualifications',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        return { ok: true, data: saveHarnessQualification(getRequestProjectRoot(request), body) };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Invalid qualification record' };
      }
    },
    {
      body: t.Object({
        provider: t.String(),
        model: t.String(),
        harnessVersion: t.String(),
        skill: t.String(),
        role: t.Union([t.Literal('worker'), t.Literal('critic')]),
        medium: t.Optional(t.String()),
        sampleSize: t.Integer({ minimum: 0 }),
        successes: t.Integer({ minimum: 0 }),
        quality: t.Number({ minimum: 0, maximum: 1 }),
        verification: t.Number({ minimum: 0, maximum: 1 }),
        updatedAt: t.String(),
        evidence: t.Array(t.String()),
      }),
    },
  )
  .get('/skills', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: listSkills(getRequestProjectRoot(request)) };
  })
  .post(
    '/skills/validate',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      return { ok: true, data: validateSkillContent(body.content) };
    },
    { body: t.Object({ content: t.String() }) },
  )
  .put(
    '/skills/:name/draft',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        enforceSkillLearningPolicy(
          loadAgentSettings(root).skillLearningMode,
          body.actor ?? 'human',
          'save-draft',
        );
        return {
          ok: true,
          data: saveSkillDraft(
            root,
            body.source as SkillSource,
            name,
            body.content,
          ),
        };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Failed to save draft' };
      }
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        content: t.String(),
        actor: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
      }),
    },
  )
  .post(
    '/skills/:name/test',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const skill = listSkills(getRequestProjectRoot(request)).find(
        (item) =>
          item.name === name &&
          item.source === body.source &&
          item.state === (body.state ?? 'draft'),
      );
      if (!skill) {
        set.status = 404;
        return { ok: false, error: 'Skill revision not found' };
      }
      return { ok: true, data: testSkill(skill) };
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        state: t.Optional(t.Union([t.Literal('active'), t.Literal('draft')])),
      }),
    },
  )
  .post(
    '/skills/:name/activate',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        const draft = listSkills(root).find(
          (item) => item.name === name && item.source === body.source && item.state === 'draft',
        );
        const promotionReady = draft
          ? buildSkillEvaluationCard(root, draft).gate.status === 'ready'
          : false;
        enforceSkillLearningPolicy(
          loadAgentSettings(root).skillLearningMode,
          body.actor ?? 'human',
          'activate',
          promotionReady,
        );
        return {
          ok: true,
          data: activateSkill(root, body.source as SkillSource, name),
        };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Failed to activate skill' };
      }
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        actor: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
      }),
    },
  )
  .post(
    '/skills/:name/update-default',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        return {
          ok: true,
          data: applyDefaultUpdate(getRequestProjectRoot(request), name, body.choice),
        };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Failed to update default' };
      }
    },
    {
      body: t.Object({
        choice: t.Union([t.Literal('replace'), t.Literal('merge'), t.Literal('keep-local')]),
      }),
    },
  )
  .post(
    '/skills/resolve',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const contract = createTaskContract(body.prompt);
      return {
        ok: true,
        data: resolveSkills(
          getRequestProjectRoot(request),
          body.prompt,
          contract,
          body.options ?? {},
        ),
      };
    },
    {
      body: t.Object({
        prompt: t.String(),
        options: t.Optional(
          t.Object({
            pins: t.Optional(t.Array(t.String())),
            remove: t.Optional(t.Array(t.String())),
            collisionChoices: t.Optional(
              t.Record(t.String(), t.Union([t.Literal('personal'), t.Literal('project')])),
            ),
            targetMedium: t.Optional(t.String()),
            contextBudget: t.Optional(t.Number({ minimum: 1 })),
          }),
        ),
      }),
    },
  )
  .get(
    '/skills/:name/compare',
    ({ request, params: { name }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const revisions = listSkills(getRequestProjectRoot(request)).filter(
        (item) => item.name === name && item.source === query.source,
      );
      const active = revisions.find((item) => item.state === 'active');
      const draft = revisions.find((item) => item.state === 'draft');
      if (!active || !draft) {
        set.status = 404;
        return { ok: false, error: 'Active and draft revisions are required' };
      }
      return { ok: true, data: compareSkillRevisions(active, draft) };
    },
    { query: t.Object({ source: t.Union([t.Literal('personal'), t.Literal('project')]) }) },
  )
  .get('/threads/:sessionId', async ({ request, params: { sessionId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { sessions, kory } = getContext();
    const session = await sessions.get(sessionId);
    if (!session) {
      set.status = 404;
      return { ok: false, error: 'Session not found' };
    }
    return { ok: true, data: kory.getAgentThreadsForSession(sessionId) };
  })
  .get(
    '/:agentId/thread',
    async ({ request, params: { agentId }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const sessionId = String(query.sessionId ?? '');
      if (!sessionId) {
        set.status = 400;
        return { ok: false, error: 'sessionId is required' };
      }
      const { sessions, kory } = getContext();
      const session = await sessions.get(sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      return { ok: true, data: kory.getAgentThreadEntries(sessionId, agentId) };
    },
    {
      query: t.Object({
        sessionId: t.String(),
      }),
    },
  )
  .post(
    '/:agentId/message',
    async ({ request, params: { agentId }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { sessions, kory } = getContext();
      const session = await sessions.get(body.sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      try {
        await kory.sendMessageToAgent(body.sessionId, agentId, body.content, {
          model: body.model,
          reasoningLevel: body.reasoningLevel,
        });
        return { ok: true, data: { status: 'processing' } };
      } catch (err: any) {
        const message = err?.message ?? 'Failed to message agent';
        set.status = message.includes('already working') ? 409 : 400;
        return { ok: false, error: message };
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        content: t.String(),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
      }),
    },
  )
  .post('/:agentId/cancel', async ({ request, params: { agentId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    kory.cancelWorker(agentId);
    return { ok: true, message: 'Agent cancelled' };
  })
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = loadAgentSettings(getRequestProjectRoot(request));
    return {
      ok: true,
      data: settings,
      message: 'Rules are always enforced. Critic enforces based on enforcement level.',
    };
  })
  .put('/settings', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const root = getRequestProjectRoot(request);
      const currentSettings = loadAgentSettings(root);
      const newSettings = mergeAgentSettings(currentSettings, body);
      saveAgentSettings(root, newSettings);
      return {
        ok: true,
        data: newSettings,
        message: 'Agent settings updated. Rules remain enforced.',
      };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message ?? 'Failed to save agent settings' };
    }
  })
  .post('/settings/reset', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = resetAgentSettings(getRequestProjectRoot(request));
    return {
      ok: true,
      data: settings,
      message: 'Agent settings reset to defaults. Rules still enforced.',
    };
  })
  .get('/preferences', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const prefs = readPreferences(getRequestProjectRoot(request));
    return { ok: true, data: prefs };
  })
  .put(
    '/preferences',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        writePreferences(getRequestProjectRoot(request), body.content);
        return { ok: true, message: 'Preferences updated. Critic will enforce new rules.' };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to save preferences' };
      }
    },
    {
      body: t.Object({
        content: t.String(),
      }),
    },
  )
  .post('/preferences/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const prefs = initializePreferences(getRequestProjectRoot(request));
    return {
      ok: true,
      data: prefs,
      message: 'Preferences initialized with comprehensive template.',
    };
  })
  .get('/context', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = getRequestProjectRoot(request);
    const settings = loadAgentSettings(root);
    const context = assembleAgentContext(root, settings);
    return { ok: true, data: context };
  })
  .post(
    '/enforce',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        const settings = loadAgentSettings(root);
        const preferences = readPreferences(root).content;
        const result = enforceRules(
          body.code,
          body.filePath,
          preferences,
          settings.ruleEnforcementLevel,
        );
        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to enforce rules' };
      }
    },
    {
      body: t.Object({
        code: t.String(),
        filePath: t.String(),
      }),
    },
  )
  .post(
    '/critic-review',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        const settings = loadAgentSettings(root);
        const preferences = readPreferences(root).content;
        let rules = '';
        try {
          rules = readFileSync(join(root, '.koryphaios/rules/rules.md'), 'utf-8');
        } catch {}

        const result = criticReview({
          code: body.code,
          filePath: body.filePath,
          changeDescription: body.changeDescription || 'Code change',
          settings,
          preferences,
          rules,
        });

        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Critic review failed' };
      }
    },
    {
      body: t.Object({
        code: t.String(),
        filePath: t.String(),
        changeDescription: t.Optional(t.String()),
      }),
    },
  )
  .get('/stats', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const stats = getAgentSettingsStats(getRequestProjectRoot(request));
    return { ok: true, data: stats };
  })
  .get('/defaults', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return {
      ok: true,
      data: DEFAULT_AGENT_SETTINGS,
      message: 'Default agent settings. Rules always enforced.',
    };
  });
