import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS,
  AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-auth-secrets-security-fixtures';
import {
  PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
} from '../skill-eval-privacy-web-device-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const materializers = [
  ...AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS,
  ...PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
];
const scorers = [
  ...AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS,
  ...PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
];
for (const [skill, fixed, corpus] of [
  ['secure-authentication', 'src/auth-policy.ts', 'evidence/auth-corpus.json'],
  ['oauth-oidc', 'src/oauth-policy.ts', 'evidence/oauth-corpus.json'],
  ['secrets-key-management', 'src/secret-policy.ts', 'evidence/secret-corpus.json'],
  ['web-security', 'src/web-policy.ts', 'evidence/web-corpus.json'],
] as const) {
  for (const number of [1, 2]) {
    test(`${skill}/${number}: omitted candidate report fails task; immutable deletion or symlink fails integrity`, async () => {
      const scenario = { id: `${skill}-full-task-${number}` } as never;
      const root = mkdtempSync(join(tmpdir(), 'kory-fixed-corpus-'));
      roots.push(root);
      const materializer = materializers.find((item) => item.matches(scenario))!;
      const scorer = scorers.find((item) =>
        item.scenarioIds.includes((scenario as { id: string }).id),
      )!;
      await materializer.materialize(root, scenario);
      const score = () =>
        scorer.score({
          scenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });
      const absent = await score();
      expect(absent.passed).toBe(false);
      expect(absent.integrityFailure).toBe(false);
      const original = readFileSync(join(root, fixed), 'utf8');
      rmSync(join(root, fixed));
      expect((await score()).integrityFailure).toBe(true);
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, original);
      symlinkSync(outside, join(root, fixed));
      expect((await score()).integrityFailure).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe(original);
      rmSync(join(root, fixed));
      writeFileSync(join(root, fixed), original);
      if (existsSync(join(root, corpus))) {
        rmSync(join(root, corpus));
        const missingCorpus = await score();
        expect(missingCorpus.passed).toBe(false);
        expect(missingCorpus.integrityFailure).toBe(true);
      }
    });
  }
}
