import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  JVM_RUBY_SKILL_EVAL_MATERIALIZERS,
  JVM_RUBY_SKILL_EVAL_SCORERS,
} from '../skill-eval-jvm-ruby-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Java and Ruby runtime skill fixtures', () => {
  test('Ruby controls execute on the selected runtime and require passing Ruby regressions', async () => {
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
  });
  test('all four compiled/runtime fixtures start red', async () => {
    const packages = loadV5SkillPackages().packages.filter(
      (item) =>
        item.sidecar.name === 'java-jvm-engineering' || item.sidecar.name === 'ruby-engineering',
    );
    expect(packages).toHaveLength(2);
    for (const skillPackage of packages) {
      for (const scenario of buildSkillEvalSuiteV3(skillPackage).scenarios.filter(
        (item) => item.category === 'full-task',
      )) {
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
      }
    }
  });
});
