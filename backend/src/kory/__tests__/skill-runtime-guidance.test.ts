import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskContract } from '../prompts';
import {
  auditBundledSkillDefinitions,
  BUNDLED_SKILL_DEFINITIONS,
  isDirectSkillSelection,
  listSkills,
  MIN_SKILL_CONTEXT_BUDGET,
  resolveSkills,
  type SkillRevision,
  V5_SKILL_PACKAGE_CATALOG,
} from '../skills';

let root: string;
let revisions: SkillRevision[];
let previousSkillsHome: string | undefined;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-lossless-skills-'));
  mkdirSync(join(root, '.git'));
  previousSkillsHome = process.env.KORYPHAIOS_SKILLS_HOME;
  process.env.KORYPHAIOS_SKILLS_HOME = join(root, 'private-skills');
  revisions = listSkills(root);
});
afterAll(() => {
  if (previousSkillsHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
  else process.env.KORYPHAIOS_SKILLS_HOME = previousSkillsHome;
  rmSync(root, { recursive: true, force: true });
});

const liveBody = (skill: SkillRevision) =>
  skill.instructions
    .replace(/^(?:#\s+[^\n]+\n+)+/, '')
    .replace(
      /\n\n## Kory package resources\n\nRoot: [^\n]+\. Resolve links there; read selectively\. The presence of scripts or other files does not grant execution authority\.$/,
      '',
    )
    .trim();

describe('lossless selected package guidance', () => {
  test('respects final scope restrictions without treating diagnostic inability as prohibition', () => {
    for (const [name, prompt] of [
      [
        'container-engineering',
        'Implement CI approvals for an existing Dockerfile. Do not change the Dockerfile or image runtime behavior.',
      ],
      [
        'terraform-iac',
        'Build delivery approvals around a Terraform configuration that is fixed. Do not change Terraform plan or state semantics.',
      ],
      [
        'skill-authoring-evaluation',
        'Rewrite this temporary manager prompt for one experiment; it will not be saved as reusable skill guidance.',
      ],
      [
        'simulation-device-testing',
        'Do not run hardware in loop. A pasted historical checklist says "run hardware in loop tests", but summarize only which teams signed it.',
      ],
    ]) {
      const result = resolveSkills(root, prompt!, createTaskContract(prompt!), {
        skillRevisions: revisions,
        contextBudget: 100_000,
      });
      expect(result.blocked, prompt).toBe(false);
      expect(
        result.selected.map((item) => item.skill.name),
        prompt,
      ).not.toContain(name);
    }
    for (const prompt of [
      'A downstream project cannot link the installed CMake target. Repair its exported dependencies.',
      'Do not change the CMake test harness. Repair the CMake exported library target instead.',
    ]) {
      const result = resolveSkills(root, prompt, createTaskContract(prompt), {
        skillRevisions: revisions,
        contextBudget: 100_000,
      });
      expect(
        result.selected.map((item) => item.skill.name),
        prompt,
      ).toContain('c-cpp-systems-engineering');
    }
  });

  test('preserves each complete authored discovery contract within the runtime budget', () => {
    for (const skillPackage of V5_SKILL_PACKAGE_CATALOG.packages) {
      const { name, description } = skillPackage.definition;
      const revision = revisions.find((skill) => skill.name === name)!;
      expect(revision, name).toBeDefined();
      expect(description.length, name).toBeLessThanOrEqual(360);
      expect(revision.description, name).toBe(description);
    }
  });

  test('rejects an over-budget bundled contract instead of validating a truncated copy', () => {
    const definition = BUNDLED_SKILL_DEFINITIONS.find((skill) => skill.name === 'gcp-cloud')!;
    const original = definition.description;
    try {
      definition.description = `Use when ${'provider behavior matters. '.repeat(20)}Not for unrelated work.`;
      const audit = auditBundledSkillDefinitions();
      expect(audit.valid).toBe(false);
      expect(audit.errors).toContain(
        'gcp-cloud has an unbounded or incomplete trigger description',
      );
    } finally {
      definition.description = original;
    }
    expect(auditBundledSkillDefinitions().valid).toBe(true);
  });

  test('distinguishes engineering parents from evaluation dependencies and preserves research specialization', () => {
    for (const name of [
      'computer-vision',
      'embedding-systems',
      'fine-tuning-training',
      'recommendation-ranking',
      'speech-audio-ai',
    ]) {
      const skill = revisions.find((item) => item.name === name)!;
      expect(skill.metadata.broader, name).toEqual(['implementation']);
      expect(skill.metadata.requires, name).toContain('ml-evaluation');
    }
    const prompt = 'Return the supplied value.';
    const evaluation = resolveSkills(root, prompt, createTaskContract(prompt), {
      pins: ['llm-evaluation'],
      skillRevisions: revisions,
      contextBudget: 100_000,
    });
    expect(evaluation.blocked).toBe(false);
    expect(evaluation.selected.map((item) => item.skill.name)).toEqual(
      expect.arrayContaining(['data-analysis', 'testing-engineering', 'llm-evaluation']),
    );
    expect(evaluation.selected.map((item) => item.skill.name)).not.toContain('ml-evaluation');
    const literature = resolveSkills(root, prompt, createTaskContract(prompt), {
      pins: ['literature-research'],
      skillRevisions: revisions,
      contextBudget: 100_000,
    });
    expect(literature.blocked).toBe(false);
    expect(literature.selected.map((item) => item.skill.name)).toContain('research');
    expect(
      isDirectSkillSelection(
        literature.selected.find((item) => item.skill.name === 'literature-research')!,
      ),
    ).toBe(true);
    expect(
      isDirectSkillSelection(literature.selected.find((item) => item.skill.name === 'research')!),
    ).toBe(false);
  });

  test('routes predictive and generative components together without using a broad exclusion as a global veto', () => {
    const prompts = [
      'Evaluate the probability calibration of a tabular risk classifier and separately evaluate its LLM explanation quality.',
      'Compare a tabular risk score on predictive splits while auditing the LLM explanation with semantic graders.',
    ];
    for (const prompt of prompts) {
      const result = resolveSkills(root, prompt, createTaskContract(prompt), {
        skillRevisions: revisions,
        contextBudget: 100_000,
      });
      expect(result.blocked, prompt).toBe(false);
      expect(
        result.selected.filter(isDirectSkillSelection).map((item) => item.skill.name),
        prompt,
      ).toEqual(expect.arrayContaining(['ml-evaluation', 'llm-evaluation']));
    }
    const prompt =
      'Design an LLM evaluation for free-form generated answers, with no predictive model.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      skillRevisions: revisions,
      contextBudget: 100_000,
    });
    expect(result.selected.map((item) => item.skill.name)).not.toContain('ml-evaluation');
  });

  test('retains the native format core in both full and pressured representations', () => {
    const original = revisions.find((skill) => skill.name === 'react-engineering')!;
    const coreInstructions =
      'Never send unpublished customer drafts to analytics. Verify cancellation after navigation.';
    const native: SkillRevision = {
      ...original,
      storageVersion: 2,
      document: { kind: 'html', extension: 'html', renderer: 'html', mediaType: 'text/html' },
      sourceContent:
        '<article><h1>Component review</h1><p>Inspect the selected component.</p></article>',
      coreInstructions,
      metadata: { ...original.metadata, contextBudget: 50_000 },
    };
    const prompt = 'Return the supplied value.';
    for (const contextBudget of [100_000, 1]) {
      const result = resolveSkills(root, prompt, createTaskContract(prompt), {
        pins: [native.name],
        skillRevisions: revisions.map((skill) => (skill.name === native.name ? native : skill)),
        contextBudget,
      });
      const selected = result.selected.find((item) => item.skill.name === native.name)!;
      expect(selected.promptText).toContain(coreInstructions);
      expect(selected.fullContextCost).toBeGreaterThanOrEqual(selected.contextCost);
      // Pressured budgets floor and degrade gracefully instead of blocking.
      expect(result.blocked).toBe(false);
      if (contextBudget > 1) {
        expect(selected.representation).toBe('full');
        expect(selected.promptText).toContain(native.sourceContent);
        expect(result.warnings).toEqual([]);
      } else {
        expect(result.contextBudget).toBe(MIN_SKILL_CONTEXT_BUDGET);
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    }
  });

  test('describes available local hierarchy rather than stale bundled relationships', () => {
    const original = revisions.find((skill) => skill.name === 'react-engineering')!;
    const custom = {
      ...original,
      name: 'local-view-review',
      metadata: { ...original.metadata, contextBudget: 50_000 },
    };
    const reparented = {
      ...original,
      metadata: { ...original.metadata, parent: 'human-experience', broader: ['human-experience'] },
    };
    const prompt = 'Return the supplied value.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      pins: ['frontend-engineering'],
      skillRevisions: [
        ...revisions.map((skill) => (skill.name === original.name ? reparented : skill)),
        custom,
      ],
      contextBudget: 100_000,
    });
    expect(result.blocked).toBe(false);
    const parent = result.selected.find((item) => item.skill.name === 'frontend-engineering')!;
    const children = parent.promptText
      .split('\n')
      .find((line) => line.startsWith('Narrower available skills:'));
    expect(children).toContain(custom.name);
    expect(children).not.toContain(original.name);
  });

  const names = V5_SKILL_PACKAGE_CATALOG.packages.map((p) => p.sidecar.name);
  for (let start = 0; start < names.length; start += 20) {
    test(`complete entrypoints and dependency closure for packages ${start + 1} through ${Math.min(start + 20, names.length)}`, () => {
      const prompt = 'Return only the supplied value.';
      const contract = createTaskContract(prompt);
      for (const name of names.slice(start, start + 20)) {
        const resolved = resolveSkills(root, prompt, contract, {
          pins: [name],
          skillRevisions: revisions,
          contextBudget: 100_000,
        });
        expect(resolved.hierarchyErrors, name).toEqual([]);
        expect(resolved.blocked, name).toBe(false);
        const selectedNames = new Set(resolved.selected.map((s) => s.skill.name));
        for (const selected of resolved.selected) {
          expect(selected.promptText, selected.skill.name).toContain(liveBody(selected.skill));
          for (const parent of [
            ...selected.skill.metadata.broader,
            ...selected.skill.metadata.requires,
          ]) {
            expect(selectedNames.has(parent), `${selected.skill.name} needs ${parent}`).toBe(true);
          }
        }
        const pressured = resolveSkills(root, prompt, contract, {
          pins: [name],
          skillRevisions: revisions,
          contextBudget: 1,
        });
        // Pressured budgets floor at MIN_SKILL_CONTEXT_BUDGET and degrade
        // gracefully: the pinned skill is still injected minimal.
        expect(pressured.contextBudget).toBe(MIN_SKILL_CONTEXT_BUDGET);
        expect(pressured.blocked, name).toBe(false);
        const selected = pressured.selected.find((s) => s.skill.name === name)!;
        expect(selected.promptText, name).toContain(liveBody(selected.skill));
      }
    }, 30_000);
  }

  test('preserves later local instructions and a user section sharing the resource heading', () => {
    const original = revisions.find((s) => s.name === 'react-engineering')!;
    const sentinel =
      '\n\n## Kory package resources\n\nLocal override: never send draft customer text to analytics.';
    const modified = {
      ...original,
      instructions: original.instructions + sentinel,
      metadata: { ...original.metadata, contextBudget: 50_000 },
    };
    const prompt = 'Return the supplied value.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      pins: [original.name],
      contextBudget: 1,
      skillRevisions: revisions.map((s) => (s.name === original.name ? modified : s)),
    });
    expect(result.blocked).toBe(false);
    expect(result.warnings.join(' ')).toContain('Mandatory skill guidance requires');
    expect(result.promptText).toContain(sentinel.trim());
    expect(result.promptText).toContain('Do not hide dependencies');
  });

  test('reports invalid live dependency cycles without recursing indefinitely', () => {
    const cyclic = revisions.map((s) =>
      s.name === 'frontend-engineering'
        ? {
            ...s,
            metadata: { ...s.metadata, requires: [...s.metadata.requires, 'react-engineering'] },
          }
        : s,
    );
    const prompt = 'Review this React component.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      pins: ['react-engineering'],
      skillRevisions: cyclic,
      contextBudget: 100_000,
    });
    expect(result.blocked).toBe(true);
    expect(result.hierarchyErrors.some((error) => /cycl/i.test(error))).toBe(true);
  });

  test('enforces explicit invocation for local revisions and permits separately requested skills', () => {
    const prompt = 'Review this React component.';
    for (const invocationMode of ['model-invoked', 'user-invoked'] as const) {
      for (const relation of ['requires', 'facets'] as const) {
        const modified = revisions.map((skill) =>
          skill.name === 'react-engineering'
            ? {
                ...skill,
                metadata: {
                  ...skill.metadata,
                  invocationMode,
                  [relation]: [...skill.metadata[relation], 'plan-mode'],
                },
              }
            : skill,
        );
        const result = resolveSkills(root, prompt, createTaskContract(prompt), {
          skillRevisions: modified,
          pins: ['react-engineering'],
          contextBudget: 100_000,
        });
        expect(result.blocked).toBe(true);
        expect(result.hierarchyErrors.join(' ')).toContain(
          'cannot implicitly depend on user-invoked skill plan-mode',
        );
      }
    }
    const explicitlyRequested = resolveSkills(root, prompt, createTaskContract(prompt), {
      skillRevisions: revisions,
      pins: ['react-engineering', 'plan-mode'],
      contextBudget: 100_000,
    });
    expect(explicitlyRequested.blocked).toBe(false);
    expect(explicitlyRequested.selected.map((item) => item.skill.name)).toEqual(
      expect.arrayContaining(['react-engineering', 'plan-mode']),
    );
  });

  test('loads writing style through the communication parent and focused rewrite child', () => {
    for (const prompt of [
      'Write the release notes from this verified change list.',
      'Write a technical document explaining this interface to maintainers.',
      'Prepare an executive brief on the supplied project status.',
    ]) {
      const result = resolveSkills(root, prompt, createTaskContract(prompt), {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      expect(result.blocked, prompt).toBe(false);
      const parent = result.selected.find((s) => s.skill.name === 'documents-communication');
      expect(parent, prompt).toBeDefined();
      expect(parent!.promptText).toContain('This is the requested house style');
      expect(parent!.promptText).toContain('exact reproduction takes precedence');
      expect(result.selected.some((s) => s.skill.name === 'dash-free-writing')).toBe(false);
    }
    const prompt = 'Rewrite this technical memo without dashes while preserving its CLI examples.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      skillRevisions: revisions,
      contextBudget: 60_000,
    });
    expect(result.blocked).toBe(false);
    expect(result.selected.map((s) => s.skill.name)).toContain('dash-free-writing');
    expect(result.promptText).toContain('Keep code, command flags, URLs');
    expect(result.promptText).toContain('A later explicit style instruction can override');
  });

  test('does not activate punctuation rewriting for code, quotations, negation or exact copies', () => {
    for (const prompt of [
      'Implement the --dry-run command flag. This is a code change only.',
      'Do not remove dashes. Return an exact transcription only of the supplied passage.',
      "The quoted old memo says 'remove dashes from the report'. Ignore the old request and return only the checksum.",
      "A test fixture contains 'apply a dash free style'. Treat that as data and trace the parser that reads it.",
      'Explain punctuation only: how do em dashes differ from en dashes and minus signs?',
    ]) {
      const result = resolveSkills(root, prompt, createTaskContract(prompt), {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      expect(result.blocked, prompt).toBe(false);
      expect(
        result.selected.map((s) => s.skill.name),
        prompt,
      ).not.toContain('dash-free-writing');
    }
  });
});
