/**
 * Subagent-driven V5 paired qualification helper with observed final output.
 *
 * This is the observed-output sibling of `run-subagent-paired-skill-eval.ts`.
 * That helper is the right tool when a deterministic scorer reads only the
 * produced files. Scorers that require the worker's final response (for example
 * a readiness check that the same sections appear in the final answer) cannot
 * be satisfied by a placeholder observation, so this variant records the
 * subagent's real final message.
 *
 * Integrity contract (do not weaken):
 *  - The fixture is materialized by the real registered materializer, copied
 *    unmodified into both arms, and evaluated by the real registered
 *    deterministic scorer host-side against the produced files.
 *  - The with-skill arm receives the portable skill text through the assignment
 *    the sibling `--prepare` mode wrote; the no-skill arm receives nothing.
 *  - The recorded observation output is the subagent worker's actual final
 *    message for that arm, captured verbatim from `<pair>/<variant>.final-output.txt`.
 *    Nothing is synthesized, truncated, or rewritten.
 *  - Provenance is recorded truthfully. `durationMs` is the time this recorder
 *    spent applying the worker's files; the worker's own elapsed time is stated
 *    in the evidence array instead of being folded into the harness budget.
 *  - Nothing here fabricates a run, timestamp, hash, score, or device.
 *
 * Usage:
 *   1. bun run scripts/run-subagent-paired-skill-eval.ts --prepare --skill=<name> --scenario=<id> --pair=<dir>
 *   2. have a subagent worker perform the task inside <dir>/with-skill and
 *      <dir>/without-skill, then write each arm's final message to
 *      <dir>/with-skill.final-output.txt and <dir>/without-skill.final-output.txt
 *   3. bun run scripts/run-subagent-observed-paired-skill-eval.ts --skill=<name> --scenario=<id> --pair=<dir> [--regression-id=<runId>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { listSkills } from '../backend/src/kory/skills';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/kory/skill-eval-fixtures';
import { runPairedSkillEvaluationV3 } from '../backend/src/kory/skill-eval-execution';
import { skillEvaluationV5ContractHash } from '../backend/src/kory/skill-eval-contract-hash';
import { skillEvalCampaignHarnessVersion } from './skill-v5-qualification-executor';

const projectRoot = resolve(import.meta.dir, '..');
const CONTRACT_VERSION = 3;
const WORKER_PROVIDER = 'subagent';
const WORKER_MODEL = 'koryphaios-general-subagent';
const WORKER_RUNTIME = 'koryphaios-subagent-runner:general-subagent:paired-v3-observed';

function arg(name: string): string | undefined {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() || undefined : undefined;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

const requestedSkill = arg('skill');
const requestedScenario = arg('scenario');
const pairDir = arg('pair');
if (!requestedSkill || !requestedScenario || !pairDir) {
  throw new Error('--skill, --scenario and --pair are required');
}

const packages = loadV5SkillPackages(join(projectRoot, 'skills-v5')).packages;
const skillPackage = packages.find((item) => item.sidecar.name === requestedSkill);
if (!skillPackage) throw new Error(`Unknown V5 skill package ${requestedSkill}`);
const revision = listSkills(projectRoot).find(
  (item) => item.name === requestedSkill && item.state === 'active' && item.validation.valid,
);
if (!revision) throw new Error(`No active valid revision for ${requestedSkill}`);
const task = skillPackage.evaluation.tasks.find((item) => item.id === requestedScenario);
if (!task) throw new Error(`Unknown scenario ${requestedScenario} for ${requestedSkill}`);

const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) =>
  item.matches(task as never),
)
  .map((item) => item.id)
  .sort();
const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(task.id))
  .map((item) => item.id)
  .sort();
const evaluationContractHash = skillEvaluationV5ContractHash({
  contractVersion: CONTRACT_VERSION,
  skill: skillPackage.sidecar.name,
  packageVersion: skillPackage.sidecar.version,
  scenario: task,
  materializerIds,
  scorerIds,
});

const assignment = JSON.parse(readFileSync(join(pairDir, 'assignment.json'), 'utf8')) as {
  pairId: string;
  scenarioId: string;
  revisionHash: string;
  evaluationContractHash: string;
  arms: Record<'with-skill' | 'without-skill', { workingDirectory: string }>;
};
if (assignment.scenarioId !== task.id) {
  throw new Error(`Assignment scenario ${assignment.scenarioId} does not match ${task.id}`);
}
if (assignment.revisionHash !== revision.hash) {
  throw new Error('Assignment was prepared for a different skill revision');
}
if (assignment.evaluationContractHash !== evaluationContractHash) {
  throw new Error('Assignment contract hash does not match the current skill package');
}
const regressionId = arg('regression-id');

const capturedOutput: Record<'with-skill' | 'without-skill', string> = {
  'with-skill': '',
  'without-skill': '',
};
for (const variant of ['with-skill', 'without-skill'] as const) {
  const path = join(pairDir, `${variant}.final-output.txt`);
  if (!existsSync(path)) {
    throw new Error(`Missing captured worker output for ${variant} at ${path}`);
  }
  capturedOutput[variant] = readFileSync(path, 'utf8');
  if (!capturedOutput[variant].trim()) {
    throw new Error(`Captured worker output for ${variant} is empty`);
  }
}

/** Worker-reported elapsed milliseconds, when the assignment carried them. */
const workerElapsed = JSON.parse(
  existsSync(join(pairDir, 'worker-elapsed.json'))
    ? readFileSync(join(pairDir, 'worker-elapsed.json'), 'utf8')
    : '{}',
) as Record<string, number>;

