import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  integrationFaultScenario1Readiness,
  integrationFaultScenario2Readiness,
  runIntegrationFaultScenario1Runtime,
  runIntegrationFaultScenario2Runtime,
} from './skill-eval-integration-fault-runtime';

const POSTGRES_ROLLBACK = 'integration-fault-testing-full-task-1';
const HTTP_AMBIGUOUS_COMMIT = 'integration-fault-testing-full-task-2';

function textFile(root: string, path: string): string {
  try {
    return readFileSync(join(root, path), 'utf8').toLowerCase();
  } catch {
    return '';
  }
}

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

const postgresRollbackMaterializer: SkillEvalFixtureMaterializer = {
  id: 'integration-fault-testing/postgres-rollback-toxiproxy@1',
  realRuntime: true,
  get readinessBlockers() {
    return integrationFaultScenario1Readiness();
  },
  matches: (scenario) => scenario.id === POSTGRES_ROLLBACK,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-eval-integration-fault-postgres'),
    );
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# PostgreSQL transaction fault-injection fixture

Add an integration fault test in \`tests/integration-fault.test.ts\` for a disposable PostgreSQL 17.5 service reached through Toxiproxy 2.12.0. The controlled reset must occur after at least one child insert has executed and before COMMIT. Assert the caller sees a dependency failure, then inspect PostgreSQL through an independent connection and prove both header and child counts are zero. Remove the toxic, wait for actual PostgreSQL readiness, rerun the same import, and prove exactly one complete import with the expected child count is durable.

Write \`.kory-eval/integration-fault-scenario-1.json\` with the PostgreSQL and Toxiproxy identities, exact fault placement/direction, caller-visible failure, independent failed-attempt row counts, toxic removal/readiness evidence, recovered row counts, and cleanup/recovery behavior. Keep bounded retry behavior explicit and keep this at the service/database integration boundary.
`,
    );
  },
};

const postgresRollbackScorer: SkillEvalDeterministicScorer = {
  id: 'integration-fault-testing/postgres-rollback-toxiproxy-scorer@1',
  scenarioIds: [POSTGRES_ROLLBACK],
  score: ({ workingDirectory }) => {
    const test = textFile(workingDirectory, 'tests/integration-fault.test.ts');
    const report = artifactText(workingDirectory, '.kory-eval/integration-fault-scenario-1.json');
    const structure =
      /postgres/u.test(test) &&
      /toxiproxy|toxic/u.test(test) &&
      /reset|connection.*(cut|drop|fail)/u.test(test) &&
      /insert/u.test(test) &&
      /commit/u.test(test) &&
      /rollback|zero|count/u.test(test) &&
      /recover|read(y|iness)|remove.*toxic/u.test(test);
    const evidence =
      Boolean(report.artifact) &&
      /postgres/u.test(report.text) &&
      /toxiproxy|2\.12\.0/u.test(report.text) &&
      /after.*insert|before.*commit|pre.?commit/u.test(report.text) &&
      /caller|client/u.test(report.text) &&
      /fail|reset|uncertain/u.test(report.text) &&
      /header/u.test(report.text) &&
      /child/u.test(report.text) &&
      /zero|0/u.test(report.text) &&
      /recover|read(y|iness)/u.test(report.text) &&
      /exactly.?one|count.?1|one complete/u.test(report.text);
    const runtime =
      structure && evidence
        ? runIntegrationFaultScenario1Runtime()
        : {
            passed: false,
            evidence: 'runtime skipped because fault-test or evidence contract failed',
          };
    const passed = structure && evidence && runtime.passed;
    return {
      passed,
      quality: passed ? 1 : structure && evidence ? 0.8 : structure ? 0.6 : 0,
      verification: runtime.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        runtime.evidence,
        `PostgreSQL/Toxiproxy test structure: ${structure ? 'pass' : 'fail'}`,
        `rollback/recovery evidence artifact: ${evidence ? 'present' : 'missing'}`,
      ],
    };
  },
};

const httpAmbiguousCommitMaterializer: SkillEvalFixtureMaterializer = {
  id: 'integration-fault-testing/http-ambiguous-commit-toxiproxy@1',
  realRuntime: true,
  get readinessBlockers() {
    return integrationFaultScenario2Readiness();
  },
  matches: (scenario) => scenario.id === HTTP_AMBIGUOUS_COMMIT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-integration-fault-http'));
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# HTTP ambiguous-commit fault-injection fixture

Add an integration fault test in \`tests/integration-fault.test.ts\` for a protocol-faithful synthetic POST /dispatch dependency reached through Toxiproxy 2.12.0. Make the dependency commit a dispatch for a stable idempotency key before the response path is cut. The first caller result must remain uncertain rather than being reported as confirmed success. Inspect dependency state independently and prove one dispatch exists, remove the toxic, replay the same logical operation with the same key and prove the count remains one, then send a fresh key and prove useful work succeeds after recovery.

Write \`.kory-eval/integration-fault-scenario-2.json\` with proxy/dependency identities, commit-before-response-cut evidence, bounded retry policy, stable key, caller-visible uncertain result, independent durable count before and after same-key replay, fresh-key success, and cleanup/recovery evidence.
`,
    );
  },
};

const httpAmbiguousCommitScorer: SkillEvalDeterministicScorer = {
  id: 'integration-fault-testing/http-ambiguous-commit-toxiproxy-scorer@1',
  scenarioIds: [HTTP_AMBIGUOUS_COMMIT],
  score: ({ workingDirectory }) => {
    const test = textFile(workingDirectory, 'tests/integration-fault.test.ts');
    const report = artifactText(workingDirectory, '.kory-eval/integration-fault-scenario-2.json');
    const structure =
      /dispatch/u.test(test) &&
      /idempoten/u.test(test) &&
      /toxiproxy|toxic/u.test(test) &&
      /commit/u.test(test) &&
      /response/u.test(test) &&
      /uncertain|timeout|reset/u.test(test) &&
      /replay|same.*key/u.test(test) &&
      /fresh.*key|new.*key/u.test(test);
    const evidence =
      Boolean(report.artifact) &&
      /toxiproxy|2\.12\.0/u.test(report.text) &&
      /commit/u.test(report.text) &&
      /response/u.test(report.text) &&
      /uncertain|missing response|reset|timeout/u.test(report.text) &&
      /idempoten|same.?key|stable.?key/u.test(report.text) &&
      /count.?1|exactly.?one|one dispatch/u.test(report.text) &&
      /fresh.?key|new.?key/u.test(report.text) &&
      /recover|remove.*toxic/u.test(report.text) &&
      /bound(ed)? retry|max retry|retry budget/u.test(report.text);
    const runtime =
      structure && evidence
        ? runIntegrationFaultScenario2Runtime()
        : {
            passed: false,
            evidence: 'runtime skipped because ambiguous-commit test or evidence contract failed',
          };
    const passed = structure && evidence && runtime.passed;
    return {
      passed,
      quality: passed ? 1 : structure && evidence ? 0.8 : structure ? 0.6 : 0,
      verification: runtime.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        runtime.evidence,
        `HTTP/Toxiproxy ambiguous-commit structure: ${structure ? 'pass' : 'fail'}`,
        `idempotency/recovery evidence artifact: ${evidence ? 'present' : 'missing'}`,
      ],
    };
  },
};

export const INTEGRATION_FAULT_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  postgresRollbackMaterializer,
  httpAmbiguousCommitMaterializer,
];

export const INTEGRATION_FAULT_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  postgresRollbackScorer,
  httpAmbiguousCommitScorer,
];
