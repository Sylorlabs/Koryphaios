import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  GO_CONTEXT_CONTROL,
  GO_CONTEXT_SCENARIO,
  GO_NIL_CONTROL,
  GO_NIL_SCENARIO,
  V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS,
  goHostReadiness,
} from '../skill-eval-v5-language-host-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const goPackage = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === 'go-engineering',
)!;
const nilScenario = buildSkillEvalSuiteV3(goPackage).scenarios.find(
  (item) => item.id === GO_NIL_SCENARIO,
)!;
const contextScenario = buildSkillEvalSuiteV3(goPackage).scenarios.find(
  (item) => item.id === GO_CONTEXT_SCENARIO,
)!;
const prerequisites = goHostReadiness();
const runtimeTest = test.skipIf(prerequisites.length > 0);

describe('actual Go host evaluators', () => {
  test('Go scorer generations advance together when their shared runtime contract changes', () => {
    const ids = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.filter(
      (item) =>
        item.scenarioIds.includes(GO_CONTEXT_SCENARIO) ||
        item.scenarioIds.includes(GO_NIL_SCENARIO),
    ).map((item) => item.id);

    expect(ids).toEqual([
      'go-engineering/actual-go-context-goroutines-scorer@5',
      'go-engineering/actual-go-typed-nil-scorer@5',
    ]);
  });

  test('context fixture rejects only evaluator-owned immutable inputs and reports each changed path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-go-immutable-boundary-'));
    roots.push(root);
    const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(contextScenario),
    )!;
    const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(contextScenario.id),
    )!;
    expect(materializer.id).toBe('go-engineering/actual-go-context-goroutines@3');
    await materializer.materialize(root, contextScenario);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
      'Evaluator-owned immutable inputs',
    );

    const score = () =>
      scorer.score({
        scenario: contextScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });

    // Repairing the broken source and adding regressions must be allowed.
    writeFixtureFile(root, 'batch/batch.go', GO_CONTEXT_CONTROL);
    for (const path of [
      'README.md',
      'go.mod',
      '.kory-runtime/go',
      '.kory-runtime/runtime.json',
    ]) {
      const original = readFileSync(join(root, path), 'utf8');
      writeFixtureFile(root, path, `${original}\nchanged by candidate\n`);
      const changed = await score();
      expect(changed.passed).toBe(false);
      expect(changed.integrityFailure).toBe(true);
      expect(changed.evidence).toEqual([`Immutable Go runtime/contract input changed: ${path}.`]);
      writeFixtureFile(root, path, original);
    }

    const originalGoMod = readFileSync(join(root, 'go.mod'), 'utf8');
    rmSync(join(root, 'go.mod'));
    const missing = await score();
    expect(missing.integrityFailure).toBe(true);
    expect(missing.evidence[0]).toContain('go.mod');
    writeFixtureFile(root, 'go.mod', originalGoMod);

    rmSync(join(root, 'README.md'));
    symlinkSync(join(root, 'batch/batch.go'), join(root, 'README.md'));
    const unsafe = await score();
    expect(unsafe.integrityFailure).toBe(true);
    expect(unsafe.evidence[0]).toContain('README.md');
    expect(readdirSync(join(root, 'batch')).filter((name) => name.startsWith('kory_hidden_'))).toEqual([]);
  });

  runtimeTest(
    'context scorer runs hidden cancellation tests and requires candidate-authored regressions',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-go-context-scorer-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(contextScenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(contextScenario.id),
      )!;
      const score = () =>
        scorer.score({
          scenario: contextScenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });

      await materializer.materialize(root, contextScenario);
      const leakingStarter = readFileSync(join(root, 'batch/batch.go'), 'utf8');
      writeFixtureFile(root, 'batch/batch.go', GO_CONTEXT_CONTROL);

      // Evaluator tests run, but cannot satisfy the candidate-regression gate.
      const withoutCandidateRegressions = await score();
      expect(withoutCandidateRegressions.passed).toBe(false);
      expect(withoutCandidateRegressions.evidence[0]).toContain('race/runtime checks: pass');
      expect(withoutCandidateRegressions.evidence[1]).toBe(
        'candidate regression coverage: missing',
      );

      writeFixtureFile(
        root,
        'batch/batch_test.go',
        `package batch
import (
    "context"
    "testing"
    "time"
)
type testClient struct{}
func (testClient) Fetch(ctx context.Context, id string) (string, error) {
    if id == "slow" { <-ctx.Done(); return "", ctx.Err() }
    return "v:" + id, nil
}
func TestSuccessAndSlowDependencyCancellation(t *testing.T) {
    got := FetchBatch(context.Background(), testClient{}, []string{"a", "b"}, 2)
    if got.Results["a"] != "v:a" || got.Results["b"] != "v:b" { t.Fatalf("success: %#v", got) }
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
    defer cancel()
    partial := FetchBatch(ctx, testClient{}, []string{"slow"}, 1)
    if len(partial.Results) != 0 { t.Fatalf("cancellation: %#v", partial) }
}
`,
      );
      const candidateReservedPath = 'batch/kory_hidden_test.go';
      const candidateReservedContent =
        'package batch\nimport "testing"\nfunc TestCandidateReservedFile(t *testing.T) {}\n';
      writeFixtureFile(root, candidateReservedPath, candidateReservedContent);

      const soundCandidate = await score();
      expect(soundCandidate.passed).toBe(true);
      expect(soundCandidate.integrityFailure).toBe(false);
      expect(soundCandidate.evidence[1]).toBe('candidate regression coverage: present');
      expect(readFileSync(join(root, candidateReservedPath), 'utf8')).toBe(
        candidateReservedContent,
      );
      expect(readdirSync(join(root, 'batch')).filter((name) =>
        /^kory_hidden_[a-f0-9]+_test\.go$/u.test(name),
      )).toEqual([]);

      // The candidate's public checks also pass with the leaky starter; only
      // actual hidden execution can discriminate this broken implementation.
      writeFixtureFile(root, 'batch/batch.go', leakingStarter);
      const leakyCandidate = await score();
      expect(leakyCandidate.passed).toBe(false);
      expect(leakyCandidate.integrityFailure).toBe(false);
      expect(leakyCandidate.evidence[0]).toContain('race/runtime checks: fail');
      expect(leakyCandidate.evidence[1]).toBe('candidate regression coverage: present');
      expect(leakyCandidate.evidence[2]).toContain('TestKoryCancellationOwnership');
    },
    120_000,
  );

  runtimeTest(
    'context scorer rejects TestMain that skips the hidden suite',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-go-context-testmain-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(contextScenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(contextScenario.id),
      )!;
      await materializer.materialize(root, contextScenario);
      writeFixtureFile(root, 'batch/batch.go', GO_CONTEXT_CONTROL);
      writeFixtureFile(
        root,
        'batch/batch_test.go',
        `package batch
import (
    "os"
    "testing"
)
func TestMain(m *testing.M) { os.Exit(0) }
func TestContextSlowDependency(t *testing.T) {}
`,
      );
      const score = await scorer.score({
        scenario: contextScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed).toBe(false);
      expect(score.integrityFailure).toBe(false);
      expect(score.evidence[0]).toContain('fail (hidden tests skipped)');
      expect(score.evidence[1]).toBe('candidate regression coverage: present');
    },
    60_000,
  );

  runtimeTest(
    'context scorer rejects immutable changes made while candidate tests run',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-go-context-runtime-integrity-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(contextScenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(contextScenario.id),
      )!;
      await materializer.materialize(root, contextScenario);
      writeFixtureFile(root, 'batch/batch.go', GO_CONTEXT_CONTROL);
      writeFixtureFile(
        root,
        'batch/batch_test.go',
        `package batch
import (
    "os"
    "testing"
)
func TestContextSlowDependencyTampering(t *testing.T) {
    if err := os.WriteFile("../README.md", []byte("tampered during Go test"), 0600); err != nil { t.Fatal(err) }
}
`,
      );
      const score = await scorer.score({
        scenario: contextScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed).toBe(false);
      expect(score.integrityFailure).toBe(true);
      expect(score.evidence).toEqual(['Immutable Go runtime/contract input changed: README.md.']);
    },
    60_000,
  );

  runtimeTest(
    'typed-nil scorer detects the broken starter despite passing candidate checks',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-go-nil-negative-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(nilScenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(nilScenario.id),
      )!;
      await materializer.materialize(root, nilScenario);
      writeFixtureFile(
        root,
        'repo/repo_test.go',
        `package repo
import (
    "context"
    "errors"
    "testing"
)
func TestWrappedMissingWithNilRecord(t *testing.T) {
    record, _ := (Store{}).Get(context.Background(), "missing")
    if record != nil { t.Fatalf("missing record: %#v", record) }
    if !errors.Is(WrappedNotFound("missing"), ErrNotFound) { t.Fatal("wrapped error lost identity") }
}
`,
      );
      const result = await scorer.score({
        scenario: nilScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });

      expect(result.passed).toBe(false);
      expect(result.evidence[0]).toContain('race/runtime checks: fail');
      expect(result.evidence[1]).toBe('candidate regression coverage: present');
      expect(result.evidence[2]).toContain('TestKoryNilAndErrorIdentity');
      expect(result.evidence[2]).toContain('optional absence must be true nil');
    },
    60_000,
  );

  runtimeTest(
    'typed-nil scorer accepts a correct candidate from a cold race-build cache',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-go-nil-control-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(nilScenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(nilScenario.id),
      )!;
      await materializer.materialize(root, nilScenario);
      writeFixtureFile(root, 'repo/repo.go', GO_NIL_CONTROL);
      writeFixtureFile(
        root,
        'repo/repo_test.go',
        `package repo
import (
    "context"
    "errors"
    "testing"
)
func TestNilAbsenceAndWrappedUnexpectedErrors(t *testing.T) {
    if got, err := (Store{}).Get(context.Background(), "missing"); got != nil || err != nil { t.Fatalf("absence: got=%#v err=%#v", got, err) }
    wrapped := WrappedNotFound("missing")
    if !errors.Is(wrapped, ErrNotFound) { t.Fatal("wrapped errors.Is identity lost") }
    var target *NotFoundError
    if !errors.As(wrapped, &target) || target == nil { t.Fatal("wrapped errors.As identity lost") }
    if HTTPStatus(errors.New("unexpected database error")) != 500 { t.Fatal("unexpected error status") }
}
`,
      );

      expect(existsSync(join(root, '.gocache'))).toBe(false);
      const result = await scorer.score({
        scenario: nilScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });

      expect(result.passed).toBe(true);
      expect(result.verification).toBe(1);
      expect(result.evidence[0]).toBe('Go 1.27.1 race/runtime checks: pass');
    },
    60_000,
  );
});