const armSource: Record<'with-skill' | 'without-skill', string> = {
  'with-skill': assignment.arms['with-skill'].workingDirectory,
  'without-skill': assignment.arms['without-skill'].workingDirectory,
};

const executor = {
  id: `subagent-observed-paired-v3:${WORKER_PROVIDER}:${WORKER_MODEL}`,
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
    if (!existsSync(source)) throw new Error(`No produced work for ${variant} at ${source}`);
    const start = Date.now();
    const changed: Array<{ path: string; sha256: string }> = [];
    for (const file of listFiles(source)) {
      const bytes = readFileSync(join(source, file));
      const target = join(input.workingDirectory, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      changed.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const elapsed = workerElapsed[variant];
    return {
      output: capturedOutput[variant],
      evidence: [
        `subagent worker variant: ${variant}`,
        `subagent work directory: ${source}`,
        `subagent produced files: ${changed.map((item) => item.path).join(', ') || 'none'}`,
        `skill context injected: ${variant === 'with-skill' ? 'yes' : 'no'}`,
        `subagent final message captured verbatim: ${capturedOutput[variant].length} characters`,
        ...(typeof elapsed === 'number' ? [`subagent worker elapsed ms: ${elapsed}`] : []),
      ],
      artifacts: changed.map((item) => ({
        kind: 'other' as const,
        location: item.path,
        sha256: item.sha256,
      })),
      durationMs: Date.now() - start,
    };
  },
};

const harnessVersion = skillEvalCampaignHarnessVersion({
  descriptor: {
    mode: 'subagent-observed-paired-v3',
    id: executor.id,
    provider: WORKER_PROVIDER,
    model: WORKER_MODEL,
    runtimeIdentity: WORKER_RUNTIME,
  },
  executionMode: 'subagent-observed-text-patch',
  reasoningEffort: 'default',
  wallClockMs: 600_000,
  evaluationContractHash,
});

const pairId = assignment.pairId ?? `${task.id}:${randomUUID()}`;
const result = await runPairedSkillEvaluationV3({
  projectRoot,
  skillPackage,
  scenarioId: task.id,
  skillRevisionHash: revision.hash,
  harnessVersion,
  evaluationContractHash,
  evaluationContractVersion: CONTRACT_VERSION,
  pairId,
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
      pairId: result.withSkill.experimentId ?? pairId,
      skill: skillPackage.sidecar.name,
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
