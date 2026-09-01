import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateSkill,
  applyDefaultUpdate,
  convertSkillRevision,
  createSkillDraft,
  listSkills,
  normalizeSkillDocumentSpec,
  resolveSkills,
  saveSkillDocumentDraft,
  saveAgentMergedSkillDraft,
  SkillRevisionConflictError,
  validateSkillDocument,
  type CreateSkillDraftInput,
  type SkillDocumentSpec,
} from '../skills';
import { createTaskContract } from '../prompts';

let projectRoot = '';
let skillsHome = '';

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'kory-formats-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-formats-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(projectRoot, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

function document(kind: 'markdown' | 'text' | 'html' | 'custom'): SkillDocumentSpec {
  if (kind === 'markdown') {
    return { kind, extension: 'md', renderer: 'markdown', mediaType: 'text/markdown' };
  }
  if (kind === 'text') {
    return { kind, extension: 'txt', renderer: 'plain', mediaType: 'text/plain' };
  }
  if (kind === 'html') {
    return { kind, extension: 'html', renderer: 'html', mediaType: 'text/html' };
  }
  return { kind, extension: '.prompt', renderer: 'plain', mediaType: 'text/x-prompt' };
}

function input(kind: 'markdown' | 'text' | 'html' | 'custom'): CreateSkillDraftInput {
  const name = `format-${kind}`;
  const sourceContent =
    kind === 'html'
      ? '<article><h1>Evidence review</h1><p>Inspect the evidence and report exact gaps.</p></article>'
      : 'Inspect the supplied evidence, reproduce the bounded checks, and report exact gaps before making a readiness claim.';
  return {
    source: 'project',
    name,
    description: `Use this ${kind} skill to review concrete evidence and report unsupported readiness claims precisely.`,
    instructions: sourceContent,
    sourceContent,
    coreInstructions: 'Inspect evidence, reproduce bounded checks, and report unsupported claims.',
    document: document(kind),
    domains: ['verification'],
    activation: [`${kind} evidence review`],
    shouldTrigger: [`run the ${kind} evidence review`, `${kind} evidence review for this release`],
    shouldNotTrigger: ['write a poem about weather', 'rename this unrelated variable'],
    evidence: ['Reproduced checks and exact gaps'],
    targetMedia: ['any'],
  };
}

