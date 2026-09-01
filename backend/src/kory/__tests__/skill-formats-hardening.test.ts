import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateSkill,
  applyDefaultUpdate,
  convertSkillRevision,
  createSkillDraft,
  listSkills,
  saveSkillDocumentDraft,
  SkillRevisionConflictError,
  validateSkillDocument,
  type CreateSkillDraftInput,
  type SkillDocumentSpec,
} from '../skills';

const markdownDocument: SkillDocumentSpec = {
  kind: 'markdown',
  extension: 'md',
  renderer: 'markdown',
  mediaType: 'text/markdown',
};

const htmlDocument: SkillDocumentSpec = {
  kind: 'html',
  extension: 'html',
  renderer: 'html',
  mediaType: 'text/html',
};

let projectRoot = '';
let skillsHome = '';

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'kory-format-hardening-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-format-hardening-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(projectRoot, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

function nativeInput(name: string, document = htmlDocument): CreateSkillDraftInput {
  const sourceContent =
    document.renderer === 'html'
      ? '<article><p>Inspect supplied evidence and report exact persistence failures.</p></article>'
      : 'Inspect supplied evidence, preserve exact user files, and report persistence failures.';
  return {
    source: 'project',
    name,
    description:
      'Use this persistence audit skill to reproduce native revision failures and verify exact recovery behavior.',
    instructions:
      'Inspect supplied evidence, reproduce bounded persistence behavior, preserve user files, and report exact recovery failures.',
    sourceContent,
    coreInstructions: 'Inspect evidence, preserve user files, and report exact recovery failures.',
    document,
    domains: ['verification'],
    activation: [`${name} audit`],
    shouldTrigger: [`run the ${name} audit`, `verify ${name} recovery behavior`],
    shouldNotTrigger: ['write a slogan', 'rename a variable'],
    evidence: ['Exact persisted file inventory'],
    targetMedia: ['any'],
  };
}

function activePersonal(name: string) {
  return listSkills(projectRoot).find(
    (skill) => skill.name === name && skill.source === 'personal' && skill.state === 'active',
  )!;
}

