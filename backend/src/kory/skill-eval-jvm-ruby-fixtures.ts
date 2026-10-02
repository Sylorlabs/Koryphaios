import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { hasRegressionText, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

const JAVA_LIFECYCLE = 'java-jvm-engineering-full-task-1-individual';
const JAVA_COMPAT = 'java-jvm-engineering-full-task-2-individual';
const RUBY_CONTEXT = 'ruby-engineering-full-task-1-individual';
const RUBY_KEYWORDS = 'ruby-engineering-full-task-2-individual';

const JAVA_LIFECYCLE_SOURCE = `package fixture;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class TenantSchedulers implements AutoCloseable {
  private final Map<String, ScheduledExecutorService> schedulers = new ConcurrentHashMap<>();
  private final AtomicInteger threadId = new AtomicInteger();

  public void addTenant(String tenantId, Runnable task) {
    schedulers.computeIfAbsent(tenantId, id -> {
      var executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
        var thread = new Thread(runnable, "kory-tenant-" + id + "-" + threadId.incrementAndGet());
        thread.setDaemon(false);
        return thread;
      });
      executor.scheduleAtFixedRate(task, 0, 10, TimeUnit.MILLISECONDS);
      return executor;
    });
  }

  public void removeTenant(String tenantId) {
    // BUG: ownership is removed from the map but the executor and its thread remain live.
    schedulers.remove(tenantId);
  }

  public int activeTenants() { return schedulers.size(); }

  @Override public void close() {
    schedulers.clear();
  }
}
`;

const JAVA_COMPAT_SOURCE = `package fixture;

public record Message(String id, String region, Priority priority) {
  public enum Priority { NORMAL, URGENT }
}
`;

const JAVA_CODEC_SOURCE = `package fixture;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MessageCodec {
  private static final Pattern ID = Pattern.compile("\\\"id\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
  private static final Pattern REGION = Pattern.compile("\\\"region\\\"\\s*:\\s*(null|\\\"([^\\\"]*)\\\")");
  private static final Pattern PRIORITY = Pattern.compile("\\\"priority\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");

  public static Message decode(String json) {
    var id = match(ID, json, 1);
    var region = match(REGION, json, 2);
    var priority = match(PRIORITY, json, 1);
    // BUG: old payloads and future enum values fail instead of crossing the version boundary safely.
    if (id == null || region == null || priority == null) throw new IllegalArgumentException("missing field");
    return new Message(id, region, Message.Priority.valueOf(priority));
  }

  public static String encode(Message value) {
    return "{\\\"id\\\":\\\"" + value.id() + "\\\",\\\"region\\\":\\\"" + value.region() + "\\\",\\\"priority\\\":\\\"" + value.priority() + "\\\"}";
  }

  public static LoadResult loadQueue(List<String> lines) {
    var messages = new ArrayList<Message>();
    for (var line : lines) messages.add(decode(line));
    return new LoadResult(messages, 0);
  }

  private static String match(Pattern pattern, String value, int group) {
    Matcher matcher = pattern.matcher(value);
    return matcher.find() ? matcher.group(group) : null;
  }

  public record LoadResult(List<Message> messages, int malformed) {}
}
`;

const RUBY_CONTEXT_SOURCE = `module Current
  def self.user=(value)
    Thread.current[:kory_current_user] = value
  end
  def self.user
    Thread.current[:kory_current_user]
  end
  def self.clear
    Thread.current[:kory_current_user] = nil
  end
end

class RequestMiddleware
  def initialize(app)
    @app = app
  end

  def call(user)
    Current.user = user
    response = @app.call
    Current.clear
    response
  end
end
`;

const RUBY_KEYWORDS_SOURCE = `class Client
  def configure(timeout: 5, retries: 2, **extra)
    raise ArgumentError, "unknown options" unless extra.empty?
    { timeout: timeout, retries: retries }
  end
end

class ForwardingClient < Client
  def forward(*args, &block)
    # BUG: Ruby 3 no longer implicitly converts the final positional hash to keywords.
    configure(*args, &block)
  end
end
`;

function runJava(root: string, hiddenSource: string): { passed: boolean; evidence: string } {
  const build = join(root, '.kory-hidden-java');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  const hidden = join(root, '__KoryHidden.java');
  writeFixtureFile(root, '__KoryHidden.java', hiddenSource);
  try {
    const sources = [
      join(root, 'src/fixture/TenantSchedulers.java'),
      join(root, 'src/fixture/Message.java'),
      join(root, 'src/fixture/MessageCodec.java'),
    ].filter(existsSync);
    const compile = spawnSync(
      '/usr/bin/javac',
      ['-encoding', 'UTF-8', '-Xlint:all', '-Werror', '-d', build, ...sources, hidden],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_000_000,
        env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C' },
      },
    );
    if (compile.status !== 0)
      return {
        passed: false,
        evidence: `javac failed\n${compile.stdout ?? ''}\n${compile.stderr ?? ''}`.slice(-5000),
      };
    const execute = spawnSync('/usr/bin/java', ['-cp', build, '__KoryHidden'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1_000_000,
      env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C' },
    });
    return {
      passed: execute.status === 0 && /KORY_JAVA_OK/u.test(execute.stdout ?? ''),
      evidence: `${execute.stdout ?? ''}\n${execute.stderr ?? ''}`.slice(-5000),
    };
  } finally {
    rmSync(hidden, { force: true });
    rmSync(build, { recursive: true, force: true });
  }
}

