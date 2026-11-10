import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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

export const PROPERTY_QUERY_SCENARIO = 'property-fuzz-differential-testing-full-task-1-individual';
export const PROPERTY_EXPR_SCENARIO = 'property-fuzz-differential-testing-full-task-2-individual';
export const HYPOTHESIS_VERSION = '6.167.1';
export const PYTEST_VERSION = '9.0.2';
export const JQWIK_VERSION = '1.9.3';
export const PROPERTY_SEED = '20261003';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const HYPOTHESIS_ROOT = resolve(REPO_ROOT, '.koryphaios/eval-tools/hypothesis', HYPOTHESIS_VERSION);
const PYTHON = process.env.KORY_EVAL_HYPOTHESIS_PYTHON ?? join(HYPOTHESIS_ROOT, 'bin/python');
const MAVEN = process.env.KORY_EVAL_MAVEN ?? '/opt/homebrew/bin/mvn';
const JAVA_HOME =
  process.env.KORY_EVAL_JAVA_HOME ?? '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
const M2 = resolve(REPO_ROOT, '.koryphaios/eval-tools/m2');
const JQWIK_JAR = join(M2, 'net/jqwik/jqwik-api', JQWIK_VERSION, `jqwik-api-${JQWIK_VERSION}.jar`);

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
  timeoutMs = 15_000,
  extraEnv: Record<string, string> = {},
): RunResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: cwd,
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      JAVA_HOME,
      PYTHONHASHSEED: '0',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 2_000_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

