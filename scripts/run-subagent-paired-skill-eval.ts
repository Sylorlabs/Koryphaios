/**
 * Subagent-driven V5 paired qualification helper.
 *
 * Purpose: produce genuine paired (with-skill vs no-skill) full-task evidence
 * for V5 skill packages using this harness's own subagents as the worker, when
 * no qualified external executor is reachable.
 *
 * Integrity contract (do not weaken):
 *  - The fixture is materialized by the real registered materializer.
 *  - The result is evaluated by the real registered deterministic scorer, run
 *    host-side against the produced files.
 *  - The with-skill arm receives the portable skill text; the no-skill arm
 *    receives null. Nothing else differs between arms.
 *  - Provenance is recorded truthfully (provider/model identify the subagent
 *    worker). No provider isolation is claimed that was not measured, and no
 *    quarantined harness token is used.
 *  - Nothing here fabricates a run, timestamp, hash, score, or device.
 *
 * Modes:
 *  --prepare --skill=<name> --scenario=<id> --pair=<dir>
 *      Materializes both arms under <dir> and writes assignment.json so a
 *      subagent can actually do the work inside each arm directory.
 *  --record --skill=<name> --scenario=<id> --pair=<dir> [--regression-id=<runId>]
 *      Applies the work produced in <dir>/with-skill and <dir>/without-skill,
 *      runs the real paired evaluation with the real scorer, and persists.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { listSkills } from '../backend/src/kory/skills';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/eval/skills/skill-eval-fixtures';
import { runPairedSkillEvaluationV3 } from '../backend/src/eval/skills/skill-eval-execution';
import { listOpenSkillRegressionSources } from '../backend/src/kory/skill-evaluations';
import { skillEvaluationV5ContractHash } from '../backend/src/eval/skills/skill-eval-contract-hash';
import { skillEvalCampaignHarnessVersion } from './skill-v5-qualification-executor';
import { randomUUID } from 'node:crypto';

const projectRoot = resolve(import.meta.dir, '..');
const CONTRACT_VERSION = 3;

function arg(name: string): string | undefined {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() || undefined : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const WORKER_PROVIDER = 'subagent';
const WORKER_MODEL = 'koryphaios-general-subagent';
const WORKER_RUNTIME = 'koryphaios-subagent-runner:general-subagent:paired-v3';

function loadPackage(skill: string, scenarioId: string) {
  const packages = loadV5SkillPackages(join(projectRoot, 'skills-v5')).packages;
  const skillPackage = packages.find((item) => item.sidecar.name === skill);
  if (!skillPackage) throw new Error(`Unknown V5 skill package ${skill}`);
  const revision = listSkills(projectRoot).find(
    (item) => item.name === skill && item.state === 'active' && item.validation.valid,
  );
  if (!revision) throw new Error(`No active valid revision for ${skill}`);
  const task = skillPackage.evaluation.tasks.find((item) => item.id === scenarioId);
  if (!task) throw new Error(`Unknown scenario ${scenarioId} for ${skill}`);
  return { skillPackage, revision, task };
}

const requestedSkill = arg('skill');
const requestedScenario = arg('scenario');
if (!requestedSkill || !requestedScenario) {
  throw new Error('--skill and --scenario are required');
}

function contractHashFor(skillPackage: ReturnType<typeof loadPackage>['skillPackage'], task: ReturnType<typeof loadPackage>['task']) {
  const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) =>
    item.matches(task as never),
  )
    .map((item) => item.id)
    .sort();
  const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(task.id))
    .map((item) => item.id)
    .sort();
  return skillEvaluationV5ContractHash({
    contractVersion: CONTRACT_VERSION,
    skill: skillPackage.sidecar.name,
    packageVersion: skillPackage.sidecar.version,
    scenario: task,
    materializerIds,
    scorerIds,
  });
}

/** Build/tool scratch that must never be transplanted into a fresh fixture. */
const EXCLUDED_DIRECTORIES = new Set([
  'build',
  '.gradle',
  '.kotlin',
  '__pycache__',
  '.git',
  'node_modules',
]);
const EXCLUDED_FILES = new Set(['local.properties', '.DS_Store']);

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || EXCLUDED_FILES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

