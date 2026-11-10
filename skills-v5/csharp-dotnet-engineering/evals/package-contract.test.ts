import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDirectory = join(import.meta.dir, '..');
const sidecar = JSON.parse(readFileSync(join(packageDirectory, 'kory.json'), 'utf8')) as {
  activation: string[];
  excludes: string[];
  routing: {
    positive: string[];
    negative: string[];
    ambiguous: Array<{ prompt: string }>;
    adversarial: Array<{ prompt: string }>;
  };
  sources: Array<{ url: string }>;
};

const heldOutRouting = readFileSync(join(import.meta.dir, 'routing.jsonl'), 'utf8')
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line) as { id: string; category: string; prompt: string });

const tasks = ['scenario-1.json', 'scenario-2.json'].map(
  (fileName) =>
    JSON.parse(readFileSync(join(import.meta.dir, 'tasks', fileName), 'utf8')) as {
      id: string;
      falsifiableChecks: Array<{ id: string }>;
      requiredEvidence: string[];
      requiredArtifacts: string[];
    },
);

describe('csharp-dotnet-engineering package contract', () => {
  test('keeps held-out routing concrete, balanced, unique, and private', () => {
    expect(
      Object.fromEntries(
        ['positive', 'negative', 'ambiguous', 'adversarial'].map((category) => [
          category,
          heldOutRouting.filter((item) => item.category === category).length,
        ]),
      ),
    ).toEqual({ positive: 5, negative: 5, ambiguous: 3, adversarial: 3 });

    expect(new Set(heldOutRouting.map((item) => item.id)).size).toBe(heldOutRouting.length);

    const publicPrompts = new Set([
      ...sidecar.routing.positive,
      ...sidecar.routing.negative,
      ...sidecar.routing.ambiguous.map((item) => item.prompt),
      ...sidecar.routing.adversarial.map((item) => item.prompt),
    ]);
    expect(heldOutRouting.filter((item) => publicPrompts.has(item.prompt))).toEqual([]);
  });

  test('keeps each full task falsifiable and scoped to its actual contract', () => {
    expect(tasks.map((task) => task.id)).toEqual([
      'csharp-dotnet-engineering-full-task-1-individual',
      'csharp-dotnet-engineering-full-task-2-individual',
    ]);
    for (const task of tasks) {
      expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
        task.falsifiableChecks.length,
      );
      expect(new Set(task.requiredEvidence).size).toBe(task.requiredEvidence.length);
      expect(task.requiredArtifacts).toHaveLength(3);
      expect(task.falsifiableChecks.map((check) => check.id)).toEqual([
        'scope-and-hierarchy',
        'operating-contract',
        'execution-invariant',
        'verification-discipline',
        'anti-pattern-resistance',
        'evidence-and-uncertainty',
      ]);
    }
  });

  test('keeps activation and provenance aligned with the authored guidance', () => {
    expect(sidecar.activation).toEqual(
      expect.arrayContaining([
        'IAsyncDisposable',
        'CancellationToken',
        'System.Text.Json',
        'PublishTrimmed',
        'PublishAot',
        'positional record',
      ]),
    );
    expect(sidecar.excludes).toEqual(
      expect.arrayContaining([
        'C# or .NET appears only in quoted history or fixture data',
        'documentation-only extraction of dotnet commands',
      ]),
    );
    expect(sidecar.sources.map((source) => source.url)).toEqual(
      expect.arrayContaining([
        'https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync',
        'https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/handle-overflow',
        'https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record',
        'https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/',
      ]),
    );
  });
});