describe('native skill document formats', () => {
  test('validates native descriptors, source safety, and format-neutral core instructions', () => {
    expect(
      validateSkillDocument({
        document: document('html'),
        sourceContent: '<article><p>Review evidence without executing this document.</p></article>',
        coreInstructions: 'Review evidence and report exact gaps.',
      }),
    ).toMatchObject({
      valid: true,
      errors: [],
      warnings: [expect.stringContaining('scriptless sandbox')],
    });
    expect(
      validateSkillDocument({
        document: { ...document('custom'), extension: '../prompt' },
        sourceContent: 'Unsafe\0source',
        coreInstructions: '',
      }),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringContaining('extension'),
        expect.stringContaining('NUL'),
        expect.stringContaining('coreInstructions'),
      ]),
    });
  });

  test('round-trips Markdown, text, HTML, and custom native revisions with sidecars', () => {
    for (const kind of ['markdown', 'text', 'html', 'custom'] as const) {
      const draft = createSkillDraft(projectRoot, input(kind));
      expect(draft.storageVersion).toBe(2);
      expect(draft.document.kind).toBe(kind);
      expect(draft.document.extension).toBe(
        kind === 'custom' ? 'prompt' : document(kind).extension,
      );
      expect(draft.validation.valid).toBe(true);
      const directory = join(projectRoot, '.koryphaios', 'skills', draft.name);
      expect(existsSync(join(directory, `DRAFT.${draft.document.extension}`))).toBe(true);
      expect(existsSync(join(directory, 'DRAFT.kory.json'))).toBe(true);
      expect(readFileSync(draft.path, 'utf8')).toBe(draft.sourceContent);
    }
    expect(listSkills(projectRoot).filter((skill) => skill.storageVersion === 2)).toHaveLength(4);
  });

  test('rejects traversal, reserved extensions, NUL data, and stale revision hashes', () => {
    expect(() =>
      normalizeSkillDocumentSpec({ ...document('custom'), extension: '../prompt' }),
    ).toThrow();
    expect(() =>
      normalizeSkillDocumentSpec({ ...document('custom'), extension: 'kory.json' }),
    ).toThrow();
    const draft = createSkillDraft(projectRoot, input('text'));
    expect(() =>
      saveSkillDocumentDraft(projectRoot, 'project', draft.name, {
        document: draft.document,
        sourceContent: `${draft.sourceContent}\0`,
        coreInstructions: draft.coreInstructions,
        expectedHash: draft.hash,
      }),
    ).toThrow('NUL');
    expect(() =>
      saveSkillDocumentDraft(projectRoot, 'project', draft.name, {
        document: draft.document,
        sourceContent: `${draft.sourceContent}\nChanged externally.`,
        coreInstructions: draft.coreInstructions,
        expectedHash: '0'.repeat(64),
      }),
    ).toThrow(SkillRevisionConflictError);
  });

  test('activates a valid v2 revision and keeps routing and compact loading format-neutral', () => {
    const draft = createSkillDraft(projectRoot, input('html'));
    const active = activateSkill(projectRoot, 'project', draft.name);
    expect(active.storageVersion).toBe(2);
    expect(active.document.kind).toBe('html');
    expect(active.sourceContent).toContain('<article>');
    expect(existsSync(join(projectRoot, '.koryphaios', 'skills', draft.name, 'DRAFT.html'))).toBe(
      false,
    );
    const prompt = 'Run the html evidence review for this release';
    const resolution = resolveSkills(projectRoot, prompt, createTaskContract(prompt), {
      pins: [draft.name],
      contextBudget: 3000,
    });
    const selected = resolution.selected.find((item) => item.skill.name === draft.name);
    expect(selected).toBeDefined();
    if (selected?.representation !== 'full') {
      expect(selected?.promptText).toContain('format-neutral core');
    }
  });

  test('converts an active legacy Markdown skill to a review-only HTML draft', () => {
    const active = listSkills(projectRoot).find(
      (skill) => skill.name === 'implementation' && skill.state === 'active',
    )!;
    const preview = convertSkillRevision(
      projectRoot,
      'personal',
      active.name,
      'active',
      document('html'),
      true,
      active.hash,
    );
    expect(preview.convertedContent).toContain('<article><pre>');
    expect(
      listSkills(projectRoot).some(
        (skill) => skill.name === active.name && skill.state === 'draft',
      ),
    ).toBe(false);
    const confirmed = convertSkillRevision(
      projectRoot,
      'personal',
      active.name,
      'active',
      document('html'),
      false,
      active.hash,
    );
    expect(confirmed.draft?.document.kind).toBe('html');
    expect(
      listSkills(projectRoot).find(
        (skill) => skill.name === active.name && skill.state === 'active',
      )?.hash,
    ).toBe(active.hash);
  });

  test('keeps the selected native format for bundled and agent-merged review drafts', () => {
    const legacyActive = listSkills(projectRoot).find(
      (skill) => skill.name === 'implementation' && skill.state === 'active',
    )!;
    const converted = convertSkillRevision(
      projectRoot,
      'personal',
      legacyActive.name,
      'active',
      document('html'),
      false,
      legacyActive.hash,
    );
    const htmlActive = activateSkill(projectRoot, 'personal', converted.draft!.name);
    expect(htmlActive.document.kind).toBe('html');

    const agentMerge = saveAgentMergedSkillDraft(
      htmlActive.name,
      '<article><h1>Merged review</h1><p>Preserve local and bundled evidence rules.</p></article>',
    );
    expect(agentMerge.state).toBe('draft');
    expect(agentMerge.document).toEqual(htmlActive.document);
    expect(agentMerge.sourceContent).toContain('Merged review');
    activateSkill(projectRoot, 'personal', agentMerge.name);

    const automaticMerge = applyDefaultUpdate(projectRoot, htmlActive.name, 'merge');
    expect(automaticMerge.state).toBe('draft');
    expect(automaticMerge.document).toEqual(htmlActive.document);
    expect(automaticMerge.sourceContent).toContain('<section>');
  });
});