function runRuby(root: string, hiddenSource: string): { passed: boolean; evidence: string } {
  const hidden = join(root, '__kory_hidden.rb');
  writeFixtureFile(root, '__kory_hidden.rb', hiddenSource);
  try {
    const result = spawnSync('/usr/bin/ruby', ['--disable-gems', hidden], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 512_000,
      env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C' },
    });
    return {
      passed: result.status === 0 && /KORY_RUBY_OK/u.test(result.stdout ?? ''),
      evidence: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-5000),
    };
  } finally {
    rmSync(hidden, { force: true });
  }
}

function scoreJavaLifecycle(root: string): SkillEvalDeterministicScore {
  const runtime = runJava(
    root,
    `import fixture.TenantSchedulers;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

public final class __KoryHidden {
  static long ownedThreads() {
    return Thread.getAllStackTraces().keySet().stream().filter(t -> t.isAlive() && t.getName().startsWith("kory-tenant-")).count();
  }
  static void awaitNoThreads() throws Exception {
    var end = Instant.now().plus(Duration.ofSeconds(3));
    while (Instant.now().isBefore(end) && ownedThreads() != 0) Thread.sleep(10);
    if (ownedThreads() != 0) throw new AssertionError("tenant scheduler threads leaked: " + ownedThreads());
  }
  public static void main(String[] args) throws Exception {
    var service = new TenantSchedulers();
    for (int i = 0; i < 12; i++) service.addTenant("t" + i, () -> { if (System.nanoTime() == 0) throw new RuntimeException("never"); });
    Thread.sleep(40);
    var removers = new ArrayList<Thread>();
    for (int i = 0; i < 12; i++) { final int n = i; var t = new Thread(() -> { service.removeTenant("t" + n); service.removeTenant("t" + n); }); removers.add(t); t.start(); }
    for (var t : removers) t.join();
    if (service.activeTenants() != 0) throw new AssertionError("owners remain");
    awaitNoThreads();
    service.addTenant("final", () -> { throw new RuntimeException("task failure"); });
    Thread.sleep(30);
    service.close(); service.close();
    awaitNoThreads();
    System.out.println("KORY_JAVA_OK");
  }
}
`,
  );
  const regression = hasRegressionText(root, [
    /remove|shutdown|close|tenant/iu,
    /exception|concurrent|thread|leak/iu,
  ]);
  const passed = runtime.passed && regression;
  return {
    passed,
    quality: passed ? 1 : runtime.passed ? 0.8 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `compiled JVM lifecycle checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${regression ? 'present' : 'missing'}`,
      runtime.evidence,
    ],
  };
}