describe('native skill format hardening regressions', () => {
  test('keeps the bundled Markdown file when replacing an active v2 Markdown revision', () => {
    const legacy = activePersonal('implementation');
    const converted = convertSkillRevision(
      projectRoot,
      'personal',
      legacy.name,
      'active',
      markdownDocument,
      false,
      legacy.hash,
    );
    const nativeActive = activateSkill(projectRoot, 'personal', converted.draft!.name);
    const directory = join(skillsHome, legacy.name);

    expect(nativeActive.storageVersion).toBe(2);
    expect(nativeActive.path).toBe(join(directory, 'SKILL.md'));
    expect(existsSync(join(directory, 'SKILL.kory.json'))).toBe(true);

    const replaced = applyDefaultUpdate(projectRoot, legacy.name, 'replace');

    expect(replaced.storageVersion).toBe(1);
    expect(replaced.validation.valid).toBe(true);
    expect(existsSync(join(directory, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(directory, 'SKILL.kory.json'))).toBe(false);
    expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toContain('name: implementation');
  });

  test('invalidates exact persisted descriptor edits and rejects the stale save hash', () => {
    const draft = createSkillDraft(projectRoot, nativeInput('descriptor-hash', markdownDocument));
    const sidecarPath = join(projectRoot, '.koryphaios', 'skills', draft.name, 'DRAFT.kory.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as {
      document: SkillDocumentSpec;
    };
    sidecar.document = {
      kind: 'markdown',
      extension: 'externally-edited',
      renderer: 'html',
      mediaType: 'text/x-external-edit',
    };
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

    const externallyEdited = listSkills(projectRoot).find(
      (skill) => skill.name === draft.name && skill.state === 'draft',
    )!;

    expect(externallyEdited.hash).not.toBe(draft.hash);
    expect(externallyEdited.validation.valid).toBe(false);
    expect(externallyEdited.validation.errors).toContain(
      'Persisted skill document descriptor must use its canonical format tuple',
    );
    expect(() =>
      saveSkillDocumentDraft(projectRoot, 'project', draft.name, {
        document: draft.document,
        sourceContent: `${draft.sourceContent}\nThis stale edit must not be saved.`,
        coreInstructions: draft.coreInstructions,
        expectedHash: draft.hash,
      }),
    ).toThrow(SkillRevisionConflictError);
  });

  test('surfaces malformed and incomplete sidecars as invalid v2 revisions without legacy fallback', () => {
    const malformed = createSkillDraft(projectRoot, nativeInput('malformed-sidecar'));
    const malformedDirectory = join(projectRoot, '.koryphaios', 'skills', malformed.name);
    writeFileSync(
      join(malformedDirectory, 'DRAFT.md'),
      `---
name: ${malformed.name}
description: A valid stale legacy draft that must never mask malformed v2 metadata.
metadata:
  koryphaios:
    version: 1.0.0
    contextBudget: 2000
    sourceScope: local-only
---
# ${malformed.name}

This valid legacy body must remain inactive while the v2 sidecar exists.
`,
      'utf8',
    );
    writeFileSync(join(malformedDirectory, 'DRAFT.kory.json'), '{broken-json', 'utf8');

    const malformedRevision = listSkills(projectRoot).find(
      (skill) => skill.name === malformed.name && skill.state === 'draft',
    )!;
    expect(malformedRevision.storageVersion).toBe(2);
    expect(malformedRevision.validation.valid).toBe(false);
    expect(malformedRevision.validation.errors[0]).toContain('Invalid v2 metadata JSON');
    expect(malformedRevision.sourceContent).not.toContain('valid legacy body');

    const incomplete = createSkillDraft(projectRoot, nativeInput('incomplete-sidecar'));
    const incompletePath = join(
      projectRoot,
      '.koryphaios',
      'skills',
      incomplete.name,
      'DRAFT.kory.json',
    );
    const incompleteSidecar = JSON.parse(readFileSync(incompletePath, 'utf8')) as {
      description?: string;
      metadata: Record<string, unknown>;
    };
    delete incompleteSidecar.description;
    delete incompleteSidecar.metadata.shouldTrigger;
    writeFileSync(incompletePath, `${JSON.stringify(incompleteSidecar, null, 2)}\n`, 'utf8');

    const incompleteRevision = listSkills(projectRoot).find(
      (skill) => skill.name === incomplete.name && skill.state === 'draft',
    )!;
    expect(incompleteRevision.storageVersion).toBe(2);
    expect(incompleteRevision.validation.valid).toBe(false);
    expect(incompleteRevision.validation.errors).toContain(
      'description must be 12 to 1024 characters',
    );
    expect(incompleteRevision.validation.errors).toContain(
      'metadata.shouldTrigger must be an array of strings',
    );
  });

  test('rejects binary control data even when it appears beyond the old sample window', () => {
    const validation = validateSkillDocument({
      document: htmlDocument,
      sourceContent: `${'a'.repeat(9000)}${String.fromCharCode(1).repeat(1000)}`,
      coreInstructions: 'Inspect exact evidence and fail closed on binary native source.',
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Skill source appears to contain binary data');
  });

  test('removes stale legacy Markdown after HTML activation and returns the canonical v2 revision', () => {
    const legacy = activePersonal('planning');
    const converted = convertSkillRevision(
      projectRoot,
      'personal',
      legacy.name,
      'active',
      htmlDocument,
      false,
      legacy.hash,
    );
    const htmlActive = activateSkill(projectRoot, 'personal', converted.draft!.name);
    const directory = join(skillsHome, legacy.name);

    expect(htmlActive.storageVersion).toBe(2);
    expect(htmlActive.document.kind).toBe('html');
    expect(existsSync(join(directory, 'SKILL.html'))).toBe(true);
    expect(existsSync(join(directory, 'SKILL.kory.json'))).toBe(true);
    expect(existsSync(join(directory, 'SKILL.md'))).toBe(false);

    const kept = applyDefaultUpdate(projectRoot, legacy.name, 'keep-local');
    expect(kept.storageVersion).toBe(2);
    expect(kept.document.kind).toBe('html');
    expect(kept.hash).toBe(htmlActive.hash);
    expect(kept.path).toBe(join(directory, 'SKILL.html'));
  });

  test('does not follow a native-source symlink while loading a v2 revision', () => {
    const draft = createSkillDraft(projectRoot, nativeInput('symlink-source'));
    const nativePath = draft.path;
    const outsidePath = join(projectRoot, 'outside-secret.txt');
    writeFileSync(outsidePath, 'secret content outside the native skill file', 'utf8');
    unlinkSync(nativePath);
    symlinkSync(outsidePath, nativePath);

    const loaded = listSkills(projectRoot).find(
      (skill) => skill.name === draft.name && skill.state === 'draft',
    )!;
    expect(loaded.storageVersion).toBe(2);
    expect(loaded.validation.valid).toBe(false);
    expect(loaded.validation.errors).toContain('DRAFT.html must be a regular non-symlink file');
    expect(loaded.sourceContent).toBe('');
    expect(loaded.content).not.toContain('secret content');
  });

  test('rejects invalid UTF-8 native bytes instead of decoding replacement text', () => {
    const draft = createSkillDraft(projectRoot, nativeInput('invalid-utf8'));
    writeFileSync(draft.path, Uint8Array.from([0xff, 0xfe, 0xfd]));

    const loaded = listSkills(projectRoot).find(
      (skill) => skill.name === draft.name && skill.state === 'draft',
    )!;
    expect(loaded.validation.valid).toBe(false);
    expect(loaded.validation.errors).toContain('DRAFT.html must contain valid UTF-8 text');
    expect(loaded.sourceContent).toBe('');
  });
});
