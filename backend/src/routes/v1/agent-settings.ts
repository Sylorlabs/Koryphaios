import { Elysia, t } from 'elysia';
import { admitComputerPolicy, computerAuthorityRevision } from '../../computer-use/authority';
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
  compareBundledSkill,
  convertSkillRevision,
  countBundledUpdates,
  createFreeformSkillDraft,
  createSkillDraft,
  listSkills,
  resolveSkills,
  saveSkillDraft,
  saveSkillDocumentDraft,
  testSkill,
  validateSkillContent,
  validateSkillDocument,
  enforceSkillLearningPolicy,
  getBundledSkillContent,
  saveAgentMergedSkillDraft,
  SkillDraftConflictError,
  SkillRevisionConflictError,
  type SkillDocumentSpec,
  type SkillSource,
  readPersonalSkillInstructions,
  resetPersonalSkillInstructions,
  writePersonalSkillInstructions,
} from '../../kory/skills';
import { collectProviderEvents } from '../../providers/provider-retry';
import { RESPONSE_STYLE_SKILL_NAME } from '../../kory/response-style-skill';
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
import { buildSkillHealthSnapshot } from '../../kory/skill-health';
import { syncSkillStewardRegistry } from '../../kory/skill-stewards';
import {
  analyzeSkillGaps,
  buildSkillFactoryCandidate,
  createSkillFactoryDraft,
  dismissSkillFactoryGap,
  reconcileSkillFactoryGaps,
  reopenSkillFactoryGap,
} from '../../kory/skill-factory';
import {
  advanceWorkflow,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowDrafts,
  activateWorkflowDraft,
  startWorkflow,
  stopWorkflow,
} from '../../kory/workflows';
import { serverLog } from '../../logger';
import { hasIndependentGoalEvidence } from '../../stores/goal-store';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  SessionNotFoundError,
} from '../../errors/types';