function scoreJavaCompat(root: string): SkillEvalDeterministicScore {
  const runtime = runJava(
    root,
    `import fixture.Message;
import fixture.MessageCodec;
import java.util.List;

public final class __KoryHidden {
  public static void main(String[] args) {
    var old = MessageCodec.decode("{\\\"id\\\":\\\"old\\\"}");
    if (!old.id().equals("old") || old.region() != null || old.priority() != Message.Priority.NORMAL) throw new AssertionError("old default");
    var explicitNull = MessageCodec.decode("{\\\"id\\\":\\\"n\\\",\\\"region\\\":null,\\\"priority\\\":\\\"URGENT\\\"}");
    if (explicitNull.region() != null || explicitNull.priority() != Message.Priority.URGENT) throw new AssertionError("null/priority");
    var future = MessageCodec.decode("{\\\"id\\\":\\\"f\\\",\\\"region\\\":\\\"us\\\",\\\"priority\\\":\\\"FUTURE\\\"}");
    if (future.priority() != Message.Priority.UNKNOWN) throw new AssertionError("unknown enum");
    var loaded = MessageCodec.loadQueue(List.of("{\\\"id\\\":\\\"a\\\"}", "not-json", "{\\\"id\\\":\\\"b\\\",\\\"priority\\\":\\\"URGENT\\\"}"));
    if (loaded.messages().size() != 2 || loaded.malformed() != 1) throw new AssertionError("restart recovery");
    var encoded = MessageCodec.encode(new Message("x", null, Message.Priority.NORMAL));
    if (!encoded.contains("\\\"id\\\":\\\"x\\\"")) throw new AssertionError("encoded id");
    System.out.println("KORY_JAVA_OK");
  }
}
`,
  );
  const source = existsSync(join(root, 'src/fixture/Message.java'))
    ? readFileSync(join(root, 'src/fixture/Message.java'), 'utf8')
    : '';
  const unknown = /UNKNOWN/u.test(source);
  const regression = hasRegressionText(root, [
    /old|missing|unknown|priority|region/iu,
    /restart|malform|compat/iu,
  ]);
  const passed = runtime.passed && unknown && regression;
  return {
    passed,
    quality: passed ? 1 : runtime.passed && unknown ? 0.85 : runtime.passed ? 0.7 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `compiled mixed-version checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `unknown enum boundary: ${unknown ? 'explicit' : 'missing'}`,
      `regression coverage: ${regression ? 'present' : 'missing'}`,
      runtime.evidence,
    ],
  };
}

function rubyRegression(root: string, path: string, requirements: RegExp[]): boolean {
  try {
    const source = readFixtureText(root, path).replace(/^\s*#.*$/gmu, '');
    if (
      !/\b(?:assert\w*|raise)\b/u.test(source) ||
      !requirements.every((pattern) => pattern.test(source))
    )
      return false;
    return runRuby(root, `require_relative ${JSON.stringify(path)}\nputs 'KORY_RUBY_OK'\n`).passed;
  } catch {
    return false;
  }
}

function scoreRubyContext(root: string): SkillEvalDeterministicScore {
  const runtime = runRuby(
    root,
    `require_relative 'lib/request_middleware'
def assert(value, message)
  raise(message) unless value
end

app = -> { [Current.user, Enumerator.new { |y| y << Current.user }] }
middleware = RequestMiddleware.new(app)
first = middleware.call('alice')
assert(first[0] == 'alice', 'first identity')
assert(Current.user.nil?, 'success cleanup')
begin
  RequestMiddleware.new(-> { raise 'boom' }).call('bob')
rescue RuntimeError
end
assert(Current.user.nil?, 'exception cleanup')
second = middleware.call('carol')
assert(second[0] == 'carol', 'thread reuse identity')
assert(Current.user.nil?, 'thread reuse cleanup')
assert(first[1].to_a == ['alice'], 'stream must not depend on leaked thread-local state')
puts 'KORY_RUBY_OK'
`,
  );
  const regression = rubyRegression(root, 'tests/context_test.rb', [
    /ensure|exception|cleanup|clear/iu,
    /thread|reuse|stream|user/iu,
  ]);
  const passed = runtime.passed && regression;
  return {
    passed,
    quality: passed ? 1 : runtime.passed ? 0.8 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Ruby request lifetime checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${regression ? 'present' : 'missing'}`,
      runtime.evidence,
    ],
  };
}