function portableSkillText(skillPackage: ReturnType<typeof loadPackage>['skillPackage']): string {
  return skillPackage.instructions;
}

async function prepareMode(): Promise<void> {
  const skill = arg('skill');
  const pairDir = arg('pair');
  if (!skill || !pairDir) throw new Error('--prepare requires --skill and --pair');
  const { skillPackage, revision, task } = loadPackage(requestedSkill, requestedScenario);
  const evaluationContractHash = contractHashFor(skillPackage, task);
  const base = join(pairDir, 'base');
  const withDir = join(pairDir, 'with-skill');
  const withoutDir = join(pairDir, 'without-skill');
  for (const dir of [base, withDir, withoutDir]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  const materializer = BUILTIN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(task as never));
  if (!materializer) throw new Error(`No materializer for ${task.id}`);
  materializer.materialize(base, task);
  cpSync(base, withDir, { recursive: true });
  cpSync(base, withoutDir, { recursive: true });
  const pairId = `${task.id}:${randomUUID()}`;
  const assignment = {
    schemaVersion: 1,
    pairId,
    skill,
    scenarioId: task.id,
    revisionHash: revision.hash,
    packageVersion: skillPackage.sidecar.version,
    suiteId: `${skill}:v${skillPackage.sidecar.version}:held-out`,
    evaluationContractHash,
    evaluationContractVersion: CONTRACT_VERSION,
    taskPrompt: task.prompt,
    arms: {
      'with-skill': {
        workingDirectory: withDir,
        baseFiles: listFiles(base),
        skillContextInjected: true,
      },
      'without-skill': {
        workingDirectory: withoutDir,
        baseFiles: listFiles(base),
        skillContextInjected: false,
      },
    },
  };
  writeFileSync(join(pairDir, 'assignment.json'), `${JSON.stringify(assignment, null, 2)}\n`);
  writeFileSync(join(pairDir, 'with-skill.skill-context.md'), portableSkillText(skillPackage));
  console.log(
    JSON.stringify(
      {
        prepared: true,
        pairId,
        skill,
        scenarioId: task.id,
        revisionHash: revision.hash,
        evaluationContractHash,
        withSkillWorkingDirectory: withDir,
        withoutSkillWorkingDirectory: withoutDir,
        withSkillContextFile: join(pairDir, 'with-skill.skill-context.md'),
        baseFiles: assignment.arms['with-skill'].baseFiles,
        openRegressions: listOpenSkillRegressionSources(projectRoot, skill, revision.hash)
          .filter((run) => (run.scenarioId ?? run.caseId) === task.id)
          .map((run) => run.id),
      },
      null,
      2,
    ),
  );
}

