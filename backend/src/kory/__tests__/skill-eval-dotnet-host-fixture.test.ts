import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  DOTNET_DISPOSAL_CONTROL,
  DOTNET_DISPOSAL_SCENARIO,
  DOTNET_JSON_CONTROL,
  DOTNET_JSON_SCENARIO,
  V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS,
  dotnetHostReadiness,
} from '../skill-eval-v5-language-host-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const dotnetPackage = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === 'csharp-dotnet-engineering',
)!;

const disposalRegressions = `using KoryFixture;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }

var normalFactory = new CheckingFactory();
var normal = await new Importer(new CheckingParser(), normalFactory).ImportAsync("normal", CancellationToken.None);
Check(normal.Value == "parsed:normal" && normalFactory.Active == 0 && normalFactory.Disposals == 1 && normalFactory.Commits == 1, "normal disposal and commit");

var parserFailureFactory = new CheckingFactory();
try { await new Importer(new CheckingParser(fail: true), parserFailureFactory).ImportAsync("parser-error", CancellationToken.None); throw new Exception("parser failure not propagated"); }
catch (InvalidDataException) { }
Check(parserFailureFactory.Active == 0 && parserFailureFactory.Disposals == 1 && parserFailureFactory.Commits == 0, "parser failure must dispose scope once");

var cancelBeforeSave = new CancellationTokenSource();
var beforeFactory = new CheckingFactory();
try { await new Importer(new CheckingParser(cancel: cancelBeforeSave), beforeFactory).ImportAsync("before-save", cancelBeforeSave.Token); throw new Exception("cancellation before save ignored"); }
catch (OperationCanceledException) { }
Check(beforeFactory.Active == 0 && beforeFactory.Disposals == 1 && beforeFactory.Commits == 0, "before-save cancellation cleanup");

var cancelDuringSave = new CancellationTokenSource();
var duringFactory = new CheckingFactory(cancelDuringSave);
try { await new Importer(new CheckingParser(), duringFactory).ImportAsync("during-save", cancelDuringSave.Token); throw new Exception("cancellation during save ignored"); }
catch (OperationCanceledException) { }
Check(duringFactory.Active == 0 && duringFactory.Disposals == 1 && duringFactory.Commits == 0, "during-save cancellation cleanup");

var cancelAfterCommit = new CancellationTokenSource();
var afterFactory = new CheckingFactory(cancelAfterCommit: cancelAfterCommit);
var committed = await new Importer(new CheckingParser(), afterFactory).ImportAsync("after-commit", cancelAfterCommit.Token);
Check(committed.Value == "parsed:after-commit" && afterFactory.Active == 0 && afterFactory.Disposals == 1 && afterFactory.Commits == 1, "commit stays successful and scope disposes once");

sealed class CheckingParser(bool fail = false, CancellationTokenSource? cancel = null) : IFileParser {
    public Task<string> ParseAsync(string file, CancellationToken token) {
        token.ThrowIfCancellationRequested();
        if (fail) throw new InvalidDataException("parse failed");
        cancel?.Cancel();
        return Task.FromResult("parsed:" + file);
    }
}

sealed class CheckingFactory(CancellationTokenSource? cancelDuringSave = null, CancellationTokenSource? cancelAfterCommit = null) : IDbScopeFactory {
    public int Active; public int Disposals; public int Commits;
    public ValueTask<IDbScope> CreateAsync(CancellationToken token) {
        token.ThrowIfCancellationRequested();
        Active++;
        return ValueTask.FromResult<IDbScope>(new CheckingScope(this, cancelDuringSave, cancelAfterCommit));
    }
    sealed class CheckingScope(CheckingFactory owner, CancellationTokenSource? duringSave, CancellationTokenSource? afterCommit) : IDbScope {
        int disposed;
        public async Task SaveChangesAsync(string value, CancellationToken token) {
            if (duringSave is not null) { duringSave.Cancel(); await Task.Yield(); }
            token.ThrowIfCancellationRequested();
            owner.Commits++;
            afterCommit?.Cancel();
        }
        public ValueTask DisposeAsync() {
            if (Interlocked.Exchange(ref disposed, 1) != 0) throw new Exception("scope disposed twice");
            owner.Active--;
            owner.Disposals++;
            return ValueTask.CompletedTask;
        }
    }
}
`;

