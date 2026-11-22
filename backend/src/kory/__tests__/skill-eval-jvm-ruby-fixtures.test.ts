import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  JVM_RUBY_SKILL_EVAL_MATERIALIZERS,
  JVM_RUBY_SKILL_EVAL_SCORERS,
  jvmRubyRuntimeReadiness,
} from '../../eval/skills/skill-eval-jvm-ruby-fixtures';

const roots: string[] = [];
const runtimeReadiness = {
  java: jvmRubyRuntimeReadiness('java'),
  ruby: jvmRubyRuntimeReadiness('ruby'),
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Java and Ruby runtime skill fixtures', () => {
  test.skipIf(runtimeReadiness.ruby.reasons.length > 0)(
    'Ruby controls execute on the selected runtime and require passing Ruby regressions',
    async () => {
      const controls = [
        {
          id: 'ruby-engineering-full-task-1-individual',
          path: 'lib/request_middleware.rb',
          source: `module Current
  def self.user=(value); Thread.current[:kory_current_user] = value; end
  def self.user; Thread.current[:kory_current_user]; end
  def self.clear; Thread.current[:kory_current_user] = nil; end
end
class RequestMiddleware
  def initialize(app); @app = app; end
  def call(user)
    Current.user = user
    response = @app.call
    [response[0], response[1].to_a]
  ensure
    Current.clear
  end
end
`,
          testPath: 'tests/context_test.rb',
          regression: `require_relative '../lib/request_middleware'
begin
  RequestMiddleware.new(-> { raise 'exception' }).call('user')
rescue RuntimeError
end
raise 'cleanup after thread reuse' unless Current.user.nil?
`,
        },
        {
          id: 'ruby-engineering-full-task-2-individual',
          path: 'lib/client.rb',
          source: `class Client
  def configure(options = {}, **keywords)
    values = {timeout: 5, retries: 2}.merge(options).merge(keywords)
    raise ArgumentError unless (values.keys - [:timeout, :retries]).empty?
    values
  end
end
class ForwardingClient < Client
  def forward(*args, **keywords, &block)
    configure(*args, **keywords, &block)
  end
end
`,
          testPath: 'tests/keywords_test.rb',
          regression: `require_relative '../lib/client'
raise 'positional hash forwarding' unless ForwardingClient.new.forward({retries: 4}) == {timeout: 5, retries: 4}
raise 'keyword forwarding' unless ForwardingClient.new.forward(timeout: 3) == {timeout: 3, retries: 2}
`,
        },
      ];
      for (const control of controls) {
        const root = mkdtempSync(join(tmpdir(), 'kory-ruby-control-'));
        roots.push(root);
        const scenario = { id: control.id } as never;
        await JVM_RUBY_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!.materialize(
          root,
          scenario,
        );
        writeFileSync(join(root, control.path), control.source);
        const scorer = JVM_RUBY_SKILL_EVAL_SCORERS.find((item) =>
          item.scenarioIds.includes(control.id),
        )!;
        const score = () =>
          scorer.score({
            scenario,
            experiment: {} as never,
            workingDirectory: root,
            observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
          });
        expect((await score()).passed).toBe(false);
        writeFileSync(join(root, control.testPath), control.regression);
        const green = await score();
        expect(green.passed, green.evidence.join('\n')).toBe(true);
        writeFileSync(
          join(root, control.testPath),
          `${control.regression}\nraise 'real regression failure'\n`,
        );
        expect((await score()).passed).toBe(false);
      }
    },
  );
  test.skipIf(runtimeReadiness.ruby.reasons.length > 0)(
    'Ruby regression coverage executes the standard test framework and still fails a red suite',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-ruby-minitest-'));
      roots.push(root);
      const scenario = { id: 'ruby-engineering-full-task-1-individual' } as never;
      await JVM_RUBY_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!.materialize(
        root,
        scenario,
      );
      writeFileSync(
        join(root, 'lib/request_middleware.rb'),
        `module Current
  def self.user=(value); Thread.current[:kory_current_user] = value; end
  def self.user; Thread.current[:kory_current_user]; end
  def self.clear; Thread.current[:kory_current_user] = nil; end
end
class DeferredBody
  def initialize(body, user); @body = body; @user = user; end
  def to_a
    Current.user = @user
    @body.to_a
  ensure
    Current.clear
  end
end
class RequestMiddleware
  def initialize(app); @app = app; end
  def call(user)
    Current.user = user
    status, body = @app.call
    [status, DeferredBody.new(body, user)]
  ensure
    Current.clear
  end
end
`,
      );
      const scorer = JVM_RUBY_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes('ruby-engineering-full-task-1-individual'),
      )!;
      const score = () =>
        scorer.score({
          scenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });
      // Ordinary Ruby test code, which is a default gem rather than a bundled library.
      writeFileSync(
        join(root, 'tests/context_test.rb'),
        `require 'minitest/autorun'
require_relative '../lib/request_middleware'
class ContextTest < Minitest::Test
  def test_thread_reuse_clears_identity
    middleware = RequestMiddleware.new(-> { [Current.user, Enumerator.new { |y| y << Current.user }] })
    response = middleware.call('alice')
    assert_equal 'alice', response[0]
    assert_nil Current.user
    assert_equal ['alice'], response[1].to_a
    assert_nil Current.user
  end
end
`,
      );
      const green = await score();
      expect(green.evidence).toContain('regression coverage: present');
      expect(green.passed, green.evidence.join('\n')).toBe(true);
      writeFileSync(
        join(root, 'tests/context_test.rb'),
        `require 'minitest/autorun'
require_relative '../lib/request_middleware'
class ContextTest < Minitest::Test
  def test_stream_identity_is_really_broken
    assert_nil Current.user
    assert false, 'stream identity regression'
  end
end
`,
      );
      const red = await score();
      expect(red.evidence).toContain('regression coverage: missing');
      expect(red.passed).toBe(false);
    },
  );
  test('materializer readiness comes from usable runtimes, not launcher file existence', async () => {
    const packages = loadV5SkillPackages().packages.filter(
      (item) =>
        item.sidecar.name === 'java-jvm-engineering' || item.sidecar.name === 'ruby-engineering',
    );
    expect(packages).toHaveLength(2);
    for (const skillPackage of packages) {
      const language = skillPackage.sidecar.name === 'java-jvm-engineering' ? 'java' : 'ruby';
      for (const scenario of buildSkillEvalSuiteV3(skillPackage).scenarios.filter(
        (item) => item.category === 'full-task',
      )) {
        const materializer = JVM_RUBY_SKILL_EVAL_MATERIALIZERS.find((item) =>
          item.matches(scenario),
        )!;
        expect(materializer.readinessBlockers, scenario.id).toEqual(
          runtimeReadiness[language].reasons,
        );
        if (!runtimeReadiness[language].reasons.length) continue;
        const root = mkdtempSync(join(tmpdir(), 'kory-unavailable-jvm-ruby-'));
        roots.push(root);
        await materializer.materialize(root, scenario);
        const score = await JVM_RUBY_SKILL_EVAL_SCORERS.find((item) =>
          item.scenarioIds.includes(scenario.id),
        )!.score({
          scenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });
        expect(score.passed, scenario.id).toBe(false);
        expect(score.quality, scenario.id).toBe(0);
        expect(score.verification, scenario.id).toBe(0);
        expect(score.integrityFailure, scenario.id).toBe(false);
        expect(score.evidence, scenario.id).toEqual(runtimeReadiness[language].reasons);
      }
    }
  });

  for (const [language, name] of [
    ['java', 'java-jvm-engineering'],
    ['ruby', 'ruby-engineering'],
  ] as const) {
    test.skipIf(runtimeReadiness[language].reasons.length > 0)(
      `${language} fixtures start red on a working runtime`,
      async () => {
        const skillPackage = loadV5SkillPackages().packages.find(
          (item) => item.sidecar.name === name,
        )!;
        const scenarios = buildSkillEvalSuiteV3(skillPackage).scenarios.filter(
          (item) => item.category === 'full-task',
        );
        expect(scenarios).toHaveLength(2);
        for (const scenario of scenarios) {
          const root = mkdtempSync(join(tmpdir(), 'kory-jvm-ruby-test-'));
          roots.push(root);
          const materializer = JVM_RUBY_SKILL_EVAL_MATERIALIZERS.find((item) =>
            item.matches(scenario),
          )!;
          const scorer = JVM_RUBY_SKILL_EVAL_SCORERS.find((item) =>
            item.scenarioIds.includes(scenario.id),
          )!;
          await materializer.materialize(root, scenario);
          const score = await scorer.score({
            scenario,
            experiment: {} as never,
            workingDirectory: root,
            observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
          });
          expect(score.passed, scenario.id).toBe(false);
          expect(score.integrityFailure, scenario.id).toBe(false);
          expect(score.evidence.join('\n'), scenario.id).not.toContain('runtime unavailable');
        }
      },
      30_000,
    );
  }
});