async function recordMode(): Promise<void> {
  const skill = arg('skill');
  const pairDir = arg('pair');
  if (!skill || !pairDir) throw new Error('--record requires --skill and --pair');
  const { skillPackage, revision, task } = loadPackage(requestedSkill, requestedScenario);
  const evaluationContractHash = contractHashFor(skillPackage, task);
  const assignment = JSON.parse(readFileSync(join(pairDir, 'assignment.json'), 'utf8')) as {
    pairId: string;
    arms: Record<'with-skill' | 'without-skill', { workingDirectory: string }>;
  };
  if (assignment.scenarioId !== task.id) {
    throw new Error(`Assignment scenario ${assignment.scenarioId} does not match ${task.id}`);
  }
  const regressionId = arg('regression-id');

  const armSource: Record<'with-skill' | 'without-skill', string> = {
    'with-skill': assignment.arms['with-skill'].workingDirectory,
    'without-skill': assignment.arms['without-skill'].workingDirectory,
  };
  const startedAt = new Map<string, number>();
  const applied = new Set<string>();

  const executor = {
    id: `subagent-paired-v3:${WORKER_PROVIDER}:${WORKER_MODEL}`,
    subject: 'other' as const,
    provider: WORKER_PROVIDER,
    model: WORKER_MODEL,
    runtimeIdentity: WORKER_RUNTIME,
    tools: [] as string[],
    budget: { wallClockMs: 600_000 },
    execute: async (input: {
      experiment: { variant?: string };
      scenario: unknown;
      workingDirectory: string;
      taskPrompt: string;
      skillContext: string | null;
    }): Promise<{
      output: string;
      evidence: string[];
      artifacts: Array<{ kind: 'other'; location: string; sha256: string }>;
      durationMs: number;
    }> => {
      const variant = input.experiment?.variant === 'without-skill' ? 'without-skill' : 'with-skill';
      const source = armSource[variant];
      if (!existsSync(source)) {
        throw new Error(`No produced work for ${variant} at ${source}`);
      }
      const start = Date.now();
      startedAt.set(variant, start);
      const files = listFiles(source);
      const changed: Array<{ path: string; sha256: string }> = [];
      for (const file of files) {
        if (applied.has(`${variant}:${file}`)) continue;
        applied.add(`${variant}:${file}`);
        const bytes = readFileSync(join(source, file));
        const target = join(input.workingDirectory, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        changed.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      return {
        output: `Subagent worker (${WORKER_PROVIDER}/${WORKER_MODEL}) completed ${variant} arm in ${source}; ${changed.length} file(s) present at handoff.`,
        evidence: [
          `subagent worker variant: ${variant}`,
          `subagent work directory: ${source}`,
          `subagent produced files: ${changed.map((item) => item.path).join(', ') || 'none'}`,
          `skill context injected: ${variant === 'with-skill' ? 'yes' : 'no'}`,
        ],
        artifacts: changed.map((item) => ({ kind: 'other' as const, location: item.path, sha256: item.sha256 })),
        durationMs: Date.now() - start,
      };
    },
  };

  const harnessVersion = skillEvalCampaignHarnessVersion({
    descriptor: {
      mode: 'subagent-paired-v3',
      id: executor.id,
      provider: WORKER_PROVIDER,
      model: WORKER_MODEL,
      runtimeIdentity: WORKER_RUNTIME,
    },
    executionMode: 'subagent-text-patch',
    reasoningEffort: 'default',
    wallClockMs: 600_000,
    evaluationContractHash,
  });

  const result = await runPairedSkillEvaluationV3({
    projectRoot,
    skillPackage,
    scenarioId: task.id,
    skillRevisionHash: revision.hash,
    harnessVersion,
    evaluationContractHash,
    evaluationContractVersion: CONTRACT_VERSION,
    regressionId,
    executor: executor as never,
    materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
    scorers: BUILTIN_SKILL_EVAL_SCORERS,
    persist: true,
  });

  console.log(
    JSON.stringify(
      {
        recorded: true,
        pairId: result.withSkill.experimentId ?? assignment.pairId,
        skill,
        scenarioId: task.id,
        regressionId: regressionId ?? null,
        provider: WORKER_PROVIDER,
        model: WORKER_MODEL,
        withSkill: {
          passed: result.withSkill.score?.passed ?? null,
          quality: result.withSkill.score?.quality ?? null,
          verification: result.withSkill.score?.verification ?? null,
          integrityFailure: result.withSkill.score?.integrityFailure ?? null,
          infrastructureFailure: result.withSkill.observation.infrastructureFailure ?? null,
          evidence: result.withSkill.score?.evidence ?? null,
        },
        withoutSkill: {
          passed: result.withoutSkill.score?.passed ?? null,
          quality: result.withoutSkill.score?.quality ?? null,
          verification: result.withoutSkill.score?.verification ?? null,
          integrityFailure: result.withoutSkill.score?.integrityFailure ?? null,
          infrastructureFailure: result.withoutSkill.observation.infrastructureFailure ?? null,
          evidence: result.withoutSkill.score?.evidence ?? null,
        },
      },
      null,
      2,
    ),
  );
}

if (flag('prepare')) {
  await prepareMode();
} else if (flag('record')) {
  await recordMode();
} else {
  throw new Error('Choose --prepare or --record');
}