function scoreRubyKeywords(root: string): SkillEvalDeterministicScore {
  const runtime = runRuby(
    root,
    `require_relative 'lib/client'
def assert(value, message)
  raise(message) unless value
end

c = Client.new
assert(c.configure == { timeout: 5, retries: 2 }, 'defaults')
assert(c.configure({ timeout: 9 }) == { timeout: 9, retries: 2 }, 'positional hash')
assert(c.configure(timeout: 7, retries: 1) == { timeout: 7, retries: 1 }, 'keywords')
f = ForwardingClient.new
assert(f.forward({ retries: 4 }) == { timeout: 5, retries: 4 }, 'forward positional')
assert(f.forward(timeout: 3) == { timeout: 3, retries: 2 }, 'forward keywords')
begin
  c.configure({ typo: 1 }); raise 'unknown option accepted'
rescue ArgumentError
end
puts 'KORY_RUBY_OK'
`,
  );
  const regression = rubyRegression(root, 'tests/keywords_test.rb', [
    /positional|hash|keyword/iu,
    /forward|subclass|compat|empty/iu,
  ]);
  const passed = runtime.passed && regression;
  return {
    passed,
    quality: passed ? 1 : runtime.passed ? 0.8 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Ruby argument-shape checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${regression ? 'present' : 'missing'}`,
      runtime.evidence,
    ],
  };
}

export const JVM_RUBY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'java-jvm-engineering/tenant-executor-lifecycle@1',
    matches: (scenario) => scenario.id === JAVA_LIFECYCLE,
    materialize: (root) => {
      writeFixtureFile(root, 'src/fixture/TenantSchedulers.java', JAVA_LIFECYCLE_SOURCE);
      writeFixtureFile(
        root,
        'tests/lifecycle-regression.md',
        'Add remove/shutdown/close, task exception, concurrent removal, and thread leak regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Java tenant scheduler lifecycle\n\nFix the scheduler ownership leak. Keep addTenant/removeTenant/activeTenants/close compatible. Removal and close are idempotent and must terminate owned scheduler threads without finalizers.\n',
      );
    },
  },
  {
    id: 'java-jvm-engineering/message-version-compatibility@1',
    matches: (scenario) => scenario.id === JAVA_COMPAT,
    materialize: (root) => {
      writeFixtureFile(root, 'src/fixture/Message.java', JAVA_COMPAT_SOURCE);
      writeFixtureFile(root, 'src/fixture/MessageCodec.java', JAVA_CODEC_SOURCE);
      writeFixtureFile(
        root,
        'tests/compat-regression.md',
        'Add old/missing/null/unknown priority and region plus malformed restart compatibility regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# JVM message compatibility\n\nOld records omit region and priority. Missing priority defaults to NORMAL; unknown future priorities map to UNKNOWN. Missing or explicit-null region remains null. Queue restart skips malformed records while reporting their count. Preserve id and tolerant mixed-version reads.\n',
      );
    },
  },
  {
    id: 'ruby-engineering/request-context-lifetime@2',
    matches: (scenario) => scenario.id === RUBY_CONTEXT,
    materialize: (root) => {
      writeFixtureFile(root, 'lib/request_middleware.rb', RUBY_CONTEXT_SOURCE);
      writeFixtureFile(
        root,
        'tests/context_test.rb',
        '# Add ensure/exception cleanup, alternating user, thread reuse, and stream regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Ruby request context lifetime\n\nCurrent.user is request-scoped. The middleware must clear it on every terminal path using a guaranteed lifecycle boundary. Streaming responses must not depend on leaked thread-local identity after call returns.\n',
      );
    },
  },
  {
    id: 'ruby-engineering/keyword-compatibility@1',
    matches: (scenario) => scenario.id === RUBY_KEYWORDS,
    materialize: (root) => {
      writeFixtureFile(root, 'lib/client.rb', RUBY_KEYWORDS_SOURCE);
      writeFixtureFile(
        root,
        'tests/keywords_test.rb',
        '# Add positional hash, keyword, empty, forwarding, subclass, and unknown-option compatibility regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Ruby keyword compatibility\n\nSupport both the legacy positional options hash and explicit keywords on the pinned Ruby runtime. Defaults are timeout=5 and retries=2. Unknown options raise ArgumentError. Forwarding preserves both call shapes explicitly.\n',
      );
    },
  },
];

export const JVM_RUBY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'java-jvm-engineering/tenant-executor-lifecycle-scorer@1',
    scenarioIds: [JAVA_LIFECYCLE],
    score: ({ workingDirectory }) => scoreJavaLifecycle(workingDirectory),
  },
  {
    id: 'java-jvm-engineering/message-version-compatibility-scorer@1',
    scenarioIds: [JAVA_COMPAT],
    score: ({ workingDirectory }) => scoreJavaCompat(workingDirectory),
  },
  {
    id: 'ruby-engineering/request-context-lifetime-scorer@2',
    scenarioIds: [RUBY_CONTEXT],
    score: ({ workingDirectory }) => scoreRubyContext(workingDirectory),
  },
  {
    id: 'ruby-engineering/keyword-compatibility-scorer@2',
    scenarioIds: [RUBY_KEYWORDS],
    score: ({ workingDirectory }) => scoreRubyKeywords(workingDirectory),
  },
];