export function propertyFuzzHostReadiness(): string[] {
  const reasons: string[] = [];
  const python = run(
    PYTHON,
    ['-c', 'import hypothesis,pytest; print(hypothesis.__version__ + "|" + pytest.__version__)'],
    process.cwd(),
    10_000,
  );
  if (python.code !== 0 || python.stdout.trim() !== `${HYPOTHESIS_VERSION}|${PYTEST_VERSION}`)
    reasons.push(
      `Hypothesis fixture requires hypothesis ${HYPOTHESIS_VERSION} and pytest ${PYTEST_VERSION}; observed ${python.stdout.trim() || python.stderr.trim() || 'unavailable'}.`,
    );
  const maven = run(MAVEN, ['-v'], process.cwd(), 10_000);
  if (maven.code !== 0 || !maven.stdout.includes('Apache Maven 3.9.16'))
    reasons.push(
      `jqwik fixture requires Maven 3.9.16; observed ${maven.stdout.split('\n')[0] || 'unavailable'}.`,
    );
  if (!existsSync(JQWIK_JAR))
    reasons.push(`jqwik fixture requires jqwik ${JQWIK_VERSION} in ${M2}.`);
  return reasons;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runtimeFiles(kind: 'hypothesis' | 'jqwik'): Record<string, string> {
  if (kind === 'hypothesis') {
    return {
      '.kory-runtime/python': `#!/bin/sh\nexec ${shellQuote(PYTHON)} "$@"\n`,
      '.kory-runtime/pytest': `#!/bin/sh\nexec ${shellQuote(PYTHON)} -m pytest "$@"\n`,
      '.kory-runtime/runtime.json': `${JSON.stringify(
        {
          framework: 'hypothesis',
          hypothesis: HYPOTHESIS_VERSION,
          pytest: PYTEST_VERSION,
          seed: PROPERTY_SEED,
          python: PYTHON,
        },
        null,
        2,
      )}\n`,
    };
  }
  return {
    '.kory-runtime/mvn': `#!/bin/sh\nexport JAVA_HOME=${shellQuote(JAVA_HOME)}\nexec ${shellQuote(MAVEN)} -o -Dmaven.repo.local=${shellQuote(M2)} "$@"\n`,
    '.kory-runtime/runtime.json': `${JSON.stringify(
      {
        framework: 'jqwik',
        jqwik: JQWIK_VERSION,
        seed: PROPERTY_SEED,
        maven: MAVEN,
        javaHome: JAVA_HOME,
        offlineRepository: M2,
      },
      null,
      2,
    )}\n`,
  };
}

function materializeRuntime(root: string, kind: 'hypothesis' | 'jqwik'): void {
  for (const [path, content] of Object.entries(runtimeFiles(kind))) {
    writeFixtureFile(root, path, content);
    if (path.endsWith('/python') || path.endsWith('/pytest') || path.endsWith('/mvn'))
      chmodSync(join(root, path), 0o700);
  }
}

function intact(root: string, fixed: Record<string, string>): boolean {
  return Object.entries(fixed).every(([path, expected]) => fixtureTextEquals(root, path, expected));
}

function fail(evidence: string[], integrityFailure = false): SkillEvalDeterministicScore {
  return { passed: false, quality: 0, verification: 0, integrityFailure, evidence };
}

const QUERY_README = `# Hypothesis differential query-codec campaign

The production decoder in src/codec.py and the independent reference decoder disagree somewhere in the valid raw-wire domain. Add real Hypothesis ${HYPOTHESIS_VERSION} properties for structured round trips, valid raw wire and malformed percent escapes. Use the fixed seed ${PROPERTY_SEED}, bounded examples, campaign statistics and shrinking. Fix production behavior after the generated campaign finds the disagreement. Preserve a minimized literal-plus example as a deterministic regression outside @given. Do not edit reference/reference_codec.py or the declared runtime files. Run ./.kory-runtime/pytest --hypothesis-show-statistics --hypothesis-seed=${PROPERTY_SEED}.
`;

const QUERY_STARTER = `from urllib.parse import quote, unquote_plus

def _validate_component(value: str) -> None:
    i = 0
    while i < len(value):
        if value[i] == "%":
            if i + 2 >= len(value) or any(c not in "0123456789abcdefABCDEF" for c in value[i + 1:i + 3]):
                raise ValueError("malformed percent escape")
            i += 3
        else:
            i += 1

def decode_query(raw: str) -> list[tuple[str, str]]:
    if raw == "":
        return []
    pairs: list[tuple[str, str]] = []
    for part in raw.split("&"):
        key_raw, sep, value_raw = part.partition("=")
        if not sep:
            value_raw = ""
        _validate_component(key_raw)
        _validate_component(value_raw)
        # BUG: this protocol treats literal plus as data, not as application/x-www-form-urlencoded space.
        pairs.append((unquote_plus(key_raw), unquote_plus(value_raw)))
    return pairs

def encode_query(pairs: list[tuple[str, str]]) -> str:
    return "&".join(f"{quote(key, safe='')}={quote(value, safe='')}" for key, value in pairs)
`;

export const QUERY_CONTROL = QUERY_STARTER.replace(
  'from urllib.parse import quote, unquote_plus',
  'from urllib.parse import quote, unquote',
).replaceAll('unquote_plus(', 'unquote(');

const QUERY_REFERENCE = `def _decode_component(value: str) -> str:
    data = bytearray()
    i = 0
    while i < len(value):
        char = value[i]
        if char == "%":
            if i + 2 >= len(value):
                raise ValueError("malformed percent escape")
            token = value[i + 1:i + 3]
            if any(c not in "0123456789abcdefABCDEF" for c in token):
                raise ValueError("malformed percent escape")
            data.append(int(token, 16))
            i += 3
            continue
        data.extend(char.encode("utf-8"))
        i += 1
    return data.decode("utf-8")

def decode_reference(raw: str) -> list[tuple[str, str]]:
    if raw == "":
        return []
    result: list[tuple[str, str]] = []
    for part in raw.split("&"):
        if "=" in part:
            key, value = part.split("=", 1)
        else:
            key, value = part, ""
        result.append((_decode_component(key), _decode_component(value)))
    return result
`;

const QUERY_CORPUS = `${JSON.stringify(
  {
    valid: ['a=1', 'empty=', 'pct=%2B', 'literal=a+b', 'pair=a%20b&x=1'],
    malformed: ['x=%', 'x=%0', 'x=%GG'],
    expectedMinimalMismatch: 'x=+',
  },
  null,
  2,
)}\n`;

const QUERY_PUBLIC_STARTER = `from src.codec import decode_query

def test_happy_path():
    assert decode_query("a=1") == [("a", "1")]
`;

export const QUERY_PROPERTY_CONTROL = `from hypothesis import given, settings, strategies as st, event
from reference.reference_codec import decode_reference
from src.codec import decode_query, encode_query

component = st.text(alphabet="abcXYZ012+ -_", min_size=0, max_size=12)

@settings(max_examples=150, deadline=None)
@given(st.lists(st.tuples(component, component), max_size=5))
def test_structured_roundtrip(pairs):
    event("domain=structured-roundtrip")
    assert decode_query(encode_query(pairs)) == pairs

@settings(max_examples=200, deadline=None)
@given(component)
def test_valid_raw_wire(value):
    event("domain=valid-raw-wire")
    raw = "q=" + value.replace(" ", "%20")
    assert decode_query(raw) == decode_reference(raw)

@settings(max_examples=80, deadline=None)
@given(st.sampled_from(["%", "%0", "%GG", "%xz"]))
def test_malformed_escape_rejected(token):
    event("domain=malformed-escape")
    try:
        decode_query("q=" + token)
    except ValueError:
        return
    raise AssertionError("malformed escape accepted")

def test_literal_plus_regression():
    assert decode_query("q=+") == [("q", "+")]
`;

const QUERY_HIDDEN = `from hypothesis import given, settings, strategies as st, event
from reference.reference_codec import decode_reference
from src.codec import decode_query, encode_query

component = st.text(alphabet="abcXYZ012+ -_", min_size=0, max_size=12)

@settings(max_examples=160, deadline=None, database=None)
@given(st.lists(st.tuples(component, component), max_size=5))
def test_kory_structured_roundtrip(pairs):
    event("kory-domain=structured")
    assert decode_query(encode_query(pairs)) == pairs

@settings(max_examples=220, deadline=None, database=None)
@given(component)
def test_kory_independent_raw_oracle(value):
    event("kory-domain=raw")
    raw = "q=" + value.replace(" ", "%20")
    assert decode_query(raw) == decode_reference(raw)

@settings(max_examples=60, deadline=None, database=None)
@given(st.sampled_from(["%", "%0", "%GG", "%x0", "%0x"]))
def test_kory_malformed(token):
    event("kory-domain=malformed")
    try:
        decode_query("q=" + token)
    except ValueError:
        return
    raise AssertionError("malformed percent escape accepted")

def test_kory_minimized_regression():
    assert decode_query("q=+") == [("q", "+")]
`;

const EXPR_README = `# jqwik differential expression campaign

The production fixture has independently implemented evalFast and evalReference paths over the same AST contract. Add jqwik ${JQWIK_VERSION} generated-expression properties with a fixed seed ${PROPERTY_SEED}, bounded depth/tries, shrinking, discard accounting, and operator/depth Statistics.collect observations. Use the differential oracle to find and fix the disagreement. Keep the minimized constant/subtraction AST as a separate @Example regression. Do not make one evaluator call the other. Run ./.kory-runtime/mvn test; the wrapper uses the pinned offline Maven repository.
`;

const EXPR_SOURCE_STARTER = `package fixture;

public final class ExpressionEngine {
    private ExpressionEngine() {}
    public sealed interface Expr permits Const, Add, Sub, Mul {}
    public record Const(int value) implements Expr {}
    public record Add(Expr left, Expr right) implements Expr {}
    public record Sub(Expr left, Expr right) implements Expr {}
    public record Mul(Expr left, Expr right) implements Expr {}

    public static int evalFast(Expr expr) {
        if (expr instanceof Const c) return c.value();
        if (expr instanceof Add a) return evalFast(a.left()) + evalFast(a.right());
        if (expr instanceof Sub s) return evalFast(s.right()) - evalFast(s.left());
        if (expr instanceof Mul m) return evalFast(m.left()) * evalFast(m.right());
        throw new IllegalArgumentException("unknown expression");
    }

    public static int evalReference(Expr expr) {
        if (expr instanceof Const c) return c.value();
        if (expr instanceof Add a) return evalReference(a.left()) + evalReference(a.right());
        if (expr instanceof Sub s) return evalReference(s.left()) - evalReference(s.right());
        if (expr instanceof Mul m) return evalReference(m.left()) * evalReference(m.right());
        throw new IllegalArgumentException("unknown expression");
    }
}
`;

export const EXPR_SOURCE_CONTROL = EXPR_SOURCE_STARTER.replace(
  'return evalFast(s.right()) - evalFast(s.left());',
  'return evalFast(s.left()) - evalFast(s.right());',
);

const EXPR_POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>kory</groupId><artifactId>expression-fixture</artifactId><version>1</version>
  <properties><maven.compiler.release>21</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <dependencies>
    <dependency><groupId>net.jqwik</groupId><artifactId>jqwik</artifactId><version>${JQWIK_VERSION}</version><scope>test</scope></dependency>
  </dependencies>
  <build><plugins>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version></plugin>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.4</version></plugin>
  </plugins></build>
</project>
`;

const EXPR_PUBLIC_STARTER = `package fixture;
import net.jqwik.api.Example;
import static fixture.ExpressionEngine.*;

class ExpressionProperties {
    @Example void happyPath() {
        Expr expr = new Add(new Const(2), new Const(3));
        if (evalFast(expr) != 5) throw new AssertionError();
    }
}
`;

export const EXPR_PROPERTY_CONTROL = `package fixture;

import net.jqwik.api.*;
import net.jqwik.api.statistics.Statistics;
import static fixture.ExpressionEngine.*;

class ExpressionProperties {
    @Provide Arbitrary<Expr> expressions() {
        Arbitrary<Expr> leaves = Arbitraries.integers().between(-20, 20).map(Const::new);
        return Arbitraries.recursive(
            () -> leaves,
            child -> Combinators.combine(child, child, Arbitraries.of("add", "sub", "mul")).as((left, right, op) -> {
                if ("add".equals(op)) return new Add(left, right);
                if ("sub".equals(op)) return new Sub(left, right);
                return new Mul(left, right);
            }),
            3
        );
    }

    @Property(tries = 250, seed = "${PROPERTY_SEED}")
    void differentialAgreement(@ForAll("expressions") Expr expr) {
        Assume.that(depth(expr) <= 4);
        Statistics.collect("operator", operator(expr));
        Statistics.collect("depth", depth(expr));
        Statistics.collect("discard", "accepted");
        if (evalFast(expr) != evalReference(expr)) throw new AssertionError("differential mismatch: " + expr);
    }

    @Example void subtractionRegression() {
        Expr minimal = new Sub(new Const(1), new Const(0));
        if (evalFast(minimal) != 1 || evalReference(minimal) != 1) throw new AssertionError("subtraction regression");
    }

    static int depth(Expr expr) {
        if (expr instanceof Const) return 0;
        if (expr instanceof Add a) return 1 + Math.max(depth(a.left()), depth(a.right()));
        if (expr instanceof Sub s) return 1 + Math.max(depth(s.left()), depth(s.right()));
        if (expr instanceof Mul m) return 1 + Math.max(depth(m.left()), depth(m.right()));
        return 99;
    }
    static String operator(Expr expr) {
        if (expr instanceof Add) return "add";
        if (expr instanceof Sub) return "sub";
        if (expr instanceof Mul) return "mul";
        return "const";
    }
}
`;

const EXPR_HIDDEN = `package fixture;

import net.jqwik.api.*;
import net.jqwik.api.statistics.Statistics;
import static fixture.ExpressionEngine.*;

class __KoryHiddenProperties {
    @Provide Arbitrary<Expr> expressions() {
        Arbitrary<Expr> leaves = Arbitraries.integers().between(-12, 12).map(Const::new);
        return Arbitraries.recursive(
            () -> leaves,
            child -> Combinators.combine(child, child, Arbitraries.of(0, 1, 2)).as((left, right, op) -> op == 0 ? new Add(left, right) : op == 1 ? new Sub(left, right) : new Mul(left, right)),
            3
        );
    }

    @Property(tries = 180, seed = "${PROPERTY_SEED}")
    void koryDifferential(@ForAll("expressions") Expr expr) {
        Statistics.collect("kory-operator", operator(expr));
        Statistics.collect("kory-depth", depth(expr));
        if (evalFast(expr) != evalReference(expr)) throw new AssertionError("differential mismatch: " + expr);
    }

    @Example void koryDirectSemantics() {
        Expr minimal = new Sub(new Const(7), new Const(2));
        if (evalFast(minimal) != 5 || evalReference(minimal) != 5) throw new AssertionError("subtraction semantics");
    }

    static int depth(Expr expr) {
        if (expr instanceof Const) return 0;
        if (expr instanceof Add a) return 1 + Math.max(depth(a.left()), depth(a.right()));
        if (expr instanceof Sub s) return 1 + Math.max(depth(s.left()), depth(s.right()));
        if (expr instanceof Mul m) return 1 + Math.max(depth(m.left()), depth(m.right()));
        return 99;
    }
    static String operator(Expr expr) {
        if (expr instanceof Add) return "add";
        if (expr instanceof Sub) return "sub";
        if (expr instanceof Mul) return "mul";
        return "const";
    }
}
`;

function runPytest(root: string, paths: string[] = ['tests']): RunResult {
  return run(
    join(root, '.kory-runtime/pytest'),
    ['-q', '--hypothesis-show-statistics', `--hypothesis-seed=${PROPERTY_SEED}`, ...paths],
    root,
    15_000,
    { PYTHONPATH: root, HYPOTHESIS_STORAGE_DIRECTORY: join(root, '.hypothesis') },
  );
}

function runMaven(root: string): RunResult {
  return run(
    join(root, '.kory-runtime/mvn'),
    ['test', '-DtrimStackTrace=false', '-Djqwik.reporting.onlyfailures=false'],
    root,
    20_000,
  );
}

export function hasHypothesisSettingsDecorator(tests: string): boolean {
  if (/@settings\b/u.test(tests)) return true;
  for (const match of tests.matchAll(/\b([A-Za-z_]\w*)\s*=\s*settings\s*\(/gu)) {
    const alias = match[1];
    if (alias && new RegExp(`@${alias}\\b`, 'u').test(tests)) return true;
  }
  return false;
}

export function hasJqwikDiscardContract(tests: string): boolean {
  return (
    /Assume\.that|\.filter\s*\(/u.test(tests) ||
    (/maxDiscardRatio\s*=\s*\d+/u.test(tests) && /tries\s*=\s*\d+/u.test(tests))
  );
}

function scoreQuery(root: string): SkillEvalDeterministicScore {
  const fixed = {
    ...runtimeFiles('hypothesis'),
    'README.md': QUERY_README,
    'reference/reference_codec.py': QUERY_REFERENCE,
    'fixtures/wire-corpus.json': QUERY_CORPUS,
  };
  if (!intact(root, fixed))
    return fail(['Changed, missing or symlinked Hypothesis runtime/reference/corpus input.'], true);
  const production = existsSync(join(root, 'src/codec.py'))
    ? readFileSync(join(root, 'src/codec.py'), 'utf8')
    : '';
  const tests = existsSync(join(root, 'tests/test_properties.py'))
    ? readFixtureText(root, 'tests/test_properties.py')
    : '';
  const oracleIndependent = !/reference_codec|decode_reference/u.test(production);
  const generatedSuite =
    /from hypothesis|import hypothesis/u.test(tests) &&
    /@given/u.test(tests) &&
    hasHypothesisSettingsDecorator(tests) &&
    /structured|roundtrip/iu.test(tests) &&
    /raw|wire|reference/iu.test(tests) &&
    /malform|escape/iu.test(tests);
  const durableRegression =
    /def\s+test_[^(]*(?:plus|regression)[^(]*\(/iu.test(tests) &&
    /q=\+|literal.*plus|\[\("q",\s*"\+"\)\]/iu.test(tests);
  const publicRun = runPytest(root);

  const mutationRoot = mkdtempSync(join(tmpdir(), 'kory-hypothesis-mutation-'));
  cpSync(root, mutationRoot, { recursive: true });
  writeFileSync(join(mutationRoot, 'src/codec.py'), QUERY_STARTER);
  const mutationRun = runPytest(mutationRoot);
  rmSync(mutationRoot, { recursive: true, force: true });
  const mutationOutput = `${mutationRun.stdout}\n${mutationRun.stderr}`;
  const mutationKilled =
    mutationRun.code !== 0 &&
    !mutationRun.timedOut &&
    /Falsifying example|hypothesis|falsified/iu.test(mutationOutput) &&
    /\+/u.test(mutationOutput);

  const hiddenPath = `tests/__kory_hidden_${randomUUID().replaceAll('-', '')}.py`;
  writeFixtureFile(root, hiddenPath, QUERY_HIDDEN);
  let hiddenRun: RunResult;
  try {
    hiddenRun = runPytest(root, [hiddenPath]);
  } finally {
    rmSync(join(root, hiddenPath), { force: true });
  }
  const publicPassed = publicRun.code === 0 && !publicRun.timedOut;
  const hiddenPassed = hiddenRun.code === 0 && !hiddenRun.timedOut;
  const statsObserved = /Hypothesis Statistics|events:|Typical runtimes/iu.test(
    `${publicRun.stdout}\n${publicRun.stderr}\n${hiddenRun.stdout}\n${hiddenRun.stderr}`,
  );
  const passed =
    publicPassed &&
    hiddenPassed &&
    generatedSuite &&
    durableRegression &&
    oracleIndependent &&
    mutationKilled &&
    statsObserved;
  return {
    passed,
    quality: passed ? 1 : hiddenPassed && oracleIndependent ? 0.75 : 0,
    verification: hiddenPassed && mutationKilled ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Hypothesis ${HYPOTHESIS_VERSION} generated candidate campaign: ${publicPassed ? 'pass' : publicRun.timedOut ? 'timeout' : 'fail'}`,
      `generated domains/settings present: ${generatedSuite ? 'yes' : 'no'}`,
      `independent production/reference paths: ${oracleIndependent ? 'yes' : 'no'}`,
      `known-bad literal-plus mutation killed with shrink/replay evidence: ${mutationKilled ? 'yes' : 'no'}`,
      `minimized plus regression outside generated exploration: ${durableRegression ? 'yes' : 'no'}`,
      `evaluator Hypothesis oracle campaign: ${hiddenPassed ? 'pass' : hiddenRun.timedOut ? 'timeout' : 'fail'}`,
      `campaign statistics observed: ${statsObserved ? 'yes' : 'no'}`,
      `${publicRun.stdout}\n${publicRun.stderr}\n${mutationOutput}\n${hiddenRun.stdout}\n${hiddenRun.stderr}`.slice(
        -9000,
      ),
    ],
  };
}

