import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsHome = mkdtempSync(join(tmpdir(), 'kory-route-skills-home-'));
const projectRoot = mkdtempSync(join(tmpdir(), 'kory-route-skills-project-'));
process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;

const { Elysia } = await import('elysia');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { localAuth } = await import('../../auth/local-auth');
const { listSkills } = await import('../../kory/skills');
const { errorHandler } = await import('../../middleware/error-handling');
const { agentSettingsRoutes } = await import('./agent-settings');

const app = new Elysia().onError(errorHandler).use(agentSettingsRoutes);
let authorization = '';

beforeAll(() => {
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});

afterAll(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

function request(path: string, body: unknown, method = 'POST'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization,
      'content-type': 'application/json',
      'x-koryphaios-project': projectRoot,
    },
    body: JSON.stringify(body),
  });
}

describe('agent settings skill routes', () => {
  test('validates legacy and v2 native documents through one compatible endpoint', async () => {
    const legacyResponse = await app.handle(
      request('/api/agent/skills/validate', {
        content: 'not a frontmatter skill',
      }),
    );
    expect(legacyResponse.status).toBe(200);
    const legacyPayload = (await legacyResponse.json()) as {
      ok: boolean;
      data: { valid: boolean };
    };
    expect(legacyPayload).toMatchObject({ ok: true, data: { valid: false } });

    const nativeResponse = await app.handle(
      request('/api/agent/skills/validate', {
        document: {
          kind: 'html',
          extension: 'html',
          renderer: 'html',
          mediaType: 'text/html',
        },
        sourceContent: '<article><p>Inspect evidence and report exact gaps.</p></article>',
        coreInstructions: 'Inspect evidence and report exact gaps.',
      }),
    );
    expect(nativeResponse.status).toBe(200);
    const nativePayload = (await nativeResponse.json()) as {
      ok: boolean;
      data: { valid: boolean; warnings: string[] };
    };
    expect(nativePayload.ok).toBe(true);
    expect(nativePayload.data.valid).toBe(true);
    expect(nativePayload.data.warnings.join(' ')).toContain('scriptless sandbox');
  });

  test('requires compare-and-swap identity for legacy draft saves', async () => {
    const active = listSkills(projectRoot).find(
      (skill) =>
        skill.name === 'implementation' && skill.source === 'personal' && skill.state === 'active',
    )!;
    const path = '/api/agent/skills/implementation/draft';

    const missingHash = await app.handle(
      request(path, { source: 'personal', content: active.content }, 'PUT'),
    );
    expect(missingHash.status).toBe(400);

    const staleHash = await app.handle(
      request(
        path,
        { source: 'personal', content: active.content, expectedHash: '0'.repeat(64) },
        'PUT',
      ),
    );
    expect(staleHash.status).toBe(409);
    expect(await staleHash.json()).toMatchObject({ ok: false, code: 'CONFLICT' });
  });

  test('returns the live budget-preview shape consumed by the frontend', async () => {
    const response = await app.handle(
      request('/api/agent/skills/resolve', {
        prompt: 'Build an accessible browser analytics interface',
        options: { contextBudget: 16_000 },
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        planningOnly: boolean;
        planningLimit: string;
        selected: Array<{
          representation?: string;
          contextCost?: number;
          fullContextCost?: number;
          omittedDetailChars?: number;
          promptText?: string;
        }>;
        compressedByBudget?: Array<{
          name?: string;
          representation?: string;
          contextCost?: number;
          fullContextCost?: number;
          omittedDetailChars?: number;
        }>;
        totalContextCost: number;
        contextBudget: number;
        contextOverheadCost: number;
        promptText: string;
        rejectedCandidates: Array<{ name: string; reason: string }>;
        rejectedCandidateCount: number;
        rejectedCandidatesTruncated: boolean;
        blocked: boolean;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.planningOnly).toBe(true);
    expect(payload.data.planningLimit).toContain('Final manager selection is recomputed');
    expect(payload.data.blocked).toBe(false);
    expect(Array.isArray(payload.data.compressedByBudget)).toBe(true);
    expect(payload.data.compressedByBudget!.length).toBeGreaterThan(0);
    for (const item of payload.data.selected) {
      expect(['full', 'compact', 'minimal']).toContain(item.representation!);
      expect(typeof item.contextCost).toBe('number');
      expect(typeof item.fullContextCost).toBe('number');
      expect(typeof item.omittedDetailChars).toBe('number');
      expect(item.contextCost).toBe(item.promptText?.length);
    }
    for (const item of payload.data.compressedByBudget!) {
      expect(typeof item.name).toBe('string');
      expect(['compact', 'minimal']).toContain(item.representation!);
      expect(typeof item.contextCost).toBe('number');
      expect(typeof item.fullContextCost).toBe('number');
      expect(typeof item.omittedDetailChars).toBe('number');
    }
    expect(
      payload.data.selected.reduce((sum, item) => sum + (item.contextCost ?? 0), 0) +
        payload.data.contextOverheadCost,
    ).toBe(payload.data.totalContextCost);
    expect(payload.data.promptText.length).toBe(payload.data.totalContextCost);
    expect(payload.data.promptText).toContain('## Active local skills');
    expect(payload.data.promptText).toContain('Manifest sha256:');
    expect(payload.data.contextBudget).toBe(16_000);
    expect(payload.data.totalContextCost).toBeLessThanOrEqual(16_000);
    expect(payload.data.rejectedCandidateCount).toBeGreaterThan(0);
    expect(payload.data.rejectedCandidates.length).toBeLessThanOrEqual(24);
    expect(
      payload.data.rejectedCandidates.every(
        (candidate) => candidate.name.length <= 64 && candidate.reason.length <= 240,
      ),
    ).toBe(true);
    expect(typeof payload.data.rejectedCandidatesTruncated).toBe('boolean');
  });

  test('creates structured broader and facet relations through the live API', async () => {
    const response = await app.handle(
      request('/api/agent/skills', {
        source: 'project',
        name: 'native-release-review',
        description:
          'Review native release evidence and recovery behavior. Use when a desktop milestone needs an independent readiness check.',
        instructions:
          'Inspect the claimed behavior, reproduce critical paths, record unavailable checks, and reject unsupported completion claims.',
        domains: ['release', 'verification'],
        activation: ['native release review'],
        shouldTrigger: ['review this native release', 'verify this desktop milestone'],
        shouldNotTrigger: ['write a slogan', 'rename a local variable'],
        evidence: ['Reproduced native gates'],
        broader: ['verification'],
        facets: ['security-review'],
        requires: ['testing-engineering'],
        conflicts: ['documents-communication'],
        excludes: ['marketing only'],
        targetMedia: ['head-mounted display'],
        depth: 1,
        contextBudget: 2600,
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        state: string;
        content: string;
        metadata: {
          broader: string[];
          facets: string[];
          requires: string[];
          conflicts: string[];
          excludes: string[];
          targetMedia: string[];
          depth: number;
          contextBudget: number;
        };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.state).toBe('draft');
    expect(payload.data.metadata).toMatchObject({
      broader: ['verification'],
      facets: ['security-review'],
      requires: ['testing-engineering'],
      conflicts: ['documents-communication'],
      excludes: ['marketing only'],
      targetMedia: ['head-mounted display'],
      depth: 1,
      contextBudget: 2600,
    });

    const originalDraft = payload.data.content;
    const duplicate = await app.handle(
      request('/api/agent/skills', {
        source: 'project',
        name: 'native-release-review',
        description:
          'Try to overwrite release evidence. Use when API conflict protection is being verified.',
        instructions:
          'This replacement content must be rejected without changing the existing structured skill draft.',
        domains: ['verification'],
        activation: ['overwrite release review'],
        shouldTrigger: ['overwrite the release review', 'test draft overwrite protection'],
        shouldNotTrigger: ['write a slogan', 'rename a local variable'],
        evidence: ['HTTP conflict and unchanged draft'],
      }),
    );
    expect(duplicate.status).toBe(409);
    const duplicatePayload = (await duplicate.json()) as { ok: boolean; code: string };
    expect(duplicatePayload).toMatchObject({ ok: false, code: 'CONFLICT' });

    const afterConflict = await app.handle(
      new Request('http://localhost/api/agent/skills', {
        headers: {
          authorization,
          'x-koryphaios-project': projectRoot,
        },
      }),
    );
    const afterPayload = (await afterConflict.json()) as {
      data: Array<{ name: string; state: string; content: string }>;
    };
    const afterDraft = afterPayload.data.find(
      (skill) => skill.name === 'native-release-review' && skill.state === 'draft',
    );
    expect(afterDraft?.content).toBe(originalDraft);

    const invalid = await app.handle(
      request('/api/agent/skills', {
        source: 'project',
        name: 'unsafe-relation',
        description:
          'Review unsafe relation handling. Use when structured skill metadata must reject unknown dependencies.',
        instructions:
          'Inspect structured relations, require known stable identifiers, and reject invalid graph changes before persistence.',
        domains: ['verification'],
        activation: ['unsafe relation review'],
        shouldTrigger: ['review this relation graph', 'verify structured skill metadata'],
        shouldNotTrigger: ['write a slogan', 'rename a local variable'],
        evidence: ['Rejected invalid relation'],
        broader: ['missing-skill'],
        targetMedia: ['any'],
        depth: 1,
        contextBudget: 2000,
      }),
    );
    expect(invalid.status).toBe(400);
  });

  test('creates a freeform draft through the skip-template API', async () => {
    const response = await app.handle(
      request('/api/agent/skills/freeform', {
        source: 'project',
        name: 'freeform-review',
        description: 'Follow a user-authored review process.',
        instructions:
          'Read the supplied material, apply my criteria, and return the evidence I requested.',
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      data: { state: string; instructions: string; metadata: { activation: string[] } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.state).toBe('draft');
    expect(payload.data.instructions).toContain('apply my criteria');
    expect(payload.data.metadata.activation).toEqual([]);
  });

  test('previews and confirms format conversion without mutating the active revision', async () => {
    const listed = await app.handle(
      new Request('http://localhost/api/agent/skills', {
        headers: {
          authorization,
          'x-koryphaios-project': projectRoot,
        },
      }),
    );
    const skills = (await listed.json()) as {
      data: Array<{ name: string; source: string; state: string; hash: string }>;
    };
    const active = skills.data.find(
      (skill) =>
        skill.name === 'implementation' && skill.source === 'personal' && skill.state === 'active',
    )!;
    const body = {
      source: 'personal',
      state: 'active',
      expectedHash: active.hash,
      document: {
        kind: 'html',
        extension: 'html',
        renderer: 'html',
        mediaType: 'text/html',
      },
    };
    const dryRun = await app.handle(
      request('/api/agent/skills/implementation/convert', { ...body, dryRun: true }),
    );
    expect(dryRun.status).toBe(200);
    const preview = (await dryRun.json()) as {
      data: { convertedContent: string; draft?: unknown; warnings: string[] };
    };
    expect(preview.data.convertedContent).toContain('<article><pre>');
    expect(preview.data.draft).toBeUndefined();
    expect(preview.data.warnings.length).toBeGreaterThan(0);

    const confirmed = await app.handle(
      request('/api/agent/skills/implementation/convert', { ...body, dryRun: false }),
    );
    expect(confirmed.status).toBe(200);
    const converted = (await confirmed.json()) as {
      data: { draft: { state: string; hash: string; document: { kind: string } } };
    };
    expect(converted.data.draft.state).toBe('draft');
    expect(converted.data.draft.document.kind).toBe('html');

    const staleTest = await app.handle(
      request('/api/agent/skills/implementation/test', {
        source: 'personal',
        state: 'draft',
        expectedHash: '0'.repeat(64),
      }),
    );
    expect(staleTest.status).toBe(409);
    expect(await staleTest.json()).toMatchObject({ ok: false, code: 'CONFLICT' });

    const staleActivation = await app.handle(
      request('/api/agent/skills/implementation/activate', {
        source: 'personal',
        expectedHash: '0'.repeat(64),
      }),
    );
    expect(staleActivation.status).toBe(409);
    expect(await staleActivation.json()).toMatchObject({ ok: false, code: 'CONFLICT' });
  });

  test('maps Elysia body-schema failures to a bounded client error', async () => {
    const response = await app.handle(
      request('/api/agent/skills', {
        source: 'project',
        name: 'missing-required-fields',
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      ok: boolean;
      error: string;
      code: string;
      correlationId: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.error).toBe('Request does not match the required schema');
    expect(payload.error.length).toBeLessThan(120);
    expect(payload.correlationId.length).toBeGreaterThan(0);
  });
});
