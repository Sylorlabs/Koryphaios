import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { fixtureTextEquals, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';
import { canonicalizePath } from '../../runtime/platform';

export const V5_HOST_RUNTIME_VERSIONS = {
  go: '1.27.1',
  php: '8.5.11',
  composer: '2.10.3',
  dotnet: '10.0.401',
} as const;

export const GO_CONTEXT_SCENARIO = 'go-engineering-full-task-1-individual';
export const GO_NIL_SCENARIO = 'go-engineering-full-task-2-individual';
export const PHP_WORKER_SCENARIO = 'php-engineering-full-task-1-individual';
export const PHP_JSON_SCENARIO = 'php-engineering-full-task-2-individual';
export const DOTNET_DISPOSAL_SCENARIO = 'csharp-dotnet-engineering-full-task-1-individual';
export const DOTNET_JSON_SCENARIO = 'csharp-dotnet-engineering-full-task-2-individual';

const GO = process.env.KORY_EVAL_GO ?? '/opt/homebrew/bin/go';
const PHP = process.env.KORY_EVAL_PHP ?? '/opt/homebrew/bin/php';
const COMPOSER = process.env.KORY_EVAL_COMPOSER ?? '/opt/homebrew/bin/composer';
const DOTNET = process.env.KORY_EVAL_DOTNET ?? '/opt/homebrew/bin/dotnet';
const DOTNET_ROOT = process.env.KORY_EVAL_DOTNET_ROOT ?? '/opt/homebrew/opt/dotnet/libexec';
// Each isolated attempt starts with an empty Go build cache. Allow the race
// compiler to warm that cache under host contention; the Go test runner still
// enforces its own 10s timeout for hanging candidate/hidden tests.
const GO_RACE_PROCESS_TIMEOUT_MS = 120_000;
const GO_TEST_TIMEOUT = '10s';

const runtimeEnv = () => ({
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: tmpdir(),
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1',
  CI: '1',
  DOTNET_ROOT,
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  NUGET_XMLDOC_MODE: 'skip',
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = 12_000,
  extraEnv: Record<string, string> = {},
): RunResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...runtimeEnv(), ...extraEnv },
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1_000_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

function probe(executable: string, args: string[]): string {
  const result = run(executable, args, process.cwd(), 3_000);
  return result.code === 0 && !result.timedOut
    ? `${result.stdout}${result.stderr}`.trim()
    : 'unavailable';
}

export function goHostReadiness(): string[] {
  const observed = probe(GO, ['version']);
  return observed.includes(`go${V5_HOST_RUNTIME_VERSIONS.go} `)
    ? []
    : [`Go fixture requires Go ${V5_HOST_RUNTIME_VERSIONS.go}; observed ${observed}.`];
}

export function phpHostReadiness(): string[] {
  const php = run(PHP, ['-r', 'echo PHP_VERSION;'], process.cwd(), 3_000);
  const composer = probe(COMPOSER, ['--version', '--no-ansi']);
  const reasons: string[] = [];
  if (php.code !== 0 || php.stdout.trim() !== V5_HOST_RUNTIME_VERSIONS.php)
    reasons.push(
      `PHP fixture requires PHP ${V5_HOST_RUNTIME_VERSIONS.php}; observed ${php.code === 0 ? php.stdout.trim() : 'unavailable'}.`,
    );
  if (!composer.includes(`Composer version ${V5_HOST_RUNTIME_VERSIONS.composer}`))
    reasons.push(
      `PHP fixture requires Composer ${V5_HOST_RUNTIME_VERSIONS.composer}; observed ${composer}.`,
    );
  return reasons;
}

export function dotnetHostReadiness(): string[] {
  const result = run(DOTNET, ['--version'], process.cwd(), 3_000);
  const observed = result.code === 0 ? result.stdout.trim() : 'unavailable';
  return observed === V5_HOST_RUNTIME_VERSIONS.dotnet
    ? []
    : [`.NET fixture requires SDK ${V5_HOST_RUNTIME_VERSIONS.dotnet}; observed ${observed}.`];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executableFixture(root: string, path: string, content: string): void {
  writeFixtureFile(root, path, content);
  chmodSync(join(root, path), 0o700);
}

function runtimeFiles(kind: 'go' | 'php' | 'dotnet'): Record<string, string> {
  if (kind === 'go') {
    return {
      '.kory-runtime/go': `#!/bin/sh\nexec ${shellQuote(GO)} "$@"\n`,
      '.kory-runtime/runtime.json': `${JSON.stringify(
        { runtime: 'go', version: V5_HOST_RUNTIME_VERSIONS.go, executable: GO },
        null,
        2,
      )}\n`,
    };
  }
  if (kind === 'php') {
    return {
      '.kory-runtime/php': `#!/bin/sh\nexec ${shellQuote(PHP)} "$@"\n`,
      '.kory-runtime/composer': `#!/bin/sh\nexec ${shellQuote(COMPOSER)} "$@"\n`,
      '.kory-runtime/runtime.json': `${JSON.stringify(
        {
          runtime: 'php',
          version: V5_HOST_RUNTIME_VERSIONS.php,
          composer: V5_HOST_RUNTIME_VERSIONS.composer,
          executable: PHP,
        },
        null,
        2,
      )}\n`,
    };
  }
  return {
    '.kory-runtime/dotnet': `#!/bin/sh\nexport DOTNET_ROOT=${shellQuote(DOTNET_ROOT)}\nexport DOTNET_CLI_TELEMETRY_OPTOUT=1\nexport DOTNET_NOLOGO=1\nexec ${shellQuote(DOTNET)} "$@"\n`,
    '.kory-runtime/runtime.json': `${JSON.stringify(
      {
        runtime: 'dotnet',
        sdk: V5_HOST_RUNTIME_VERSIONS.dotnet,
        executable: DOTNET,
        dotnetRoot: DOTNET_ROOT,
      },
      null,
      2,
    )}\n`,
  };
}

function writeRuntime(root: string, kind: 'go' | 'php' | 'dotnet'): Record<string, string> {
  const files = runtimeFiles(kind);
  for (const [path, content] of Object.entries(files)) executableFixture(root, path, content);
  return files;
}

function intact(root: string, files: Record<string, string>): boolean {
  return Object.entries(files).every(([path, expected]) => fixtureTextEquals(root, path, expected));
}

function fail(evidence: string[], integrityFailure = false): SkillEvalDeterministicScore {
  return { passed: false, quality: 0, verification: 0, integrityFailure, evidence };
}

function sourceFiles(root: string, extension: RegExp): string[] {
  const files: string[] = [];
  const walk = (relativeDir: string, depth: number): void => {
    if (depth > 5) return;
    const absolute = relativeDir ? join(root, relativeDir) : root;
    let entries: string[];
    try {
      entries = readdirSync(absolute).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (
        relative.startsWith('.kory-runtime/') ||
        relative.startsWith('.gocache/') ||
        relative.startsWith('.gomodcache/') ||
        relative.startsWith('bin/') ||
        relative.startsWith('obj/')
      )
        continue;
      const absolutePath = join(root, relative);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(relative, depth + 1);
      else if (stat.isFile() && extension.test(name)) files.push(relative);
    }
  };
  walk('', 0);
  return files;
}

function regressionText(root: string, extension: RegExp, patterns: RegExp[]): boolean {
  try {
    const files = sourceFiles(root, extension).filter((path) =>
      /(?:test|spec|regression)/iu.test(path),
    );
    const text = files.map((path) => readFixtureText(root, path)).join('\n');
    return files.length > 0 && patterns.every((pattern) => pattern.test(text));
  } catch {
    return false;
  }
}

function authoredRegressionText(root: string, extension: RegExp, patterns: RegExp[]): boolean {
  try {
    const files = sourceFiles(root, extension).filter((path) =>
      /(?:test|spec|regression)/iu.test(path),
    );
    const source = files
      .map((path) => readFixtureText(root, path))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/\/\/[^\n]*/gu, ' ')
      .replace(/#[^\n]*/gu, ' ');
    return (
      files.length > 0 &&
      /\b(?:assert\w*(?:\.\w+)?|expect\w*|check|should\w*|if)\s*\(|\bthrow\s+new\b/iu.test(
        source,
      ) &&
      patterns.every((pattern) => pattern.test(source))
    );
  } catch {
    return false;
  }
}

const GO_CONTEXT_README = [
  '# Go context/goroutine ownership fixture',
  '',
  'Fix `batch/batch.go` and add or update regressions in `batch/*_test.go`.',
  'Preserve the Response JSON fields, bounded maxConcurrency behavior and partial results.',
  'The blocked downstream client waits until its context is canceled; verify that cancellation releases owned workers.',
  'An in-process call that ignores context forever cannot be forcibly terminated: identify the dependency or isolation boundary needed before claiming cleanup in that case.',
  '',
  'Evaluator-owned immutable inputs: `README.md`, `go.mod`, `.kory-runtime/go`, and `.kory-runtime/runtime.json`.',
  'Leave these files byte-for-byte unchanged. Put design notes in your final response or a new file rather than editing README.md.',
  'Use `./.kory-runtime/go` for the pinned Go runtime. Add focused cancellation, timeout, slow-dependency, success and leak/race regression tests.',
  '',
].join('\n');
const GO_NIL_README =
  '# Go typed-nil/error identity fixture\n\nFix repo/repo.go at the repository boundary so optional absence returns a true nil error while real NotFoundError values keep errors.Is/errors.As identity. Use ./.kory-runtime/go and add regressions for nil, wrapped not-found and unexpected errors.\n';
const PHP_WORKER_README = [
  '# PHP long-lived worker fixture',
  '',
  'Fix `src/Worker.php` without disabling the safe immutable cache. Keep `Worker::handle()` and the public `ServiceCache::config()` / `ServiceCache::immutableEntries()` observations working.',
  'Request identity must not survive its request, including exceptions, interleaved Fibers and worker recycling. Mutable request identity must belong to the worker/request lifecycle, not a process-static cache.',
  'A recycle operation may belong to the worker instance if you move request state there; preserve the observable behavior of recycle, worker reuse and immutable-cache retention.',
  'Use `./.kory-runtime/php` and `./.kory-runtime/composer`. Write AND execute runtime regressions in `tests/regression.php`.',
  'Your executed regression assertions must pass with the repaired worker and fail against the original defective `src/Worker.php`; merely testing a single successful request is insufficient.',
  '',
].join('\n');
const PHP_JSON_README = [
  '# PHP strict JSON boundary fixture',
  '',
  'Fix `src/RequestDecoder.php` while preserving the public response array: `ok`, `status`, and either `error` or a `Quantity` in `value`.',
  'The JSON root must be an object. The `quantity` contract is: missing key => 422 `MISSING_QUANTITY`; explicit null => 422 `NULL_QUANTITY`; boolean, float, array, or quoted numeric string (including `"0"`) => 422 `INVALID_TYPE`.',
  'Unquoted JSON integers from 0 through 1000000000 are accepted (200 with a typed `Quantity`); negative or overflowing unquoted integers => 422 `OUT_OF_RANGE`, even when `JSON_BIGINT_AS_STRING` converts a large JSON number to a PHP string.',
  'Invalid JSON and invalid UTF-8 => 400 `INVALID_JSON`. Keep extra fields in valid integer payloads compatible. Distinguish original JSON numbers from quoted strings before conversion.',
  'Use `./.kory-runtime/php` and `./.kory-runtime/composer`. Write AND execute runtime regressions in `tests/regression.php` that assert exact response codes, errors and typed values.',
  'Your executed regression assertions must pass with the repaired decoder and fail against the original defective `src/RequestDecoder.php`; a valid-integer happy path alone is insufficient.',
  '',
].join('\n');
const DOTNET_DISPOSAL_README =
  '# .NET async disposal/cancellation fixture\n\nFix Importer.cs. Preserve ImportAsync and result/error semantics, propagate CancellationToken through real async boundaries, dispose each acquired async scope exactly once, and do not use sync-over-async. Use ./.kory-runtime/dotnet and add cancellation/disposal regressions to tests/regression.cs. Run the tests with tests/KoryFixture.Regression.csproj, which already references the library. KoryFixture.csproj and the regression project file are immutable contract inputs; do not edit them. The library project excludes the tests directory from its own compilation.\n';
const DOTNET_JSON_README = [
  '# .NET persisted JSON compatibility fixture',
  '',
  'Fix `JobCodec.cs` for a rolling old/new worker deployment. Preserve the existing public `new Job(string id, string payload, RetryPolicy? retry)` construction contract while accepting persisted old JSON that omits `retry`.',
  'For an omitted `retry`, use the documented default of `RetryPolicy(1, 0)`; supplied retry values must have `MaxAttempts` in 1..10 and `BackoffMs` in 0..60000, including both bounds. Distinguish missing retry from malformed supplied retry data.',
  'Keep `id` and `payload` in new serialized records so old workers can ignore additional fields. Continue loading valid queue entries after malformed entries and retain the raw contents and original index of each malformed entry for recovery on restart.',
  'Use `./.kory-runtime/dotnet`. Add and run old/new compatibility, malformed input, and repeated restart regressions in `tests/regression.cs` through `tests/KoryFixture.Regression.csproj` (which already references the library).',
  '`KoryFixture.csproj` and the regression project file are immutable contract inputs; do not edit them. The library project excludes `tests/` from its own compilation.',
  '',
].join('\n');

const GO_MOD = `module example.com/kory-eval\n\ngo ${V5_HOST_RUNTIME_VERSIONS.go}\n`;
const PHP_COMPOSER = `${JSON.stringify(
  {
    name: 'kory/eval-fixture',
    type: 'project',
    license: 'proprietary',
    require: { php: `^${V5_HOST_RUNTIME_VERSIONS.php}` },
  },
  null,
  2,
)}\n`;
const DOTNET_PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>14.0</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <Compile Remove="tests/**/*.cs" />
  </ItemGroup>
</Project>
`;
const DOTNET_REGRESSION_PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>14.0</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../KoryFixture.csproj" />
  </ItemGroup>
</Project>
`;

const GO_CONTEXT_STARTER = `package batch

import (
    "context"
    "encoding/json"
    "net/http"
    "time"
)

type Client interface { Fetch(context.Context, string) (string, error) }
type Response struct { Results map[string]string \`json:"results"\`; Errors map[string]string \`json:"errors"\` }
type item struct { id, value string; err error }

func FetchBatch(ctx context.Context, client Client, ids []string, maxConcurrency int) Response {
    ch := make(chan item)
    for _, id := range ids {
        id := id
        go func() {
            value, err := client.Fetch(ctx, id)
            ch <- item{id: id, value: value, err: err}
        }()
    }
    out := Response{Results: map[string]string{}, Errors: map[string]string{}}
    for range ids {
        select {
        case got := <-ch:
            if got.err != nil { out.Errors[got.id] = got.err.Error() } else { out.Results[got.id] = got.value }
        case <-ctx.Done():
            return out
        }
    }
    return out
}

func NewHandler(client Client, maxConcurrency int, timeout time.Duration) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var ids []string
        if err := json.NewDecoder(r.Body).Decode(&ids); err != nil { http.Error(w, "invalid json", 400); return }
        ctx, cancel := context.WithTimeout(r.Context(), timeout); defer cancel()
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(FetchBatch(ctx, client, ids, maxConcurrency))
    })
}
`;

export const GO_CONTEXT_CONTROL = `package batch

import (
    "context"
    "encoding/json"
    "net/http"
    "sync"
    "time"
)

type Client interface { Fetch(context.Context, string) (string, error) }
type Response struct { Results map[string]string \`json:"results"\`; Errors map[string]string \`json:"errors"\` }
type item struct { id, value string; err error }

func FetchBatch(ctx context.Context, client Client, ids []string, maxConcurrency int) Response {
    out := Response{Results: map[string]string{}, Errors: map[string]string{}}
    if len(ids) == 0 { return out }
    if maxConcurrency < 1 { maxConcurrency = 1 }
    if maxConcurrency > len(ids) { maxConcurrency = len(ids) }
    jobs := make(chan string, len(ids))
    results := make(chan item, len(ids))
    for _, id := range ids { jobs <- id }
    close(jobs)
    var wg sync.WaitGroup
    for i := 0; i < maxConcurrency; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for id := range jobs {
                if ctx.Err() != nil { return }
                value, err := client.Fetch(ctx, id)
                results <- item{id: id, value: value, err: err}
            }
        }()
    }
    wg.Wait()
    close(results)
    for got := range results {
        if got.err != nil { out.Errors[got.id] = got.err.Error() } else { out.Results[got.id] = got.value }
    }
    return out
}

func NewHandler(client Client, maxConcurrency int, timeout time.Duration) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var ids []string
        if err := json.NewDecoder(r.Body).Decode(&ids); err != nil { http.Error(w, "invalid json", 400); return }
        ctx, cancel := context.WithTimeout(r.Context(), timeout); defer cancel()
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(FetchBatch(ctx, client, ids, maxConcurrency))
    })
}
`;

const GO_CONTEXT_HIDDEN = `package batch

import (
    "bytes"
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "runtime"
    "sync/atomic"
    "testing"
    "time"
)

type hiddenClient struct { active, max atomic.Int32 }
func (c *hiddenClient) Fetch(ctx context.Context, id string) (string, error) {
    n := c.active.Add(1); defer c.active.Add(-1)
    for { old := c.max.Load(); if n <= old || c.max.CompareAndSwap(old, n) { break } }
    if id == "blocked" { <-ctx.Done(); return "", ctx.Err() }
    if id == "slow" { select { case <-time.After(80*time.Millisecond): return "slow", nil; case <-ctx.Done(): return "", ctx.Err() } }
    select { case <-time.After(3*time.Millisecond): return "v:"+id, nil; case <-ctx.Done(): return "", ctx.Err() }
}

func TestKoryCancellationOwnership(t *testing.T) {
    before := runtime.NumGoroutine()
    for i := 0; i < 12; i++ {
        ctx, cancel := context.WithCancel(context.Background())
        client := &hiddenClient{}
        done := make(chan struct{})
        go func(){ _ = FetchBatch(ctx, client, []string{"a","blocked","b","c"}, 2); close(done) }()
        time.Sleep(4*time.Millisecond); cancel()
        select { case <-done: case <-time.After(300*time.Millisecond): t.Fatal("batch did not terminate after cancellation") }
        if client.max.Load() > 2 { t.Fatalf("bounded concurrency exceeded: %d", client.max.Load()) }
        settled := time.Now().Add(300*time.Millisecond)
        for client.active.Load() != 0 && time.Now().Before(settled) { time.Sleep(5*time.Millisecond) }
        if active := client.active.Load(); active != 0 { t.Fatalf("downstream calls remained active after cancellation: %d", active) }
    }
    deadline := time.Now().Add(500*time.Millisecond)
    for runtime.NumGoroutine() > before+3 && time.Now().Before(deadline) { runtime.GC(); time.Sleep(10*time.Millisecond) }
    if got := runtime.NumGoroutine(); got > before+3 { t.Fatalf("goroutines leaked: before=%d after=%d", before, got) }
}

func TestKoryPartialTimeout(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond); defer cancel()
    client := &hiddenClient{}
    got := FetchBatch(ctx, client, []string{"fast","slow","other"}, 2)
    if got.Results["fast"] != "v:fast" || got.Results["other"] != "v:other" { t.Fatalf("lost partial successes: %#v", got) }
    if _, ok := got.Results["slow"]; ok { t.Fatalf("slow result should not succeed: %#v", got) }
    if client.max.Load() > 2 { t.Fatalf("bounded concurrency exceeded: %d", client.max.Load()) }
}

func TestKoryAllSuccessAndHTTPResponse(t *testing.T) {
    ids := []string{"a", "b", "c", "d", "e", "f"}
    client := &hiddenClient{}
    got := FetchBatch(context.Background(), client, ids, 2)
    if len(got.Results) != len(ids) || len(got.Errors) != 0 { t.Fatalf("all-success results or errors changed: %#v", got) }
    for _, id := range ids { if got.Results[id] != "v:"+id { t.Fatalf("wrong value for %s: %#v", id, got) } }
    if client.max.Load() > 2 { t.Fatalf("all-success concurrency exceeded: %d", client.max.Load()) }
    if client.active.Load() != 0 { t.Fatal("completed request left downstream active") }

    request := httptest.NewRequest(http.MethodPost, "/batch", bytes.NewBufferString(\`["one","two"]\`))
    response := httptest.NewRecorder()
    NewHandler(&hiddenClient{}, 2, time.Second).ServeHTTP(response, request)
    if response.Code != http.StatusOK { t.Fatalf("HTTP status changed: %d", response.Code) }
    if response.Header().Get("Content-Type") != "application/json" { t.Fatal("HTTP content type changed") }
    var fields map[string]json.RawMessage
    if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil { t.Fatal(err) }
    if fields["results"] == nil || fields["errors"] == nil { t.Fatalf("Response JSON fields changed: %#v", fields) }
    var decoded Response
    if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil { t.Fatal(err) }
    if decoded.Results["one"] != "v:one" || decoded.Results["two"] != "v:two" || len(decoded.Errors) != 0 { t.Fatalf("HTTP response changed: %#v", decoded) }
}

func TestKoryHandlerDeadlineAndInvalidJSON(t *testing.T) {
    client := &hiddenClient{}
    request := httptest.NewRequest(http.MethodPost, "/batch", bytes.NewBufferString(\`["blocked"]\`))
    response := httptest.NewRecorder()
    started := time.Now()
    NewHandler(client, 1, 20*time.Millisecond).ServeHTTP(response, request)
    if time.Since(started) > 300*time.Millisecond { t.Fatal("handler failed to honor timeout") }
    if response.Code != http.StatusOK { t.Fatalf("timeout response status changed: %d", response.Code) }
    var fields map[string]json.RawMessage
    if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil { t.Fatal(err) }
    if fields["results"] == nil || fields["errors"] == nil { t.Fatalf("timeout response fields changed: %#v", fields) }
    if client.active.Load() != 0 { t.Fatal("handler returned with a blocked downstream call") }

    invalid := httptest.NewRecorder()
    NewHandler(&hiddenClient{}, 1, time.Second).ServeHTTP(invalid, httptest.NewRequest(http.MethodPost, "/batch", bytes.NewBufferString("not-json")))
    if invalid.Code != http.StatusBadRequest { t.Fatalf("invalid JSON status changed: %d", invalid.Code) }
}
`;

const GO_NIL_STARTER = `package repo

import (
    "context"
    "errors"
    "fmt"
)

var ErrNotFound = errors.New("not found")
type NotFoundError struct { ID string }
func (e *NotFoundError) Error() string { if e == nil { return "not found" }; return "not found: " + e.ID }
func (e *NotFoundError) Is(target error) bool { return target == ErrNotFound }
type Record struct { ID string }
type Store struct { Values map[string]*Record }
func (s Store) Get(_ context.Context, id string) (*Record, error) {
    if value, ok := s.Values[id]; ok { return value, nil }
    var missing *NotFoundError
    return nil, missing
}
func WrappedNotFound(id string) error { return fmt.Errorf("lookup failed: %w", &NotFoundError{ID:id}) }
func HTTPStatus(err error) int {
    if err == nil { return 200 }
    if errors.Is(err, ErrNotFound) { return 404 }
    return 500
}
`;

export const GO_NIL_CONTROL = GO_NIL_STARTER.replace(
  'var missing *NotFoundError\n    return nil, missing',
  'return nil, nil',
);

const GO_NIL_HIDDEN = `package repo
import (
    "context"
    "errors"
    "fmt"
    "testing"
)
func TestKoryNilAndErrorIdentity(t *testing.T) {
    store := Store{Values: map[string]*Record{"yes": {ID:"yes"}}}
    if got, err := store.Get(context.Background(), "missing"); got != nil || err != nil { t.Fatalf("optional absence must be true nil: got=%#v err=%#v", got, err) }
    wrapped := fmt.Errorf("outer: %w", WrappedNotFound("x"))
    if !errors.Is(wrapped, ErrNotFound) { t.Fatal("errors.Is identity lost") }
    var target *NotFoundError
    if !errors.As(wrapped, &target) || target == nil || target.ID != "x" { t.Fatalf("errors.As identity lost: %#v", target) }
    if HTTPStatus(wrapped) != 404 { t.Fatalf("wrapped not-found status = %d", HTTPStatus(wrapped)) }
    unexpected := errors.New("database unavailable")
    if HTTPStatus(unexpected) != 500 { t.Fatalf("unexpected status = %d", HTTPStatus(unexpected)) }
}
`;

const PHP_WORKER_STARTER = `<?php
declare(strict_types=1);
final readonly class TenantContext { public function __construct(public string $tenantId) {} }
final class ServiceCache {
    private static array $immutable = [];
    private static ?TenantContext $requestContext = null;
    public static function config(string $key): string {
        if (!array_key_exists($key, self::$immutable)) self::$immutable[$key] = 'cfg:' . $key;
        return self::$immutable[$key];
    }
    public static function context(string $tenantId): TenantContext {
        return self::$requestContext ??= new TenantContext($tenantId);
    }
    public static function recycle(): void { self::$requestContext = null; }
    public static function immutableEntries(): int { return count(self::$immutable); }
}
final class Worker {
    public function handle(string $tenantId, bool $fail = false): string {
        $context = ServiceCache::context($tenantId);
        if ($fail) throw new RuntimeException('request failed');
        return $context->tenantId . ':' . ServiceCache::config('version');
    }
}
`;

export const PHP_WORKER_CONTROL = `<?php
declare(strict_types=1);
final readonly class TenantContext { public function __construct(public string $tenantId) {} }
final class ServiceCache {
    private static array $immutable = [];
    public static function config(string $key): string {
        if (!array_key_exists($key, self::$immutable)) self::$immutable[$key] = 'cfg:' . $key;
        return self::$immutable[$key];
    }
    public static function immutableEntries(): int { return count(self::$immutable); }
}
final class Worker {
    private ?TenantContext $mainRequest = null;
    private WeakMap $fiberRequests;
    public function __construct() { $this->fiberRequests = new WeakMap(); }
    private function currentContext(): TenantContext {
        $fiber = Fiber::getCurrent();
        if ($fiber !== null) return $this->fiberRequests[$fiber] ?? throw new LogicException('no active fiber request');
        return $this->mainRequest ?? throw new LogicException('no active request');
    }
    public function handle(string $tenantId, bool $fail = false): string {
        $fiber = Fiber::getCurrent();
        $context = new TenantContext($tenantId);
        if ($fiber !== null) $this->fiberRequests[$fiber] = $context;
        else $this->mainRequest = $context;
        try {
            if ($fail) throw new RuntimeException('request failed');
            return $this->currentContext()->tenantId . ':' . ServiceCache::config('version');
        } finally {
            if ($fiber !== null) unset($this->fiberRequests[$fiber]);
            else $this->mainRequest = null;
        }
    }
    public function recycle(): void {
        $this->mainRequest = null;
        $this->fiberRequests = new WeakMap();
    }
}
`;

const PHP_WORKER_HIDDEN = `<?php
declare(strict_types=1);
require __DIR__ . '/src/Worker.php';
function checkKory(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
// Request-owned mutable context cannot live in process-static properties, even
// if the candidate empties those properties after each ordinary request.
$workerFile = realpath(__DIR__ . '/src/Worker.php');
foreach (get_declared_classes() as $className) {
    $class = new ReflectionClass($className);
    if ($class->getFileName() !== $workerFile) continue;
    foreach ($class->getProperties(ReflectionProperty::IS_STATIC) as $property) {
        if (preg_match('/tenant|request|context|fiber/i', $property->getName())) {
            throw new RuntimeException('Request-owned state declared static: ' . $className . '::$' . $property->getName());
        }
    }
}
$worker = new Worker();
checkKory($worker->handle('alpha') === 'alpha:cfg:version', 'alpha');
checkKory($worker->handle('beta') === 'beta:cfg:version', 'tenant leaked across sequential requests');
try { $worker->handle('exception-tenant', true); } catch (RuntimeException $e) {}
checkKory($worker->handle('gamma') === 'gamma:cfg:version', 'exception path leaked request state');
$fiberA = new Fiber(fn() => $worker->handle('fiber-a'));
$fiberB = new Fiber(fn() => $worker->handle('fiber-b'));
$fiberA->start(); $fiberB->start();
checkKory($fiberA->getReturn() === 'fiber-a:cfg:version', 'fiber a');
checkKory($fiberB->getReturn() === 'fiber-b:cfg:version', 'fiber b');
// If the implementation exposes request entry and lookup, exercise real Fiber
// interleaving rather than two Fibers that both complete without suspension.
if (method_exists($worker, 'run') && method_exists($worker, 'context')) {
    $interleavedA = new Fiber(function () use ($worker): string {
        return $worker->run('interleaved-a', function (TenantContext $context) use ($worker): string {
            checkKory($context->tenantId === 'interleaved-a', 'fiber a entry');
            Fiber::suspend();
            checkKory($worker->context()->tenantId === 'interleaved-a', 'fiber a context after resume');
            return $context->tenantId;
        });
    });
    $interleavedB = new Fiber(function () use ($worker): string {
        return $worker->run('interleaved-b', function (TenantContext $context) use ($worker): string {
            checkKory($worker->context()->tenantId === 'interleaved-b', 'fiber b context');
            return $context->tenantId;
        });
    });
    $interleavedA->start();
    checkKory($interleavedA->isSuspended(), 'fiber a was not suspended');
    $interleavedB->start();
    checkKory($interleavedB->getReturn() === 'interleaved-b', 'fiber b completed');
    $interleavedA->resume();
    checkKory($interleavedA->getReturn() === 'interleaved-a', 'fiber a resumed');
    $inactiveContextRejected = false;
    try { $worker->context(); } catch (LogicException $e) { $inactiveContextRejected = true; }
    checkKory($inactiveContextRejected, 'context accessible outside an active request');
}
checkKory(ServiceCache::immutableEntries() === 1, 'immutable cache was disabled instead of preserved');
if (method_exists($worker, 'recycle')) {
    $worker->recycle();
} elseif (method_exists(ServiceCache::class, 'recycle')) {
    ServiceCache::recycle();
} else {
    throw new RuntimeException('Worker recycle operation missing');
}
checkKory($worker->handle('after-recycle') === 'after-recycle:cfg:version', 'recycle');
checkKory(ServiceCache::immutableEntries() === 1, 'recycle destroyed safe immutable cache');
echo "KORY_PHP_OK\n";
`;

const PHP_JSON_STARTER = `<?php
declare(strict_types=1);
final readonly class Quantity { public function __construct(public int $value) {} }
final class RequestDecoder {
    public static function decode(string $json): array {
        try { $data = json_decode($json, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING); }
        catch (JsonException $e) { return ['ok'=>false, 'status'=>400, 'error'=>'INVALID_JSON']; }
        if (!is_array($data)) return ['ok'=>false, 'status'=>422, 'error'=>'INVALID_TYPE'];
        $value = $data['quantity'] ?? null;
        if ($value == null) return ['ok'=>false, 'status'=>422, 'error'=>'MISSING_QUANTITY'];
        if ($value < 0 || $value > 1000000000) return ['ok'=>false, 'status'=>422, 'error'=>'OUT_OF_RANGE'];
        return ['ok'=>true, 'status'=>200, 'value'=>new Quantity((int)$value)];
    }
}
`;

export const PHP_JSON_CONTROL = `<?php
declare(strict_types=1);
final readonly class Quantity { public function __construct(public int $value) {} }
final class RequestDecoder {
    public static function decode(string $json): array {
        try { $data = json_decode($json, false, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING); }
        catch (JsonException $e) { return ['ok'=>false, 'status'=>400, 'error'=>'INVALID_JSON']; }
        if (!$data instanceof stdClass) return ['ok'=>false, 'status'=>422, 'error'=>'INVALID_TYPE'];
        if (!property_exists($data, 'quantity')) return ['ok'=>false, 'status'=>422, 'error'=>'MISSING_QUANTITY'];
        $value = $data->quantity;
        if ($value === null) return ['ok'=>false, 'status'=>422, 'error'=>'NULL_QUANTITY'];
        if (is_string($value)) {
            // JSON_BIGINT_AS_STRING turns only overflowing unquoted integer tokens into strings.
            // A second decode without that option distinguishes the token from a quoted string.
            $originalType = json_decode($json, false, 512, JSON_THROW_ON_ERROR)->quantity;
            if (is_float($originalType)) return ['ok'=>false, 'status'=>422, 'error'=>'OUT_OF_RANGE'];
            return ['ok'=>false, 'status'=>422, 'error'=>'INVALID_TYPE'];
        }
        if (!is_int($value)) return ['ok'=>false, 'status'=>422, 'error'=>'INVALID_TYPE'];
        if ($value < 0 || $value > 1000000000) return ['ok'=>false, 'status'=>422, 'error'=>'OUT_OF_RANGE'];
        return ['ok'=>true, 'status'=>200, 'value'=>new Quantity($value)];
    }
}
`;

const PHP_JSON_HIDDEN = `<?php
declare(strict_types=1);
require __DIR__ . '/src/RequestDecoder.php';
function expectKoryError(string $json, string $error, int $status = 422): void {
    $got = RequestDecoder::decode($json);
    if (($got['ok'] ?? null) !== false || ($got['error'] ?? null) !== $error || ($got['status'] ?? null) !== $status)
        throw new RuntimeException($json . ' => ' . json_encode($got));
}
expectKoryError('{}', 'MISSING_QUANTITY');
expectKoryError('{"quantity":null}', 'NULL_QUANTITY');
expectKoryError('[]', 'INVALID_TYPE');
expectKoryError('{"quantity":false}', 'INVALID_TYPE');
expectKoryError('{"quantity":true}', 'INVALID_TYPE');
expectKoryError('{"quantity":"0"}', 'INVALID_TYPE');
expectKoryError('{"quantity":"42"}', 'INVALID_TYPE');
expectKoryError('{"quantity":"100000000000000000000"}', 'INVALID_TYPE');
expectKoryError('{"quantity":1.5}', 'INVALID_TYPE');
expectKoryError('{"quantity":-1}', 'OUT_OF_RANGE');
expectKoryError('{"quantity":1000000001}', 'OUT_OF_RANGE');
expectKoryError('{"quantity":100000000000000000000}', 'OUT_OF_RANGE');
expectKoryError('{bad', 'INVALID_JSON', 400);
expectKoryError('{"quantity":"' . chr(0xC3) . chr(0x28) . '"}', 'INVALID_JSON', 400);
$zero = RequestDecoder::decode('{"quantity":0}');
if (($zero['ok'] ?? false) !== true || !($zero['value'] instanceof Quantity) || $zero['value']->value !== 0) throw new RuntimeException('integer zero rejected');
$maximum = RequestDecoder::decode('{"quantity":1000000000}');
if (($maximum['ok'] ?? false) !== true || !($maximum['value'] instanceof Quantity) || $maximum['value']->value !== 1000000000) throw new RuntimeException('integer maximum rejected');
$valid = RequestDecoder::decode('{"quantity":42,"legacy":"kept"}');
if (($valid['ok'] ?? false) !== true || $valid['value']->value !== 42) throw new RuntimeException('valid compatibility payload');
echo "KORY_PHP_OK\n";
`;

const DOTNET_DISPOSAL_STARTER = `namespace KoryFixture;

public interface IFileParser { Task<string> ParseAsync(string file, CancellationToken cancellationToken); }
public interface IDbScopeFactory { ValueTask<IDbScope> CreateAsync(CancellationToken cancellationToken); }
public interface IDbScope : IAsyncDisposable { Task SaveChangesAsync(string value, CancellationToken cancellationToken); }
public sealed record ImportResult(string File, string Value);

public sealed class Importer(IFileParser parser, IDbScopeFactory scopes)
{
    public async Task<ImportResult> ImportAsync(string file, CancellationToken cancellationToken)
    {
        var scope = await scopes.CreateAsync(cancellationToken);
        var value = await parser.ParseAsync(file, cancellationToken);
        await scope.SaveChangesAsync(value, cancellationToken);
        await scope.DisposeAsync();
        return new ImportResult(file, value);
    }
}
`;

export const DOTNET_DISPOSAL_CONTROL = `namespace KoryFixture;

public interface IFileParser { Task<string> ParseAsync(string file, CancellationToken cancellationToken); }
public interface IDbScopeFactory { ValueTask<IDbScope> CreateAsync(CancellationToken cancellationToken); }
public interface IDbScope : IAsyncDisposable { Task SaveChangesAsync(string value, CancellationToken cancellationToken); }
public sealed record ImportResult(string File, string Value);

public sealed class Importer(IFileParser parser, IDbScopeFactory scopes)
{
    public async Task<ImportResult> ImportAsync(string file, CancellationToken cancellationToken)
    {
        await using var scope = await scopes.CreateAsync(cancellationToken);
        var value = await parser.ParseAsync(file, cancellationToken);
        await scope.SaveChangesAsync(value, cancellationToken);
        return new ImportResult(file, value);
    }
}
`;

const DOTNET_DISPOSAL_HIDDEN = `using KoryFixture;
using System.Threading;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }
var normalFactory = new Factory();
var normal = await new Importer(new Parser(), normalFactory).ImportAsync("normal", CancellationToken.None);
Check(normal.Value == "parsed:normal" && normalFactory.Active == 0 && normalFactory.Disposals == 1, "normal disposal");
var parserFailureFactory = new Factory();
try { await new Importer(new Parser(fail:true), parserFailureFactory).ImportAsync("bad", CancellationToken.None); throw new Exception("parser failure not observed"); }
catch (InvalidDataException) { }
Check(parserFailureFactory.Active == 0 && parserFailureFactory.Disposals == 1, "parser failure leaked scope");
var beforeSave = new CancellationTokenSource();
var beforeFactory = new Factory();
try { await new Importer(new Parser(cancel:beforeSave), beforeFactory).ImportAsync("before-save", beforeSave.Token); throw new Exception("cancellation not observed"); }
catch (OperationCanceledException) { }
Check(beforeFactory.Active == 0 && beforeFactory.Disposals == 1 && beforeFactory.Commits == 0, "before-save cleanup");
var duringSave = new CancellationTokenSource();
var duringFactory = new Factory(duringSave);
try { await new Importer(new Parser(), duringFactory).ImportAsync("during-save", duringSave.Token); throw new Exception("during-save cancellation not observed"); }
catch (OperationCanceledException) { }
Check(duringFactory.Active == 0 && duringFactory.Disposals == 1 && duringFactory.Commits == 0, "during-save cleanup");
var afterCommit = new CancellationTokenSource();
var afterFactory = new Factory(cancelAfterCommit:afterCommit);
var committed = await new Importer(new Parser(), afterFactory).ImportAsync("committed", afterCommit.Token);
Check(committed.Value == "parsed:committed" && afterFactory.Commits == 1 && afterFactory.Disposals == 1 && afterFactory.Active == 0, "commit converted to cancellation or leaked");
Console.WriteLine("KORY_DOTNET_OK");

sealed class Parser(bool fail = false, CancellationTokenSource? cancel = null) : IFileParser {
    public Task<string> ParseAsync(string file, CancellationToken token) {
        token.ThrowIfCancellationRequested();
        if (fail) throw new InvalidDataException("parse");
        cancel?.Cancel();
        return Task.FromResult("parsed:" + file);
    }
}
sealed class Factory(CancellationTokenSource? cancelDuringSave = null, CancellationTokenSource? cancelAfterCommit = null) : IDbScopeFactory {
    readonly CancellationTokenSource? duringSave = cancelDuringSave;
    readonly CancellationTokenSource? afterCommit = cancelAfterCommit;
    public int Active; public int Disposals; public int Commits;
    public ValueTask<IDbScope> CreateAsync(CancellationToken token) { token.ThrowIfCancellationRequested(); Active++; return ValueTask.FromResult<IDbScope>(new Scope(this)); }
    sealed class Scope(Factory owner) : IDbScope {
        int disposed;
        public async Task SaveChangesAsync(string value, CancellationToken token) {
            if (owner.duringSave is not null) { owner.duringSave.Cancel(); await Task.Yield(); }
            token.ThrowIfCancellationRequested();
            owner.Commits++;
            owner.afterCommit?.Cancel();
        }
        public ValueTask DisposeAsync() { if (Interlocked.Exchange(ref disposed, 1) != 0) throw new Exception("double dispose"); owner.Active--; owner.Disposals++; return ValueTask.CompletedTask; }
    }
}
`;

const DOTNET_JSON_STARTER = `using System.Text.Json;

namespace KoryFixture;

public sealed record RetryPolicy(int MaxAttempts, int BackoffMs);
public sealed record Job(string Id, string Payload, RetryPolicy? Retry);
public sealed record RetainedJob(int Index, string Raw, string Reason);
public sealed record QueueLoad(IReadOnlyList<Job> Jobs, IReadOnlyList<RetainedJob> Retained);

public static class JobCodec
{
    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    public static Job Decode(string json)
    {
        var job = JsonSerializer.Deserialize<Job>(json, Options) ?? throw new JsonException("null job");
        if (job.Retry is null) throw new JsonException("retry is required");
        return job;
    }
    public static string Encode(Job value) => JsonSerializer.Serialize(value, Options);
    public static QueueLoad LoadQueue(IEnumerable<string> lines)
    {
        var jobs = new List<Job>();
        var retained = new List<RetainedJob>();
        var index = 0;
        foreach (var line in lines) { jobs.Add(Decode(line)); index++; }
        return new QueueLoad(jobs, retained);
    }
}
`;

export const DOTNET_JSON_CONTROL = `using System.Text.Json;

namespace KoryFixture;

public sealed record RetryPolicy(int MaxAttempts, int BackoffMs)
{
    public static RetryPolicy Default { get; } = new(1, 0);
}
public sealed record Job(string Id, string Payload, RetryPolicy Retry);
public sealed record RetainedJob(int Index, string Raw, string Reason);
public sealed record QueueLoad(IReadOnlyList<Job> Jobs, IReadOnlyList<RetainedJob> Retained);

public static class JobCodec
{
    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = false };
    sealed record WireJob(string Id, string Payload, RetryPolicy? Retry);
    public static Job Decode(string json)
    {
        var wire = JsonSerializer.Deserialize<WireJob>(json, Options) ?? throw new JsonException("null job");
        if (string.IsNullOrWhiteSpace(wire.Id) || wire.Payload is null) throw new JsonException("invalid job");
        var retry = wire.Retry ?? RetryPolicy.Default;
        if (retry.MaxAttempts is < 1 or > 10 || retry.BackoffMs is < 0 or > 60000) throw new JsonException("invalid retry policy");
        return new Job(wire.Id, wire.Payload, retry);
    }
    public static string Encode(Job value) => JsonSerializer.Serialize(value, Options);
    public static QueueLoad LoadQueue(IEnumerable<string> lines)
    {
        var jobs = new List<Job>(); var retained = new List<RetainedJob>(); var index = 0;
        foreach (var line in lines) {
            try { jobs.Add(Decode(line)); }
            catch (JsonException e) { retained.Add(new RetainedJob(index, line, e.Message)); }
            index++;
        }
        return new QueueLoad(jobs, retained);
    }
}
`;

const DOTNET_JSON_HIDDEN = `using KoryFixture;
using System.Text.Json;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }
var old = JobCodec.Decode("""{"id":"old","payload":"p"}""");
Check(old.Retry.MaxAttempts == 1 && old.Retry.BackoffMs == 0, "old default");
var modern = new Job("new", "p", new RetryPolicy(3, 250));
var encoded = JobCodec.Encode(modern);
var roundTrip = JobCodec.Decode(encoded);
Check(roundTrip == modern, "new roundtrip");
using (var doc = JsonDocument.Parse(encoded)) {
    var root = doc.RootElement;
    Check(root.GetProperty("id").GetString() == "new" && root.GetProperty("payload").GetString() == "p", "old worker fields");
}
foreach (var bad in new[]{
    """{"id":"bad","payload":"p","retry":{"maxAttempts":0,"backoffMs":1}}""",
    """{"id":"bad","payload":"p","retry":{"maxAttempts":2,"backoffMs":-1}}""",
    "not-json"
}) { try { _ = JobCodec.Decode(bad); throw new Exception("invalid retry accepted: " + bad); } catch (JsonException) { } }
var lines = new[]{"""{"id":"a","payload":"x"}""", "not-json", encoded, """{"id":"b","payload":"y","future":true}"""};
var first = JobCodec.LoadQueue(lines); var second = JobCodec.LoadQueue(lines);
Check(first.Jobs.Count == 3 && first.Retained.Count == 1, "restart recovery counts");
Check(second.Jobs.Select(x=>x.Id).SequenceEqual(first.Jobs.Select(x=>x.Id)) && second.Retained[0].Raw == first.Retained[0].Raw, "restart nondeterminism");
Console.WriteLine("KORY_DOTNET_OK");
`;

function materializeGoBase(root: string, readme: string): void {
  writeRuntime(root, 'go');
  writeFixtureFile(root, 'go.mod', GO_MOD);
  writeFixtureFile(root, 'README.md', readme);
}

function materializePhpBase(root: string, readme: string): void {
  writeRuntime(root, 'php');
  writeFixtureFile(root, 'composer.json', PHP_COMPOSER);
  writeFixtureFile(root, 'README.md', readme);
}

function materializeDotnetBase(root: string, readme: string): void {
  writeRuntime(root, 'dotnet');
  writeFixtureFile(root, 'KoryFixture.csproj', DOTNET_PROJECT);
  writeFixtureFile(root, 'tests/KoryFixture.Regression.csproj', DOTNET_REGRESSION_PROJECT);
  writeFixtureFile(root, 'README.md', readme);
}

/** The process exit code alone does not prove Go tests ran: TestMain can skip m.Run(). */
function hiddenGoTestsExecuted(output: string, scenarioId: string): boolean {
  const contextScenario = scenarioId === GO_CONTEXT_SCENARIO;
  const expectedPackage = `example.com/kory-eval/${contextScenario ? 'batch' : 'repo'}`;
  const requiredTests = contextScenario
    ? [
        'TestKoryCancellationOwnership',
        'TestKoryPartialTimeout',
        'TestKoryAllSuccessAndHTTPResponse',
        'TestKoryHandlerDeadlineAndInvalidJSON',
      ]
    : ['TestKoryNilAndErrorIdentity'];
  const events = new Map<string, Set<string>>();
  for (const line of output.split('\n')) {
    let entry: { Package?: string; Test?: string; Action?: string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (
      entry.Package !== expectedPackage ||
      !entry.Test ||
      (entry.Action !== 'run' && entry.Action !== 'pass')
    )
      continue;
    const actions = events.get(entry.Test) ?? new Set<string>();
    actions.add(entry.Action);
    events.set(entry.Test, actions);
  }
  return requiredTests.every((name) =>
    ['run', 'pass'].every((action) => events.get(name)?.has(action)),
  );
}

function scoreGo(
  root: string,
  scenarioId: string,
  hidden: string,
  readme: string,
  patterns: RegExp[],
): SkillEvalDeterministicScore {
  const fixed = { ...runtimeFiles('go'), 'go.mod': GO_MOD, 'README.md': readme };
  const changedImmutableInputs = () =>
    Object.entries(fixed)
      .filter(([path, expected]) => !fixtureTextEquals(root, path, expected))
      .map(([path]) => path);
  const changedBefore = changedImmutableInputs();
  if (changedBefore.length)
    return fail(
      [`Immutable Go runtime/contract input changed: ${changedBefore.join(', ')}.`],
      true,
    );
  // Hidden Go tests must not be counted as candidate-authored regression coverage.
  const regressions = regressionText(root, /_test\.go$/u, patterns);
  // Go ignores files starting with '_' or '.', and a fixed name could overwrite candidate work.
  const directory = scenarioId === GO_CONTEXT_SCENARIO ? 'batch' : 'repo';
  const hiddenPath = `${directory}/kory_hidden_${randomUUID().replaceAll('-', '')}_test.go`;
  writeFixtureFile(root, hiddenPath, hidden);
  try {
    const execution = run(
      join(root, '.kory-runtime/go'),
      ['test', '-race', '-json', './...', '-count=1', `-timeout=${GO_TEST_TIMEOUT}`],
      root,
      GO_RACE_PROCESS_TIMEOUT_MS,
      {
        GOCACHE: join(root, '.gocache'),
        GOMODCACHE: join(root, '.gomodcache'),
      },
    );
    const changedAfter = changedImmutableInputs();
    if (changedAfter.length)
      return fail(
        [`Immutable Go runtime/contract input changed: ${changedAfter.join(', ')}.`],
        true,
      );
    const completed = execution.code === 0 && !execution.timedOut;
    const runtimePassed = completed && hiddenGoTestsExecuted(execution.stdout, scenarioId);
    const passed = runtimePassed && regressions;
    return {
      passed,
      quality: passed ? 1 : runtimePassed ? 0.75 : 0,
      verification: runtimePassed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Go ${V5_HOST_RUNTIME_VERSIONS.go} race/runtime checks: ${runtimePassed ? 'pass' : execution.timedOut ? 'timeout' : completed ? 'fail (hidden tests skipped)' : 'fail'}`,
        `candidate regression coverage: ${regressions ? 'present' : 'missing'}`,
        `${execution.stdout}\n${execution.stderr}`.slice(-5000),
      ],
    };
  } finally {
    rmSync(join(root, hiddenPath), { force: true });
  }
}

/** Candidate-authored regressions must detect the original defect, not merely exit zero. */
function phpRegressionDetectsStarter(
  root: string,
  sourcePath: string,
  defectiveStarter: string,
): boolean {
  let candidateSource: string;
  try {
    candidateSource = readFixtureText(root, sourcePath);
  } catch {
    return false;
  }
  try {
    writeFixtureFile(root, sourcePath, defectiveStarter);
    const execution = run(
      join(root, '.kory-runtime/php'),
      ['-d', 'display_errors=1', '-d', 'zend.assertions=1', '-d', 'assert.exception=1', 'tests/regression.php'],
      root,
      8_000,
    );
    return execution.code !== 0 && !execution.timedOut;
  } finally {
    writeFixtureFile(root, sourcePath, candidateSource);
  }
}

function scorePhp(
  root: string,
  hidden: string,
  readme: string,
  patterns: RegExp[],
  sourcePath: string,
  defectiveStarter: string,
): SkillEvalDeterministicScore {
  const fixed = { ...runtimeFiles('php'), 'composer.json': PHP_COMPOSER, 'README.md': readme };
  if (!intact(root, fixed)) return fail(['Immutable PHP runtime/contract input changed.'], true);
  const composer = run(
    join(root, '.kory-runtime/composer'),
    ['validate', '--strict', '--no-check-publish', '--no-ansi'],
    root,
    8_000,
  );
  // A source-text heuristic alone can accept regressions that were never run.
  const regressions = authoredRegressionText(root, /\.php$/u, patterns);
  const candidateRegression = run(
    join(root, '.kory-runtime/php'),
    ['-d', 'display_errors=1', '-d', 'zend.assertions=1', '-d', 'assert.exception=1', 'tests/regression.php'],
    root,
    8_000,
  );
  const candidateTestsPassed = candidateRegression.code === 0 && !candidateRegression.timedOut;
  const detectsStarter =
    regressions && candidateTestsPassed &&
    phpRegressionDetectsStarter(root, sourcePath, defectiveStarter);
  if (!intact(root, fixed)) return fail(['Candidate regression modified an immutable PHP runtime/contract input.'], true);
  const hiddenPath = `__kory_hidden_${randomUUID().replaceAll('-', '')}.php`;
  writeFixtureFile(root, hiddenPath, hidden);
  try {
    const execution = run(
      join(root, '.kory-runtime/php'),
      ['-d', 'display_errors=1', hiddenPath],
      root,
      8_000,
    );
    const runtimePassed =
      execution.code === 0 && !execution.timedOut && /KORY_PHP_OK/u.test(execution.stdout);
    const passed = composer.code === 0 && runtimePassed && regressions && candidateTestsPassed && detectsStarter;
    return {
      passed,
      quality: passed ? 1 : runtimePassed && composer.code === 0 && candidateTestsPassed ? 0.75 : 0,
      verification: runtimePassed && composer.code === 0 ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Composer validation: ${composer.code === 0 ? 'pass' : 'fail'}`,
        `PHP ${V5_HOST_RUNTIME_VERSIONS.php} runtime checks: ${runtimePassed ? 'pass' : execution.timedOut ? 'timeout' : 'fail'}`,
        `candidate regression coverage: ${regressions ? 'present' : 'missing'}; execution: ${candidateTestsPassed ? 'pass' : candidateRegression.timedOut ? 'timeout' : 'fail'}`,
        `${execution.stdout}\n${execution.stderr}\n${candidateRegression.stdout}\n${candidateRegression.stderr}\n${composer.stdout}\n${composer.stderr}`.slice(-5000),
        `candidate regressions reject original defective starter: ${detectsStarter ? 'yes' : 'no'}`,
      ],
    };
  } finally {
    rmSync(join(root, hiddenPath), { force: true });
  }
}

function scoreDotnet(
  root: string,
  hiddenSource: string,
  sourcePath: string,
  readme: string,
  patterns: RegExp[],
): SkillEvalDeterministicScore {
  const fixed = {
    ...runtimeFiles('dotnet'),
    'KoryFixture.csproj': DOTNET_PROJECT,
    'tests/KoryFixture.Regression.csproj': DOTNET_REGRESSION_PROJECT,
    'README.md': readme,
  };
  if (!intact(root, fixed)) return fail(['Immutable .NET runtime/contract input changed.'], true);
  const source = existsSync(join(root, sourcePath))
    ? readFileSync(join(root, sourcePath), 'utf8')
    : '';
  const noSyncBlocking = !/\.Result\b|\.Wait\s*\(/u.test(source);
  const regressions = authoredRegressionText(root, /\.cs$/u, patterns);
  const regressionRun = run(
    join(root, '.kory-runtime/dotnet'),
    ['run', '--project', 'tests/KoryFixture.Regression.csproj', '--configuration', 'Release'],
    root,
    18_000,
  );
  const regressionExecuted = regressionRun.code === 0 && !regressionRun.timedOut;
  // Build the candidate project independently before the hidden runtime check.
  // ProjectReference builds can leave the SDK's incremental ref/ output absent
  // when the candidate and checker use distinct temp homes or NuGet caches.
  const projectBuild = run(
    join(root, '.kory-runtime/dotnet'),
    ['build', 'KoryFixture.csproj', '--configuration', 'Release'],
    root,
    18_000,
  );
  const assemblyPath = join(root, 'bin', 'Release', 'net10.0', 'KoryFixture.dll');
  const projectBuilt = projectBuild.code === 0 && !projectBuild.timedOut && existsSync(assemblyPath);
  const hiddenRoot = mkdtempSync(join(tmpdir(), 'kory-dotnet-hidden-'));
  const compiledAssembly = projectBuilt
    ? canonicalizePath(assemblyPath)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
    : '';
  writeFileSync(
    join(hiddenRoot, 'Hidden.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings><LangVersion>14.0</LangVersion></PropertyGroup><ItemGroup><Reference Include="KoryFixture"><HintPath>${compiledAssembly}</HintPath></Reference></ItemGroup></Project>\n`,
  );
  writeFileSync(join(hiddenRoot, 'Program.cs'), hiddenSource);
  try {
    const execution = projectBuilt
      ? run(
          join(root, '.kory-runtime/dotnet'),
          ['run', '--project', join(hiddenRoot, 'Hidden.csproj'), '--configuration', 'Release'],
          hiddenRoot,
          18_000,
          { DOTNET_CLI_HOME: hiddenRoot, NUGET_PACKAGES: join(hiddenRoot, '.nuget') },
        )
      : { code: null, stdout: '', stderr: 'Candidate project build failed.', timedOut: false };
    const runtimePassed =
      projectBuilt && execution.code === 0 && !execution.timedOut && /KORY_DOTNET_OK/u.test(execution.stdout);
    const passed = runtimePassed && regressions && regressionExecuted && noSyncBlocking;
    return {
      passed,
      quality: passed ? 1 : runtimePassed && noSyncBlocking ? 0.8 : 0,
      verification: runtimePassed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `candidate .NET project build: ${projectBuilt ? 'pass' : projectBuild.timedOut ? 'timeout' : 'fail'}`,
        `.NET SDK ${V5_HOST_RUNTIME_VERSIONS.dotnet} compiled runtime checks: ${runtimePassed ? 'pass' : execution.timedOut ? 'timeout' : 'fail'}`,
        `sync-over-async workaround: ${noSyncBlocking ? 'absent' : 'present'}`,
        `candidate regression coverage: ${regressions ? 'present' : 'missing'}; execution: ${regressionExecuted ? 'pass' : regressionRun.timedOut ? 'timeout' : 'fail'}`,
        `${projectBuild.stdout}\n${projectBuild.stderr}\n${execution.stdout}\n${execution.stderr}\n${regressionRun.stdout}\n${regressionRun.stderr}`.slice(-6000),
      ],
    };
  } finally {
    rmSync(hiddenRoot, { recursive: true, force: true });
  }
}

export const V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'go-engineering/actual-go-context-goroutines@3',
    realRuntime: true,
    readinessBlockers: goHostReadiness(),
    matches: (scenario) => scenario.id === GO_CONTEXT_SCENARIO,
    materialize: (root) => {
      materializeGoBase(root, GO_CONTEXT_README);
      writeFixtureFile(root, 'batch/batch.go', GO_CONTEXT_STARTER);
      writeFixtureFile(
        root,
        'batch/batch_test.go',
        'package batch\nimport "testing"\nfunc TestPublicSmoke(t *testing.T) { if (Response{}).Results != nil { t.Fatal("zero value") } }\n',
      );
    },
  },
  {
    id: 'go-engineering/actual-go-typed-nil@1',
    realRuntime: true,
    readinessBlockers: goHostReadiness(),
    matches: (scenario) => scenario.id === GO_NIL_SCENARIO,
    materialize: (root) => {
      materializeGoBase(root, GO_NIL_README);
      writeFixtureFile(root, 'repo/repo.go', GO_NIL_STARTER);
      writeFixtureFile(
        root,
        'repo/repo_test.go',
        'package repo\nimport "testing"\nfunc TestPublicSentinel(t *testing.T) { if ErrNotFound == nil { t.Fatal("sentinel") } }\n',
      );
    },
  },
  {
    id: 'php-engineering/actual-php-worker-lifecycle@4',
    realRuntime: true,
    readinessBlockers: phpHostReadiness(),
    matches: (scenario) => scenario.id === PHP_WORKER_SCENARIO,
    materialize: (root) => {
      materializePhpBase(root, PHP_WORKER_README);
      writeFixtureFile(root, 'src/Worker.php', PHP_WORKER_STARTER);
      writeFixtureFile(
        root,
        'tests/regression.php',
        '<?php\n// Add assertions for alternating tenant, exception, Fiber/concurrent mode, recycle and immutable cache behavior.\n',
      );
    },
  },
  {
    id: 'php-engineering/actual-php-strict-json@4',
    realRuntime: true,
    readinessBlockers: phpHostReadiness(),
    matches: (scenario) => scenario.id === PHP_JSON_SCENARIO,
    materialize: (root) => {
      materializePhpBase(root, PHP_JSON_README);
      writeFixtureFile(root, 'src/RequestDecoder.php', PHP_JSON_STARTER);
      writeFixtureFile(
        root,
        'tests/regression.php',
        '<?php\n// Add assertions for missing/null/false/string/integer/overflow/invalid JSON and valid compatibility payloads.\n',
      );
    },
  },
  {
    id: 'csharp-dotnet-engineering/actual-dotnet-async-disposal@2',
    realRuntime: true,
    readinessBlockers: dotnetHostReadiness(),
    matches: (scenario) => scenario.id === DOTNET_DISPOSAL_SCENARIO,
    materialize: (root) => {
      materializeDotnetBase(root, DOTNET_DISPOSAL_README);
      writeFixtureFile(root, 'Importer.cs', DOTNET_DISPOSAL_STARTER);
      writeFixtureFile(
        root,
        'tests/regression.cs',
        '// Add normal, parser-failure, before-save, during-save, after-commit and disposal regressions.\n',
      );
    },
  },
  {
    id: 'csharp-dotnet-engineering/actual-dotnet-json-compat@4',
    realRuntime: true,
    readinessBlockers: dotnetHostReadiness(),
    matches: (scenario) => scenario.id === DOTNET_JSON_SCENARIO,
    materialize: (root) => {
      materializeDotnetBase(root, DOTNET_JSON_README);
      writeFixtureFile(root, 'JobCodec.cs', DOTNET_JSON_STARTER);
      writeFixtureFile(
        root,
        'tests/regression.cs',
        '// Add old/new compatibility, malformed retry, retained queue entry and repeated restart regressions.\n',
      );
    },
  },
];

export const V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'go-engineering/actual-go-context-goroutines-scorer@5',
    scenarioIds: [GO_CONTEXT_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreGo(workingDirectory, GO_CONTEXT_SCENARIO, GO_CONTEXT_HIDDEN, GO_CONTEXT_README, [
        /cancel|context|timeout/iu,
        /slow|goroutine|leak|race/iu,
      ]),
  },
  {
    id: 'go-engineering/actual-go-typed-nil-scorer@5',
    scenarioIds: [GO_NIL_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreGo(workingDirectory, GO_NIL_SCENARIO, GO_NIL_HIDDEN, GO_NIL_README, [
        /nil|absence|missing/iu,
        /errors?\.(?:Is|As)|wrapped|unexpected/iu,
      ]),
  },
  {
    id: 'php-engineering/actual-php-worker-lifecycle-scorer@5',
    scenarioIds: [PHP_WORKER_SCENARIO],
    score: ({ workingDirectory }) =>
      scorePhp(workingDirectory, PHP_WORKER_HIDDEN, PHP_WORKER_README, [
        /tenant|alternat|request/iu,
        /exception|fiber|recycle|cache/iu,
      ], 'src/Worker.php', PHP_WORKER_STARTER),
  },
  {
    id: 'php-engineering/actual-php-strict-json-scorer@6',
    scenarioIds: [PHP_JSON_SCENARIO],
    score: ({ workingDirectory }) =>
      scorePhp(workingDirectory, PHP_JSON_HIDDEN, PHP_JSON_README, [
        /missing|null|false|boolean|numeric|string/iu,
        /overflow|invalid|utf|compat|valid/iu,
      ], 'src/RequestDecoder.php', PHP_JSON_STARTER),
  },
  {
    id: 'csharp-dotnet-engineering/actual-dotnet-async-disposal-scorer@6',
    scenarioIds: [DOTNET_DISPOSAL_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreDotnet(workingDirectory, DOTNET_DISPOSAL_HIDDEN, 'Importer.cs', DOTNET_DISPOSAL_README, [
        /cancel|before|during|after|commit/iu,
        /dispose|parser|normal|pool|scope/iu,
      ]),
  },
  {
    id: 'csharp-dotnet-engineering/actual-dotnet-json-compat-scorer@6',
    scenarioIds: [DOTNET_JSON_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreDotnet(workingDirectory, DOTNET_JSON_HIDDEN, 'JobCodec.cs', DOTNET_JSON_README, [
        /old|new|compat|rolling|retry/iu,
        /malform|retain|restart|queue/iu,
      ]),
  },
];

/** Author control: verifies evaluator child processes fail closed on a real wall-clock bound. */
export function probeV5RuntimeTimeout(executable: string, args: string[], cwd: string): boolean {
  return run(executable, args, cwd, 50).timedOut;
}