function expressionImplementationsIndependent(source: string): boolean {
  const fast = source.indexOf('evalFast(');
  const reference = source.indexOf('evalReference(');
  if (fast < 0 || reference < 0 || reference <= fast) return false;
  const fastBody = source.slice(fast, reference);
  const referenceBody = source.slice(reference);
  return !fastBody.includes('evalReference(') && !referenceBody.includes('evalFast(');
}

function scoreExpression(root: string): SkillEvalDeterministicScore {
  const fixed = { ...runtimeFiles('jqwik'), 'README.md': EXPR_README, 'pom.xml': EXPR_POM };
  if (!intact(root, fixed))
    return fail(['Changed, missing or symlinked jqwik runtime/project contract input.'], true);
  const sourcePath = 'src/main/java/fixture/ExpressionEngine.java';
  const testPath = 'src/test/java/fixture/ExpressionProperties.java';
  const source = existsSync(join(root, sourcePath))
    ? readFileSync(join(root, sourcePath), 'utf8')
    : '';
  const tests = existsSync(join(root, testPath)) ? readFixtureText(root, testPath) : '';
  const independent = expressionImplementationsIndependent(source);
  const generatedSuite =
    /@Property/u.test(tests) &&
    /@Provide/u.test(tests) &&
    /Arbitrar/iu.test(tests) &&
    new RegExp(`seed\\s*=\\s*"${PROPERTY_SEED}"`, 'u').test(tests) &&
    /Statistics\.collect/u.test(tests) &&
    /operator/iu.test(tests) &&
    /depth/iu.test(tests) &&
    hasJqwikDiscardContract(tests);
  const durableRegression =
    /@Example/u.test(tests) && /Sub\s*\(/u.test(tests) && /regression|subtract/iu.test(tests);

  const publicRun = runMaven(root);
  const mutationRoot = mkdtempSync(join(tmpdir(), 'kory-jqwik-mutation-'));
  cpSync(root, mutationRoot, { recursive: true });
  writeFileSync(join(mutationRoot, sourcePath), EXPR_SOURCE_STARTER);
  const mutationRun = runMaven(mutationRoot);
  rmSync(mutationRoot, { recursive: true, force: true });
  const mutationOutput = `${mutationRun.stdout}\n${mutationRun.stderr}`;
  const mutationKilled =
    mutationRun.code !== 0 &&
    !mutationRun.timedOut &&
    /Shrunk Sample|falsified|seed|jqwik/iu.test(mutationOutput) &&
    /Sub|subtraction|differential/iu.test(mutationOutput);

  const hiddenPath = `src/test/java/fixture/__KoryHiddenProperties.java`;
  writeFixtureFile(root, hiddenPath, EXPR_HIDDEN);
  let hiddenRun: RunResult;
  try {
    hiddenRun = runMaven(root);
  } finally {
    rmSync(join(root, hiddenPath), { force: true });
  }
  const publicPassed = publicRun.code === 0 && !publicRun.timedOut;
  const hiddenPassed = hiddenRun.code === 0 && !hiddenRun.timedOut;
  const statisticsObserved = /tries\s*=|checks\s*=|seed\s*=|kory-depth|kory-operator/iu.test(
    `${publicRun.stdout}\n${publicRun.stderr}\n${hiddenRun.stdout}\n${hiddenRun.stderr}`,
  );
  const passed =
    publicPassed &&
    hiddenPassed &&
    independent &&
    generatedSuite &&
    durableRegression &&
    mutationKilled &&
    statisticsObserved;
  return {
    passed,
    quality: passed ? 1 : hiddenPassed && independent ? 0.75 : 0,
    verification: hiddenPassed && mutationKilled ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `jqwik ${JQWIK_VERSION} candidate campaign: ${publicPassed ? 'pass' : publicRun.timedOut ? 'timeout' : 'fail'}`,
      `generated depth/operator/discard/seed instrumentation: ${generatedSuite ? 'present' : 'missing'}`,
      `evalFast/evalReference independence: ${independent ? 'preserved' : 'collapsed'}`,
      `known-bad subtraction mutation killed with shrink/replay evidence: ${mutationKilled ? 'yes' : 'no'}`,
      `minimized subtraction regression outside generated exploration: ${durableRegression ? 'yes' : 'no'}`,
      `evaluator jqwik differential campaign: ${hiddenPassed ? 'pass' : hiddenRun.timedOut ? 'timeout' : 'fail'}`,
      `campaign statistics observed: ${statisticsObserved ? 'yes' : 'no'}`,
      `${publicRun.stdout}\n${publicRun.stderr}\n${mutationOutput}\n${hiddenRun.stdout}\n${hiddenRun.stderr}`.slice(
        -10000,
      ),
    ],
  };
}

