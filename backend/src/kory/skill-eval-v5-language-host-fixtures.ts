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
import { join, resolve } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { fixtureTextEquals, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

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

const GO_CONTEXT_README =
  '# Go context/goroutine ownership fixture\n\nFix batch/batch.go. Preserve the Response JSON fields, bounded maxConcurrency behavior and partial results. Use ./.kory-runtime/go for the pinned Go runtime. Add focused cancellation, timeout, slow-dependency, success and leak/race regression tests.\n';
const GO_NIL_README =
  '# Go typed-nil/error identity fixture\n\nFix repo/repo.go at the repository boundary so optional absence returns a true nil error while real NotFoundError values keep errors.Is/errors.As identity. Use ./.kory-runtime/go and add regressions for nil, wrapped not-found and unexpected errors.\n';
const PHP_WORKER_README =
  '# PHP long-lived worker fixture\n\nFix src/Worker.php without disabling the safe immutable cache. Request identity must not survive its request, including exception, Fiber and worker-recycle sequences. Use ./.kory-runtime/php and ./.kory-runtime/composer. Add runtime regressions in tests/.\n';
const PHP_JSON_README =
  '# PHP strict JSON boundary fixture\n\nFix src/RequestDecoder.php so missing, null, boolean, numeric string, integer and overflow states remain distinct before typed Quantity conversion while preserving the documented status/error shape. Use the pinned runtime wrappers and add regressions in tests/.\n';
const DOTNET_DISPOSAL_README =
  '# .NET async disposal/cancellation fixture\n\nFix Importer.cs. Preserve ImportAsync and result/error semantics, propagate CancellationToken through real async boundaries, dispose each acquired async scope exactly once, and do not use sync-over-async. Use ./.kory-runtime/dotnet and add cancellation/disposal regressions.\n';
const DOTNET_JSON_README =
  '# .NET persisted JSON compatibility fixture\n\nFix JobCodec.cs for the rolling compatibility window. Old payloads need a deterministic retry default, new retry values need bounded validation, additive payloads remain readable by old workers, and malformed queue entries must be retained without aborting later valid jobs. Use the pinned .NET wrapper and add restart/compatibility regressions.\n';

const GO_MOD = `module example.com/kory-eval\n\ngo ${V5_HOST_RUNTIME_VERSIONS.go}\n`;
const PHP_COMPOSER = `${JSON.stringify(
  { name: 'kory/eval-fixture', type: 'project', require: { php: V5_HOST_RUNTIME_VERSIONS.php } },
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
    "context"
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

export const PHP_WORKER_CONTROL = PHP_WORKER_STARTER.replace(
  'return self::$requestContext ??= new TenantContext($tenantId);',
  'return new TenantContext($tenantId);',
);

const PHP_WORKER_HIDDEN = `<?php
declare(strict_types=1);
require __DIR__ . '/src/Worker.php';
function checkKory(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
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
checkKory(ServiceCache::immutableEntries() === 1, 'immutable cache was disabled instead of preserved');
ServiceCache::recycle();
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
        try { $data = json_decode($json, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING); }
        catch (JsonException $e) { return ['ok'=>false, 'status'=>400, 'error'=>'INVALID_JSON']; }
        if (!is_array($data)) return ['ok'=>false, 'status'=>422, 'error'=>'INVALID_TYPE'];
        if (!array_key_exists('quantity', $data)) return ['ok'=>false, 'status'=>422, 'error'=>'MISSING_QUANTITY'];
        $value = $data['quantity'];
        if ($value === null) return ['ok'=>false, 'status'=>422, 'error'=>'NULL_QUANTITY'];
        if (!is_int($value)) {
            if (is_string($value) && preg_match('/^-?[0-9]+$/D', $value) === 1 && strlen(ltrim($value, '-')) > 10)
                return ['ok'=>false, 'status'=>422, 'error'=>'OUT_OF_RANGE'];
            return ['ok'=>false, 'status'=>422, 'error'=>'INVALID_TYPE'];
        }
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
expectKoryError('{"quantity":false}', 'INVALID_TYPE');
expectKoryError('{"quantity":"0"}', 'INVALID_TYPE');
expectKoryError('{"quantity":100000000000000000000}', 'OUT_OF_RANGE');
expectKoryError('{bad', 'INVALID_JSON', 400);
expectKoryError("{\"quantity\":\"\xC3\x28\"}", 'INVALID_JSON', 400);
$zero = RequestDecoder::decode('{"quantity":0}');
if (($zero['ok'] ?? false) !== true || !($zero['value'] instanceof Quantity) || $zero['value']->value !== 0) throw new RuntimeException('integer zero rejected');
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
    public int Active; public int Disposals; public int Commits;
    public ValueTask<IDbScope> CreateAsync(CancellationToken token) { token.ThrowIfCancellationRequested(); Active++; return ValueTask.FromResult<IDbScope>(new Scope(this)); }
    sealed class Scope(Factory owner) : IDbScope {
        int disposed;
        public async Task SaveChangesAsync(string value, CancellationToken token) {
            if (cancelDuringSave is not null) { cancelDuringSave.Cancel(); await Task.Yield(); }
            token.ThrowIfCancellationRequested();
            owner.Commits++;
            cancelAfterCommit?.Cancel();
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
    public static QueueLoad(IEnumerable<string> lines)
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
    public static QueueLoad(IEnumerable<string> lines)
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
var old = JobCodec.Decode("{\"id\":\"old\",\"payload\":\"p\"}");
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
    "{\"id\":\"bad\",\"payload\":\"p\",\"retry\":{\"maxAttempts\":0,\"backoffMs\":1}}",
    "{\"id\":\"bad\",\"payload\":\"p\",\"retry\":{\"maxAttempts\":2,\"backoffMs\":-1}}",
    "not-json"
}) { try { _ = JobCodec.Decode(bad); throw new Exception("invalid retry accepted: " + bad); } catch (JsonException) { } }
var lines = new[]{"{\"id\":\"a\",\"payload\":\"x\"}", "not-json", encoded, "{\"id\":\"b\",\"payload\":\"y\",\"future\":true}"};
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
  writeFixtureFile(root, 'README.md', readme);
}

function scoreGo(
  root: string,
  scenarioId: string,
  hidden: string,
  readme: string,
  patterns: RegExp[],
): SkillEvalDeterministicScore {
  const fixed = { ...runtimeFiles('go'), 'go.mod': GO_MOD, 'README.md': readme };
  if (!intact(root, fixed)) return fail(['Immutable Go runtime/contract input changed.'], true);
  const hiddenPath =
    scenarioId === GO_CONTEXT_SCENARIO
      ? 'batch/__kory_hidden_test.go'
      : 'repo/__kory_hidden_test.go';
  writeFixtureFile(root, hiddenPath, hidden);
  try {
    const execution = run(
      join(root, '.kory-runtime/go'),
      ['test', '-race', './...', '-count=1'],
      root,
      15_000,
      {
        GOCACHE: join(root, '.gocache'),
        GOMODCACHE: join(root, '.gomodcache'),
      },
    );
    const regressions = regressionText(root, /_test\.go$/u, patterns);
    const runtimePassed = execution.code === 0 && !execution.timedOut;
    const passed = runtimePassed && regressions;
    return {
      passed,
      quality: passed ? 1 : runtimePassed ? 0.75 : 0,
      verification: runtimePassed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Go ${V5_HOST_RUNTIME_VERSIONS.go} race/runtime checks: ${runtimePassed ? 'pass' : execution.timedOut ? 'timeout' : 'fail'}`,
        `candidate regression coverage: ${regressions ? 'present' : 'missing'}`,
        `${execution.stdout}\n${execution.stderr}`.slice(-5000),
      ],
    };
  } finally {
    rmSync(join(root, hiddenPath), { force: true });
  }
}

function scorePhp(
  root: string,
  hidden: string,
  readme: string,
  patterns: RegExp[],
): SkillEvalDeterministicScore {
  const fixed = { ...runtimeFiles('php'), 'composer.json': PHP_COMPOSER, 'README.md': readme };
  if (!intact(root, fixed)) return fail(['Immutable PHP runtime/contract input changed.'], true);
  const composer = run(
    join(root, '.kory-runtime/composer'),
    ['validate', '--strict', '--no-check-publish', '--no-ansi'],
    root,
    8_000,
  );
  const hiddenPath = `__kory_hidden_${randomUUID().replaceAll('-', '')}.php`;
  writeFixtureFile(root, hiddenPath, hidden);
  try {
    const execution = run(
      join(root, '.kory-runtime/php'),
      ['-d', 'display_errors=1', hiddenPath],
      root,
      8_000,
    );
    const regressions = regressionText(root, /\.php$/u, patterns);
    const runtimePassed =
      execution.code === 0 && !execution.timedOut && /KORY_PHP_OK/u.test(execution.stdout);
    const passed = composer.code === 0 && runtimePassed && regressions;
    return {
      passed,
      quality: passed ? 1 : runtimePassed && composer.code === 0 ? 0.75 : 0,
      verification: runtimePassed && composer.code === 0 ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Composer validation: ${composer.code === 0 ? 'pass' : 'fail'}`,
        `PHP ${V5_HOST_RUNTIME_VERSIONS.php} runtime checks: ${runtimePassed ? 'pass' : execution.timedOut ? 'timeout' : 'fail'}`,
        `candidate regression coverage: ${regressions ? 'present' : 'missing'}`,
        `${execution.stdout}\n${execution.stderr}\n${composer.stderr}`.slice(-5000),
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
    'README.md': readme,
  };
  if (!intact(root, fixed)) return fail(['Immutable .NET runtime/contract input changed.'], true);
  const source = existsSync(join(root, sourcePath))
    ? readFileSync(join(root, sourcePath), 'utf8')
    : '';
  const noSyncBlocking = !/\.Result\b|\.Wait\s*\(/u.test(source);
  const regressions = regressionText(root, /\.cs$/u, patterns);
  const hiddenRoot = mkdtempSync(join(tmpdir(), 'kory-dotnet-hidden-'));
  const projectReference = resolve(root, 'KoryFixture.csproj').replaceAll('&', '&amp;');
  writeFileSync(
    join(hiddenRoot, 'Hidden.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings><LangVersion>14.0</LangVersion></PropertyGroup><ItemGroup><ProjectReference Include="${projectReference}" /></ItemGroup></Project>\n`,
  );
  writeFileSync(join(hiddenRoot, 'Program.cs'), hiddenSource);
  try {
    const execution = run(
      join(root, '.kory-runtime/dotnet'),
      ['run', '--project', join(hiddenRoot, 'Hidden.csproj'), '--configuration', 'Release'],
      hiddenRoot,
      18_000,
      { DOTNET_CLI_HOME: hiddenRoot, NUGET_PACKAGES: join(hiddenRoot, '.nuget') },
    );
    const runtimePassed =
      execution.code === 0 && !execution.timedOut && /KORY_DOTNET_OK/u.test(execution.stdout);
    const passed = runtimePassed && regressions && noSyncBlocking;
    return {
      passed,
      quality: passed ? 1 : runtimePassed && noSyncBlocking ? 0.8 : 0,
      verification: runtimePassed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `.NET SDK ${V5_HOST_RUNTIME_VERSIONS.dotnet} compiled runtime checks: ${runtimePassed ? 'pass' : execution.timedOut ? 'timeout' : 'fail'}`,
        `sync-over-async workaround: ${noSyncBlocking ? 'absent' : 'present'}`,
        `candidate regression coverage: ${regressions ? 'present' : 'missing'}`,
        `${execution.stdout}\n${execution.stderr}`.slice(-6000),
      ],
    };
  } finally {
    rmSync(hiddenRoot, { recursive: true, force: true });
  }
}

export const V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'go-engineering/actual-go-context-goroutines@1',
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
    id: 'php-engineering/actual-php-worker-lifecycle@1',
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
    id: 'php-engineering/actual-php-strict-json@1',
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
    id: 'csharp-dotnet-engineering/actual-dotnet-async-disposal@1',
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
    id: 'csharp-dotnet-engineering/actual-dotnet-json-compat@1',
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
    id: 'go-engineering/actual-go-context-goroutines-scorer@1',
    scenarioIds: [GO_CONTEXT_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreGo(workingDirectory, GO_CONTEXT_SCENARIO, GO_CONTEXT_HIDDEN, GO_CONTEXT_README, [
        /cancel|context|timeout/iu,
        /slow|goroutine|leak|race/iu,
      ]),
  },
  {
    id: 'go-engineering/actual-go-typed-nil-scorer@1',
    scenarioIds: [GO_NIL_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreGo(workingDirectory, GO_NIL_SCENARIO, GO_NIL_HIDDEN, GO_NIL_README, [
        /nil|absence|missing/iu,
        /errors?\.(?:Is|As)|wrapped|unexpected/iu,
      ]),
  },
  {
    id: 'php-engineering/actual-php-worker-lifecycle-scorer@1',
    scenarioIds: [PHP_WORKER_SCENARIO],
    score: ({ workingDirectory }) =>
      scorePhp(workingDirectory, PHP_WORKER_HIDDEN, PHP_WORKER_README, [
        /tenant|alternat|request/iu,
        /exception|fiber|recycle|cache/iu,
      ]),
  },
  {
    id: 'php-engineering/actual-php-strict-json-scorer@1',
    scenarioIds: [PHP_JSON_SCENARIO],
    score: ({ workingDirectory }) =>
      scorePhp(workingDirectory, PHP_JSON_HIDDEN, PHP_JSON_README, [
        /missing|null|false|boolean|numeric|string/iu,
        /overflow|invalid|utf|compat|valid/iu,
      ]),
  },
  {
    id: 'csharp-dotnet-engineering/actual-dotnet-async-disposal-scorer@1',
    scenarioIds: [DOTNET_DISPOSAL_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreDotnet(workingDirectory, DOTNET_DISPOSAL_HIDDEN, 'Importer.cs', DOTNET_DISPOSAL_README, [
        /cancel|before|during|after|commit/iu,
        /dispose|parser|normal|pool|scope/iu,
      ]),
  },
  {
    id: 'csharp-dotnet-engineering/actual-dotnet-json-compat-scorer@1',
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