const jsonRegressions = `using KoryFixture;
using System.Text.Json;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }

var old = JobCodec.Decode("""{"id":"old","payload":"previous"}""");
Check(old.Retry.MaxAttempts == 1 && old.Retry.BackoffMs == 0, "old retry default");
var modern = new Job("new", "current", new RetryPolicy(4, 500));
var encoded = JobCodec.Encode(modern);
Check(JobCodec.Decode(encoded) == modern, "new retry roundtrip");
using (var doc = JsonDocument.Parse(encoded)) {
    Check(doc.RootElement.GetProperty("id").GetString() == "new", "old worker must still see the id");
    Check(doc.RootElement.GetProperty("payload").GetString() == "current", "old worker must still see payload");
}

foreach (var bad in new[] {
    """{"id":"bad","payload":"x","retry":{"maxAttempts":0,"backoffMs":1}}""",
    """{"id":"bad","payload":"x","retry":{"maxAttempts":11,"backoffMs":1}}""",
    """{"id":"bad","payload":"x","retry":{"maxAttempts":2,"backoffMs":-1}}""",
    """{"id":"bad","payload":"x","retry":{"maxAttempts":2,"backoffMs":60001}}""",
}) {
    try { _ = JobCodec.Decode(bad); throw new Exception("out of bounds retry accepted"); }
    catch (JsonException) { }
}

var queue = new[] { """{"id":"first","payload":"a"}""", "malformed-json", encoded, """{"id":"last","payload":"b","futureField":true}""" };
var firstLoad = JobCodec.LoadQueue(queue);
var restartLoad = JobCodec.LoadQueue(queue);
Check(firstLoad.Jobs.Count == 3 && firstLoad.Retained.Count == 1, "malformed queue entry retained without blocking good jobs");
Check(firstLoad.Retained[0].Index == 1 && firstLoad.Retained[0].Raw == "malformed-json", "malformed entry index and bytes retained");
Check(firstLoad.Jobs.Select(j => j.Id).SequenceEqual(new[] { "first", "new", "last" }), "queue retains good jobs after malformed entry");
Check(restartLoad.Jobs.SequenceEqual(firstLoad.Jobs) && restartLoad.Retained[0].Raw == firstLoad.Retained[0].Raw, "restart queue recovery deterministic");
`;

test.skipIf(dotnetHostReadiness().length > 0)(
  'both .NET hidden scorers compile and run known-correct controls while rejecting broken starters',
  async () => {
    for (const candidate of [
      {
        scenarioId: DOTNET_DISPOSAL_SCENARIO,
        sourcePath: 'Importer.cs',
        source: DOTNET_DISPOSAL_CONTROL,
      },
      {
        scenarioId: DOTNET_JSON_SCENARIO,
        sourcePath: 'JobCodec.cs',
        source: DOTNET_JSON_CONTROL,
      },
    ]) {
      const scenario = buildSkillEvalSuiteV3(dotnetPackage).scenarios.find(
        (item) => item.id === candidate.scenarioId,
      )!;
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(candidate.scenarioId),
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-dotnet-positive-scorer-'));
      roots.push(root);
      await materializer.materialize(root, scenario);

      if (candidate.scenarioId === DOTNET_DISPOSAL_SCENARIO) {
        // A separate executable regression project must build without editing the
        // immutable library project or accidentally compiling test sources into it.
        writeFixtureFile(
          root,
          'tests/regression.cs',
          'using System;\nConsole.WriteLine("KORY_REGRESSION_PROJECT_OK");\n',
        );
        const regression = Bun.spawnSync(
          [
            join(root, '.kory-runtime/dotnet'),
            'run',
            '--project',
            'tests/KoryFixture.Regression.csproj',
            '--configuration',
            'Release',
          ],
          { cwd: root, stdout: 'pipe', stderr: 'pipe' },
        );
        expect({
          code: regression.exitCode,
          stdout: regression.stdout.toString(),
          stderr: regression.stderr.toString(),
        }).toMatchObject({
          code: 0,
          stdout: expect.stringContaining('KORY_REGRESSION_PROJECT_OK'),
        });
      }

      writeFixtureFile(
        root,
        'tests/regression.cs',
        candidate.scenarioId === DOTNET_DISPOSAL_SCENARIO ? disposalRegressions : jsonRegressions,
      );
      const starter = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect({ candidate: candidate.scenarioId, ...starter }).toMatchObject({
        candidate: candidate.scenarioId,
        verification: 0,
        passed: false,
        integrityFailure: false,
        evidence: expect.arrayContaining([
          'candidate regression coverage: present; execution: fail',
        ]),
      });

      writeFixtureFile(root, candidate.sourcePath, candidate.source);
      const corrected = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect({ candidate: candidate.scenarioId, ...corrected }).toMatchObject({
        candidate: candidate.scenarioId,
        verification: 1,
        quality: 1,
        passed: true,
        integrityFailure: false,
      });
    }
  },
  120_000,
);