export const V5_PROPERTY_FUZZ_HOST_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    {
      id: 'property-fuzz-differential-testing/hypothesis-query-differential@1',
      realRuntime: true,
      readinessBlockers: propertyFuzzHostReadiness(),
      matches: (scenario) => scenario.id === PROPERTY_QUERY_SCENARIO,
      materialize: (root) => {
        materializeRuntime(root, 'hypothesis');
        writeFixtureFile(root, 'README.md', QUERY_README);
        writeFixtureFile(root, 'src/__init__.py', '');
        writeFixtureFile(root, 'src/codec.py', QUERY_STARTER);
        writeFixtureFile(root, 'reference/__init__.py', '');
        writeFixtureFile(root, 'reference/reference_codec.py', QUERY_REFERENCE);
        writeFixtureFile(root, 'fixtures/wire-corpus.json', QUERY_CORPUS);
        writeFixtureFile(root, 'tests/test_properties.py', QUERY_PUBLIC_STARTER);
      },
    },
    {
      id: 'property-fuzz-differential-testing/jqwik-expression-differential@1',
      realRuntime: true,
      readinessBlockers: propertyFuzzHostReadiness(),
      matches: (scenario) => scenario.id === PROPERTY_EXPR_SCENARIO,
      materialize: (root) => {
        materializeRuntime(root, 'jqwik');
        writeFixtureFile(root, 'README.md', EXPR_README);
        writeFixtureFile(root, 'pom.xml', EXPR_POM);
        writeFixtureFile(root, 'src/main/java/fixture/ExpressionEngine.java', EXPR_SOURCE_STARTER);
        writeFixtureFile(
          root,
          'src/test/java/fixture/ExpressionProperties.java',
          EXPR_PUBLIC_STARTER,
        );
      },
    },
  ];

export const V5_PROPERTY_FUZZ_HOST_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'property-fuzz-differential-testing/hypothesis-query-differential-scorer@2',
    scenarioIds: [PROPERTY_QUERY_SCENARIO],
    score: ({ workingDirectory }) => scoreQuery(workingDirectory),
  },
  {
    id: 'property-fuzz-differential-testing/jqwik-expression-differential-scorer@2',
    scenarioIds: [PROPERTY_EXPR_SCENARIO],
    score: ({ workingDirectory }) => scoreExpression(workingDirectory),
  },
];