export const agentSettingsRoutes = new Elysia({ prefix: '/api/agent' })
  .get(
    '/workflows',
    ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      return {
        ok: true,
        data: {
          definitions: listWorkflowDefinitions(root),
          drafts: listWorkflowDrafts(root),
          runs: listWorkflowRuns(root, query.sessionId),
        },
      };
    },
    { query: t.Object({ sessionId: t.Optional(t.String()) }) },
  )
  .post(
    '/workflows/start',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      return {
        ok: true,
        data: startWorkflow(getRequestProjectRoot(request), { ...body, requestedBy: 'human' }),
      };
    },
    {
      body: t.Object({
        workflowId: t.Optional(t.String()),
        sessionId: t.String(),
        task: t.String({ minLength: 1 }),
        goalId: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/workflows/:id/advance',
    ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      return { ok: true, data: advanceWorkflow(getRequestProjectRoot(request), params.id, body) };
    },
    { body: t.Object({ evidence: t.String(), block: t.Optional(t.Boolean()) }) },
  )
  .post('/workflows/:id/stop', ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: stopWorkflow(getRequestProjectRoot(request), params.id) };
  })
  .post(
    '/workflows/drafts/:id/activate',
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      const draft = listWorkflowDrafts(root).find((item) => item.id === params.id);
      if (!draft) throw new NotFoundError('Workflow draft', params.id);
      const goal = await getContext().goals.get(draft.goalId);
      const sourceItem = goal?.checklist.find((item) => item.id === draft.goalItemId);
      if (!sourceItem || !hasIndependentGoalEvidence(sourceItem))
        throw new ValidationError(
          'Finish and verify the source Goal item before activating this workflow',
        );
      const activated = activateWorkflowDraft(root, params.id, body.scope);
      await getContext().goals.addActivity(
        draft.goalId,
        'workflow_activated',
        `${draft.id}|${body.scope}|${draft.name}`,
      );
      return { ok: true, data: activated };
    },
    { body: t.Object({ scope: t.Union([t.Literal('project'), t.Literal('personal')]) }) },
  )
  .post(
    '/delegate',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { sessions, kory } = getContext();
      if (!(await sessions.getActive(body.sessionId))) {
        throw new SessionNotFoundError(body.sessionId);
      }
      // This is the deterministic control-plane path for an explicit human
      // delegation. It does not depend on a provider translating a prose
      // request into a tool call, and it still uses the normal independent
      // worker routing, worktree, and critic gates.
      const result = await kory.runWorkerPipeline(
        body.sessionId,
        body.task,
        body.managerModel,
        body.reasoningLevel,
        body.domain,
      );
      return { ok: true, data: { result } };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        task: t.String({ minLength: 1 }),
        managerModel: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
        domain: t.Optional(
          t.Union([
            t.Literal('general'),
            t.Literal('ui'),
            t.Literal('backend'),
            t.Literal('test'),
            t.Literal('review'),
          ]),
        ),
      }),
    },
  )
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
  .get('/skills/health', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = getRequestProjectRoot(request);
    syncSkillStewardRegistry(root);
    return { ok: true, data: buildSkillHealthSnapshot(root) };
  })
  .get('/skills/stewards', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: syncSkillStewardRegistry(getRequestProjectRoot(request)) };
  })
  .get('/skills/factory/gaps', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: reconcileSkillFactoryGaps(getRequestProjectRoot(request)) };
  })
  .post(
    '/skills/factory/analyze',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        return {
          ok: true,
          data: analyzeSkillGaps(getRequestProjectRoot(request), body.signals, {
            coverageThreshold: body.coverageThreshold,
          }),
        };
      } catch (error: unknown) {
        throw new ValidationError(error instanceof Error ? error.message : String(error));
      }
    },
    {
      body: t.Object({
        coverageThreshold: t.Optional(t.Number({ minimum: 0.5, maximum: 1 })),
        signals: t.Array(
          t.Object({
            id: t.String({ minLength: 1, maxLength: 200 }),
            capability: t.String({ minLength: 1, maxLength: 240 }),
            proposedSkillName: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
            requestExamples: t.Optional(
              t.Array(t.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
            ),
            domains: t.Optional(
              t.Array(t.String({ minLength: 1, maxLength: 80 }), { maxItems: 12 }),
            ),
            targetMedia: t.Optional(
              t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 8 }),
            ),
            source: t.Union([
              t.Literal('session'),
              t.Literal('benchmark'),
              t.Literal('failure'),
              t.Literal('manual'),
              t.Literal('import'),
            ]),
            observedAt: t.String(),
            weight: t.Optional(t.Number({ exclusiveMinimum: 0, maximum: 100 })),
            evidence: t.Optional(
              t.Array(t.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 20 }),
            ),
          }),
          { minItems: 1, maxItems: 100 },
        ),
      }),
    },
  )
  .get('/skills/factory/:id/candidate', ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      return {
        ok: true,
        data: buildSkillFactoryCandidate(getRequestProjectRoot(request), params.id),
      };
    } catch (error: unknown) {
      throw new NotFoundError('Skill Factory candidate', params.id);
    }
  })
  .post(
    '/skills/factory/:id/draft',
    ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      try {
        return {
          ok: true,
          data: createSkillFactoryDraft(root, {
            gapId: params.id,
            learningMode: loadAgentSettings(root).skillLearningMode,
            source: body.source,
            stewardModel: body.stewardModel,
            draft: body.draft,
          }),
        };
      } catch (error: unknown) {
        throw new ValidationError(error instanceof Error ? error.message : String(error));
      }
    },
    {
      body: t.Object({
        source: t.Optional(t.Union([t.Literal('personal'), t.Literal('project')])),
        stewardModel: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        draft: t.Object({
          description: t.String({ minLength: 40, maxLength: 360 }),
          instructions: t.String({ minLength: 40, maxLength: 50_000 }),
          domains: t.Array(t.String({ minLength: 1, maxLength: 80 }), {
            minItems: 1,
            maxItems: 12,
          }),
          activation: t.Array(t.String({ minLength: 1, maxLength: 120 }), {
            minItems: 1,
            maxItems: 16,
          }),
          shouldTrigger: t.Array(t.String({ minLength: 1, maxLength: 240 }), {
            minItems: 2,
            maxItems: 12,
          }),
          shouldNotTrigger: t.Array(t.String({ minLength: 1, maxLength: 240 }), {
            minItems: 2,
            maxItems: 12,
          }),
          evidence: t.Array(t.String({ minLength: 1, maxLength: 240 }), {
            minItems: 1,
            maxItems: 12,
          }),
          broader: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 8 })),
          facets: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 })),
          requires: t.Optional(
            t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 }),
          ),
          conflicts: t.Optional(
            t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 }),
          ),
          excludes: t.Optional(
            t.Array(t.String({ minLength: 1, maxLength: 120 }), { maxItems: 16 }),
          ),
          targetMedia: t.Optional(
            t.Array(t.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 8 }),
          ),
          depth: t.Optional(t.Integer({ minimum: 0, maximum: 32 })),
          contextBudget: t.Optional(t.Integer({ minimum: 100, maximum: 20_000 })),
        }),
      }),
    },
  )
  .post(
    '/skills/factory/:id/dismiss',
    ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        return {
          ok: true,
          data: dismissSkillFactoryGap(getRequestProjectRoot(request), params.id, body.reason),
        };
      } catch (error: unknown) {
        throw new ValidationError(error instanceof Error ? error.message : String(error));
      }
    },
    { body: t.Object({ reason: t.String({ minLength: 1, maxLength: 1_000 }) }) },
  )
  .post('/skills/factory/:id/reopen', ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      return {
        ok: true,
        data: reopenSkillFactoryGap(getRequestProjectRoot(request), params.id),
      };
    } catch (error: unknown) {
      throw new ValidationError(error instanceof Error ? error.message : String(error));
    }
  })
  .post(
    '/skills/evaluations',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      const run = recordSkillEvaluationRun(root, body);
      const related = listSkillEvaluationRuns(root, run.skill).filter(
        (item) =>
          item.variant !== 'without-skill' &&
          item.provider === run.provider &&
          item.model === run.model &&
          item.harnessVersion === run.harnessVersion &&
          item.role === run.role &&
          item.medium === run.medium,
      );
      if (related.length) {
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
      }
      return { ok: true, data: run };
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
          t.Literal('blind-review'),
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
        protocolVersion: t.Optional(t.Union([t.Literal(2), t.Literal(3)])),
        variant: t.Optional(t.Union([t.Literal('with-skill'), t.Literal('without-skill')])),
        caseCategory: t.Optional(
          t.Union([
            t.Literal('positive'),
            t.Literal('negative'),
            t.Literal('ambiguous'),
            t.Literal('adversarial'),
            t.Literal('full-task'),
            t.Literal('regression'),
          ]),
        ),
        comparisonId: t.Optional(t.String()),
        routing: t.Optional(
          t.Object({
            expectedSelection: t.Boolean(),
            selected: t.Boolean(),
            selectionScope: t.Optional(t.Union([t.Literal('direct'), t.Literal('bundle')])),
            selectedSkills: t.Optional(t.Array(t.String())),
            expectedSkills: t.Optional(t.Array(t.String())),
            forbiddenSkills: t.Optional(t.Array(t.String())),
          }),
        ),
        evaluatorProvenance: t.Optional(
          t.Object({
            evaluatorId: t.String(),
            kind: t.Union([t.Literal('human'), t.Literal('model')]),
            provider: t.Optional(t.String()),
            model: t.Optional(t.String()),
            assignmentId: t.Optional(t.String()),
            blindTo: t.Array(
              t.Union([
                t.Literal('skill-variant'),
                t.Literal('revision'),
                t.Literal('expected-selection'),
                t.Literal('expected-outcome'),
              ]),
            ),
            evidence: t.Array(t.String()),
          }),
        ),
        regressionId: t.Optional(t.String()),
        suiteId: t.Optional(t.String()),
        scenarioId: t.Optional(t.String()),
        experimentId: t.Optional(t.String()),
        infrastructureFailure: t.Optional(
          t.Object({
            kind: t.Union([
              t.Literal('setup'),
              t.Literal('provider'),
              t.Literal('tool'),
              t.Literal('timeout'),
              t.Literal('environment-drift'),
              t.Literal('artifact-capture'),
            ]),
            retryable: t.Boolean(),
            evidence: t.Array(t.String()),
            detail: t.String(),
          }),
        ),
        artifacts: t.Optional(
          t.Array(
            t.Object({
              kind: t.Union([
                t.Literal('log'),
                t.Literal('state'),
                t.Literal('screenshot'),
                t.Literal('trace'),
                t.Literal('report'),
                t.Literal('other'),
              ]),
              location: t.String(),
              sha256: t.Optional(t.String()),
            }),
          ),
        ),
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
        throw new NotFoundError('Skill revision', name);
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
      return { ok: true, data: saveHarnessQualification(getRequestProjectRoot(request), body) };
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
    '/skills',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      enforceSkillLearningPolicy(
        loadAgentSettings(root).skillLearningMode,
        body.actor ?? 'human',
        'save-draft',
      );
      try {
        return { ok: true, data: createSkillDraft(root, body) };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SkillDraftConflictError) throw new ConflictError(message);
        throw new ValidationError(message);
      }
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        name: t.String({ minLength: 1, maxLength: 64 }),
        description: t.String({ minLength: 40, maxLength: 360 }),
        instructions: t.String({ minLength: 40, maxLength: 50_000 }),
        domains: t.Array(t.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 12 }),
        activation: t.Array(t.String({ minLength: 1, maxLength: 120 }), {
          minItems: 1,
          maxItems: 16,
        }),
        shouldTrigger: t.Array(t.String({ minLength: 1, maxLength: 240 }), {
          minItems: 2,
          maxItems: 12,
        }),
        shouldNotTrigger: t.Array(t.String({ minLength: 1, maxLength: 240 }), {
          minItems: 2,
          maxItems: 12,
        }),
        evidence: t.Array(t.String({ minLength: 1, maxLength: 240 }), {
          minItems: 1,
          maxItems: 12,
        }),
        broader: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 8 })),
        facets: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 })),
        requires: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 })),
        conflicts: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 })),
        excludes: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 120 }), { maxItems: 16 })),
        targetMedia: t.Optional(
          t.Array(t.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 8 }),
        ),
        depth: t.Optional(t.Integer({ minimum: 0, maximum: 32 })),
        contextBudget: t.Optional(t.Integer({ minimum: 100, maximum: 20_000 })),
        document: t.Optional(
          t.Object({
            kind: t.Union([
              t.Literal('markdown'),
              t.Literal('text'),
              t.Literal('html'),
              t.Literal('custom'),
            ]),
            extension: t.String({ minLength: 1, maxLength: 18 }),
            renderer: t.Union([t.Literal('markdown'), t.Literal('plain'), t.Literal('html')]),
            mediaType: t.String({ minLength: 3, maxLength: 100 }),
          }),
        ),
        sourceContent: t.Optional(t.String({ minLength: 1, maxLength: 50_000 })),
        coreInstructions: t.Optional(t.String({ minLength: 1, maxLength: 50_000 })),
        actor: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
      }),
    },
  )
  .post(
    '/skills/freeform',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      enforceSkillLearningPolicy(
        loadAgentSettings(root).skillLearningMode,
        body.actor ?? 'human',
        'save-draft',
      );
      try {
        return { ok: true, data: createFreeformSkillDraft(root, body) };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SkillDraftConflictError) throw new ConflictError(message);
        throw new ValidationError(message);
      }
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        name: t.String({ minLength: 1, maxLength: 64 }),
        description: t.String({ minLength: 12, maxLength: 1024 }),
        instructions: t.String({ minLength: 1, maxLength: 50_000 }),
        actor: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
      }),
    },
  )
  .post(
    '/skills/validate',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      if (body.document) {
        return {
          ok: true,
          data: validateSkillDocument({
            document: body.document,
            sourceContent: body.sourceContent ?? '',
            coreInstructions: body.coreInstructions ?? '',
          }),
        };
      }
      if (body.content !== undefined) {
        return { ok: true, data: validateSkillContent(body.content) };
      }
      throw new ValidationError('Provide legacy content or a native skill document');
    },
    {
      body: t.Object({
        content: t.Optional(t.String({ maxLength: 50_000 })),
        document: t.Optional(
          t.Object({
            kind: t.Union([
              t.Literal('markdown'),
              t.Literal('text'),
              t.Literal('html'),
              t.Literal('custom'),
            ]),
            extension: t.String({ minLength: 1, maxLength: 18 }),
            renderer: t.Union([t.Literal('markdown'), t.Literal('plain'), t.Literal('html')]),
            mediaType: t.String({ minLength: 3, maxLength: 100 }),
          }),
        ),
        sourceContent: t.Optional(t.String({ maxLength: 50_000 })),
        coreInstructions: t.Optional(t.String({ maxLength: 50_000 })),
      }),
    },
  )
  .put(
    '/skills/:name/draft',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      enforceSkillLearningPolicy(
        loadAgentSettings(root).skillLearningMode,
        body.actor ?? 'human',
        'save-draft',
      );
      try {
        return {
          ok: true,
          data: body.document
            ? saveSkillDocumentDraft(root, body.source as SkillSource, name, {
                document: body.document,
                sourceContent: body.sourceContent ?? body.content ?? '',
                coreInstructions: body.coreInstructions ?? '',
                expectedHash: body.expectedHash ?? '',
              })
            : saveSkillDraft(
                root,
                body.source as SkillSource,
                name,
                body.content ?? '',
                body.expectedHash,
              ),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SkillRevisionConflictError) throw new ConflictError(message);
        throw new ValidationError(message);
      }
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        content: t.Optional(t.String({ maxLength: 50_000 })),
        expectedHash: t.String({ minLength: 64, maxLength: 64 }),
        document: t.Optional(
          t.Object({
            kind: t.Union([
              t.Literal('markdown'),
              t.Literal('text'),
              t.Literal('html'),
              t.Literal('custom'),
            ]),
            extension: t.String({ minLength: 1, maxLength: 18 }),
            renderer: t.Union([t.Literal('markdown'), t.Literal('plain'), t.Literal('html')]),
            mediaType: t.String({ minLength: 3, maxLength: 100 }),
          }),
        ),
        sourceContent: t.Optional(t.String({ maxLength: 50_000 })),
        coreInstructions: t.Optional(t.String({ maxLength: 50_000 })),
        actor: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
      }),
    },
  )
  .post(
    '/skills/:name/convert',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      try {
        return {
          ok: true,
          data: convertSkillRevision(
            root,
            body.source as SkillSource,
            name,
            body.state,
            body.document,
            body.dryRun ?? true,
            body.expectedHash,
          ),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SkillRevisionConflictError) throw new ConflictError(message);
        throw new ValidationError(message);
      }
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        state: t.Union([t.Literal('active'), t.Literal('draft')]),
        dryRun: t.Optional(t.Boolean()),
        expectedHash: t.String({ minLength: 64, maxLength: 64 }),
        document: t.Object({
          kind: t.Union([
            t.Literal('markdown'),
            t.Literal('text'),
            t.Literal('html'),
            t.Literal('custom'),
          ]),
          extension: t.String({ minLength: 1, maxLength: 18 }),
          renderer: t.Union([t.Literal('markdown'), t.Literal('plain'), t.Literal('html')]),
          mediaType: t.String({ minLength: 3, maxLength: 100 }),
        }),
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
        throw new NotFoundError('Skill revision', name);
      }
      if (body.expectedHash && skill.hash !== body.expectedHash) {
        throw new ConflictError(
          `Skill ${name} changed outside this test; reload it before testing this revision`,
        );
      }
      return { ok: true, data: testSkill(skill) };
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        state: t.Optional(t.Union([t.Literal('active'), t.Literal('draft')])),
        expectedHash: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
      }),
    },
  )
  .post(
    '/skills/:name/activate',
    ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const root = getRequestProjectRoot(request);
      const draft = listSkills(root).find(
        (item) => item.name === name && item.source === body.source && item.state === 'draft',
      );
      if (body.expectedHash && (!draft || draft.hash !== body.expectedHash)) {
        throw new ConflictError(
          `Skill ${name} changed outside this activation; reload it before activating this revision`,
        );
      }
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
        data: activateSkill(root, body.source as SkillSource, name, body.expectedHash),
      };
    },
    {
      body: t.Object({
        source: t.Union([t.Literal('personal'), t.Literal('project')]),
        actor: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
        expectedHash: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
      }),
    },
  )
  .post(
    '/skills/:name/update-default',
    async ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const projectRoot = getRequestProjectRoot(request);
      const localAtStart = listSkills(projectRoot).find(
        (skill) => skill.name === name && skill.source === 'personal' && skill.state === 'active',
      );
      if (body.expectedHash && (!localAtStart || localAtStart.hash !== body.expectedHash)) {
        throw new ConflictError(
          `Skill ${name} changed outside this update; reload it before applying a bundled revision`,
        );
      }
      if (
        (body.choice === 'merge' || body.choice === 'merge-with-agent') &&
        listSkills(projectRoot).some(
          (skill) => skill.name === name && skill.source === 'personal' && skill.state === 'draft',
        )
      ) {
        throw new ConflictError(
          `Skill ${name} already has a draft; review or discard it before creating an update draft`,
        );
      }

      // For merge-with-agent, call the LLM to intelligently merge the user's
      // local edits with the new bundled version.
      if (body.choice === 'merge-with-agent') {
        const bundled = getBundledSkillContent(name);
        if (!bundled) {
          set.status = 404;
          return { ok: false, error: 'Bundled skill not found' };
        }
        const localRevision = localAtStart;
        if (!localRevision) {
          set.status = 404;
          return { ok: false, error: 'Local skill not found' };
        }
        const local = localRevision.sourceContent;

        const ctx = getContext();
        // Use the user's configured routing to pick the right model — this
        // respects their provider preferences, model allowlists, and fallbacks
        // instead of hardcoding specific model IDs.
        const routing = ctx.kory.resolveActiveRouting(undefined, 'general', true);
        const provider = ctx.providers.resolveProvider(routing.model, routing.provider);
        if (!provider) {
          set.status = 503;
          return { ok: false, error: 'No model provider available for agent merge' };
        }

        const mergePrompt = buildSkillMergePrompt(
          name,
          local,
          bundled,
          localRevision.storageVersion === 2 ? localRevision.document : undefined,
        );
        // Retried on a transient provider failure: without it a single upstream
        // blip is reported as "merge produced empty native content", which reads
        // like the user's own skill file broke.
        const merged = await collectProviderEvents(provider, {
          model: routing.model,
          systemPrompt:
            localRevision.storageVersion === 2
              ? `You merge instruction files while preserving the user's native .${localRevision.document.extension} format. Output only native source: no explanation, fences, or YAML frontmatter.`
              : "You are an expert at merging skill instruction files. Preserve the user's customizations while incorporating bundled improvements. Output only merged SKILL.md content: no explanation or markdown fences.",
          messages: [{ role: 'user', content: mergePrompt }],
        });
        if (merged.failed) {
          set.status = 502;
          return {
            ok: false,
            error: `The provider could not complete the merge: ${merged.error ?? 'unknown error'}`,
          };
        }

        let mergedContent = '';
        for (const event of merged.events) {
          if (event.type === 'content_delta' && event.content) {
            mergedContent += event.content;
          }
        }

        // Strip markdown fences if the model wrapped the output
        mergedContent = mergedContent
          .replace(/^```[a-z0-9_+.-]*\s*\r?\n?/i, '')
          .replace(/\n?```\s*$/m, '')
          .trim();

        if (localRevision.storageVersion === 1 && !mergedContent.startsWith('---')) {
          set.status = 500;
          return { ok: false, error: 'Agent merge produced invalid content (missing frontmatter)' };
        }
        if (!mergedContent) {
          set.status = 500;
          return { ok: false, error: 'Agent merge produced empty native content' };
        }

        const bundledBody =
          bundled.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1] ?? bundled;
        const mergedCore =
          localRevision.storageVersion === 2
            ? `${localRevision.coreInstructions.trim()}\n\n${bundledBody.replace(/^#\s+[^\n]+\n+/, '').trim()}`
            : undefined;
        try {
          const draft = saveAgentMergedSkillDraft(
            name,
            mergedContent,
            mergedCore,
            localRevision.hash,
          );
          return { ok: true, data: draft };
        } catch (error: unknown) {
          if (
            error instanceof SkillRevisionConflictError ||
            error instanceof SkillDraftConflictError
          ) {
            throw new ConflictError(error.message);
          }
          throw error;
        }
      }

      try {
        return {
          ok: true,
          data: applyDefaultUpdate(projectRoot, name, body.choice, body.expectedHash),
        };
      } catch (error: unknown) {
        if (
          error instanceof SkillRevisionConflictError ||
          error instanceof SkillDraftConflictError
        ) {
          throw new ConflictError(error.message);
        }
        throw error;
      }
    },
    {
      body: t.Object({
        choice: t.Union([
          t.Literal('replace'),
          t.Literal('merge'),
          t.Literal('keep-local'),
          t.Literal('merge-with-agent'),
        ]),
        expectedHash: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
      }),
    },
  )
  .get('/skills/:name/compare-bundled', ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const comparison = compareBundledSkill(name);
    if (!comparison) {
      set.status = 404;
      return { ok: false, error: 'No local skill or bundled version found' };
    }
    return { ok: true, data: comparison };
  })
  .get('/skills/bundled-updates/count', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: { count: countBundledUpdates() } };
  })
  .post(
    '/skills/resolve',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const contract = createTaskContract(body.prompt);
      const planningResolution = resolveSkills(
        getRequestProjectRoot(request),
        body.prompt,
        contract,
        body.options ?? {},
      );
      return {
        ok: true,
        data: {
          ...planningResolution,
          planningOnly: true,
          planningLimit:
            'Final manager selection is recomputed against authenticated model metadata, occupied context, provider framing, and the actual output limit at run time.',
        },
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
            targetMedium: t.Optional(
              t.Union([
                t.Literal('any'),
                t.Literal('web'),
                t.Literal('native'),
                t.Literal('mobile'),
                t.Literal('terminal'),
                t.Literal('game'),
                t.Literal('spatial'),
                t.Literal('embedded'),
              ]),
            ),
            contextBudget: t.Optional(t.Number({ minimum: 1 })),
            activePaths: t.Optional(t.Array(t.String())),
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
        throw new NotFoundError('Active and draft skill revisions', name);
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
      throw new SessionNotFoundError(sessionId);
    }
    return { ok: true, data: kory.getAgentThreadsForSession(sessionId) };
  })
  .get(
    '/:agentId/thread',
    async ({ request, params: { agentId }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const sessionId = String(query.sessionId ?? '');
      if (!sessionId) {
        throw new ValidationError('sessionId is required');
      }
      const { sessions, kory } = getContext();
      const session = await sessions.get(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
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
      const session = await sessions.getActive(body.sessionId);
      if (!session) {
        throw new SessionNotFoundError(body.sessionId);
      }
      try {
        const accepted = await kory.sendMessageToAgent(body.sessionId, agentId, body.content, {
          model: body.model,
          reasoningLevel: body.reasoningLevel,
        });
         return { ok: true, data: accepted };
      } catch (err: unknown) {
        if (err instanceof ConflictError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // "already working" is an operational conflict, not a bug.
        if (message.includes('already working')) throw new ConflictError(message);
        throw new ValidationError(message || 'Failed to message agent');
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
  .get('/:agentId/steering', async ({ request, params: { agentId }, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    return { ok: true, data: await kory.getAgentSteering(query.sessionId, agentId) };
  }, { query: t.Object({ sessionId: t.String() }) })
  .patch('/:agentId/steering/:commandId', async ({ request, params: { agentId, commandId }, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    return { ok: true, data: await kory.editAgentSteering(body.sessionId, agentId, commandId, body.content) };
  }, { body: t.Object({ sessionId: t.String(), content: t.String() }) })
  .delete('/:agentId/steering/:commandId', async ({ request, params: { agentId, commandId }, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    return { ok: true, data: await kory.deleteAgentSteering(query.sessionId, agentId, commandId) };
  }, { query: t.Object({ sessionId: t.String() }) })
  .post('/:agentId/steering/reorder', async ({ request, params: { agentId }, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    return { ok: true, data: await kory.reorderAgentSteering(body.sessionId, agentId, body.commandId, body.beforeId ?? null) };
  }, { body: t.Object({ sessionId: t.String(), commandId: t.String(), beforeId: t.Optional(t.Union([t.String(), t.Null()])) }) })
  .post(
    '/:agentId/controls',
    async ({ request, params: { agentId }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory } = getContext();
      try {
        const data = await kory.updateAgentControls(body.sessionId, agentId, {
          model: body.model,
          reasoningLevel: body.reasoningLevel,
        });
        return { ok: true, data };
      } catch (err: unknown) {
        if (err instanceof ConflictError) throw err;
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/:agentId/prune-context',
    ({ request, params: { agentId }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory } = getContext();
      try {
        const removed = kory.pruneAgentContext(body.sessionId, agentId, body.keepRecent);
        return { ok: true, data: { removed } };
      } catch (err: unknown) {
        if (err instanceof ConflictError) throw err;
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        keepRecent: t.Optional(t.Number({ minimum: 2, maximum: 100 })),
      }),
    },
  )
  .post('/:agentId/cancel', async ({ request, params: { agentId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    const cancelled = kory.cancelWorker(agentId);
    if (cancelled) await kory.waitForAgentIdle(agentId);
    return {
      ok: true,
      data: { cancelled },
      message: cancelled ? 'Agent cancellation requested' : 'Agent is not running',
    };
  })
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = loadAgentSettings(getRequestProjectRoot(request));
    return {
      ok: true,
      data: { ...settings, computerUseRevision: computerAuthorityRevision() },
      message: 'Project-scoped agent settings loaded.',
    };
  })
  .put('/settings', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = getRequestProjectRoot(request);
    const currentSettings = loadAgentSettings(root);
    const patch = body as Record<string, unknown>;
    const changesComputer = patch && Object.prototype.hasOwnProperty.call(patch, 'computerUse');
    if (changesComputer && patch.computerUseRevision !== computerAuthorityRevision()) {
      set.status = 409;
      return {
        ok: false,
        error: 'Computer permissions changed or were stopped. Reload settings before saving.',
      };
    }
    const newSettings = mergeAgentSettings(currentSettings, body);
    saveAgentSettings(root, newSettings);
    if (changesComputer) admitComputerPolicy(root, newSettings.computerUse);
    return {
      ok: true,
      data: { ...newSettings, computerUseRevision: computerAuthorityRevision() },
      message: 'Project-scoped agent settings updated.',
    };
  })
  .post('/settings/reset', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = resetAgentSettings(getRequestProjectRoot(request));
    return {
      ok: true,
      data: { ...settings, computerUseRevision: computerAuthorityRevision() },
      message: 'Project-scoped agent settings reset to defaults.',
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
      writePreferences(getRequestProjectRoot(request), body.content);
      return { ok: true, message: 'Preferences updated. Critic will enforce new rules.' };
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
  // Response style is a *user* skill: it lives in the personal skill library,
  // not the project, and is pinned on every manager turn. These routes edit
  // its markdown body without going through the draft/activate skill flow.
  .get('/response-style', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const style = readPersonalSkillInstructions(RESPONSE_STYLE_SKILL_NAME);
    if (!style) {
      set.status = 404;
      return { ok: false, error: 'Response style skill is not available' };
    }
    return { ok: true, data: style };
  })
  .put(
    '/response-style',
    ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const style = writePersonalSkillInstructions(RESPONSE_STYLE_SKILL_NAME, body.instructions);
        return { ok: true, data: style, message: 'Response style saved to your personal skills.' };
      } catch (error) {
        set.status = 400;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    {
      body: t.Object({
        instructions: t.String({ maxLength: 20_000 }),
      }),
    },
  )
  .post('/response-style/reset', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const style = resetPersonalSkillInstructions(RESPONSE_STYLE_SKILL_NAME);
    return { ok: true, data: style, message: 'Response style reset to the Koryphaios default.' };
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
      const root = getRequestProjectRoot(request);
      const settings = loadAgentSettings(root);
      const preferences = readPreferences(root).content;
      let rules = '';
      try {
        rules = readFileSync(join(root, '.koryphaios/rules/rules.md'), 'utf-8');
      } catch (err: unknown) {
        // No rules file is the common case; critic review proceeds without custom rules.
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), root },
          'No rules.md found; critic review will use defaults',
        );
      }

      const result = criticReview({
        code: body.code,
        filePath: body.filePath,
        changeDescription: body.changeDescription || 'Code change',
        settings,
        preferences,
        rules,
      });

      return { ok: true, data: result };
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

/** Build the prompt for LLM-based skill merge. */
function buildSkillMergePrompt(
  skillName: string,
  localContent: string,
  bundledContent: string,
  targetDocument?: SkillDocumentSpec,
): string {
  if (targetDocument) {
    return `Merge these two versions of the "${skillName}" skill into native .${targetDocument.extension} source rendered as ${targetDocument.renderer}.

## Rules
1. Preserve the LOCAL version's native .${targetDocument.extension} format exactly; do not add YAML frontmatter or Markdown fences.
2. Preserve all user customizations, examples, boundaries, references, and added sections.
3. Incorporate the BUNDLED Markdown version's substantive improvements, translating structure only where the target format supports it.
4. When a bundled construct cannot be represented safely, preserve it as literal source for review instead of deleting it.
5. Keep the result under 500 lines and output only the merged native source.

## LOCAL native source
---
${localContent}
---

## BUNDLED Markdown source
---
${bundledContent}
---

Produce the merged native .${targetDocument.extension} source now.`;
  }
  return `Merge these two versions of the "${skillName}" skill (SKILL.md).

## Rules
1. Start with the YAML frontmatter from the BUNDLED version (it has the correct metadata).
2. Preserve ALL customizations the user made in the LOCAL version — their domain-specific additions, examples, anti-patterns, references, and any sections they added.
3. Incorporate ALL improvements from the BUNDLED version — new sections, updated guidance, decision trees, tables, and structural improvements.
4. When both versions cover the same topic, prefer the BUNDLED version's structure but keep the LOCAL version's specific examples or domain knowledge.
5. Keep the merged result under 500 lines (excluding frontmatter).
6. Output ONLY the merged SKILL.md content — no explanation.

## LOCAL version (user's edits):
---
${localContent}
---

## BUNDLED version (new upstream):
---
${bundledContent}
---

Produce the merged SKILL.md now.`;
}
