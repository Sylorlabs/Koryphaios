import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

export const COMMUNICATION_SCENARIOS = [
  'documents-communication-factual-brief',
  'executive-communication-risk-update',
] as const;

const sources = {
  'documents-communication-factual-brief':
    '# Status report\n\nThe migration completed for 84 of 100 accounts. Sixteen accounts remain pending verification. The root cause is unknown. Do not claim completion.\n',
  'executive-communication-risk-update':
    '# Executive update\n\nThe launch date is not approved. Security review is incomplete. The team expects a decision after review, but approval is not guaranteed.\n',
} as const;

function readFile(root: string, name: string) {
  try {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 128000) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function communicationPacket(id: string) {
  if (!COMMUNICATION_SCENARIOS.includes(id as never)) throw new Error(`Unknown scenario ${id}`);
  return { id, source: sources[id as keyof typeof sources] };
}

export function scoreCommunication(root: string, id: string): SkillEvalDeterministicScore {
  const packet = communicationPacket(id);
  const source = readFile(root, 'source.md');
  const revised = readFile(root, 'revised.md');
  const review = readFile(root, 'review.md');
  if (source !== packet.source || revised === null || review === null)
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
      evidence: ['Required artifacts missing or modified.'],
    };
  const checks =
    id === COMMUNICATION_SCENARIOS[0]
      ? {
          'account count preserved': /84 of 100|84\/100/.test(revised),
          'pending accounts preserved': /16|sixteen/.test(revised),
          'uncertainty preserved': /unknown|uncertain|not known/.test(revised),
          'no false completion': !/all accounts complete|migration completed for all/i.test(
            revised,
          ),
        }
      : {
          'approval uncertainty preserved': /not approved|not guaranteed|pending approval/i.test(
            revised,
          ),
          'security risk preserved': /security review|security/i.test(revised),
          'no invented certainty': !/approved|guaranteed|definitely launch/i.test(revised),
        };
  const passed = Object.values(checks).every(Boolean);
  writeFixtureFile(
    root,
    '.kory-eval/communication-evidence.json',
    JSON.stringify(
      {
        checks,
        artifactSha256: createHash('sha256').update(revised).digest('hex'),
        blindSemanticStatus: 'not-run',
      },
      null,
      2,
    ) + '\n',
  );
  return {
    passed,
    quality: Object.values(checks).filter(Boolean).length / Object.keys(checks).length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: Object.entries(checks).map(([k, v]) => `${k}: ${v ? 'pass' : 'fail'}`),
  };
}

export const COMMUNICATION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  COMMUNICATION_SCENARIOS.map((id) => ({
    id: `${id}/artifact@1`,
    matches: (scenario) => scenario.id === id,
    materialize: (root) => {
      writeFixtureFile(root, 'source.md', communicationPacket(id).source);
      writeFixtureFile(root, 'revised.md', communicationPacket(id).source);
      writeFixtureFile(root, 'review.md', 'Review artifact present.');
    },
  }));

export const COMMUNICATION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  COMMUNICATION_SCENARIOS.map((id) => ({
    id: `${id}/artifact-scorer@1`,
    scenarioIds: [id],
    score: ({ workingDirectory }) => scoreCommunication(workingDirectory, id),
  }));
