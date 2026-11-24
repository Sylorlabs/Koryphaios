#!/usr/bin/env bun
/**
 * Generate the Cline per-model reasoning catalog.
 *
 * Writes backend/src/providers/cline-catalog.generated.ts from the `cline`
 * provider collection that Cline publishes inside `@cline/llms` — the SDK
 * package Cline's own CLI and VS Code extension use to populate their model
 * pickers. It is the only real source of per-model reasoning-effort ladders
 * for the Cline API: the live catalog (`GET /api/v1/ai/cline/models`) states
 * that a model *accepts* `reasoning_effort` / `include_reasoning` but never
 * enumerates the accepted values.
 *
 * The generated file is committed, so this script is a maintenance tool, not a
 * build step. It installs `@cline/llms` into a throwaway temp directory and
 * loads the catalog from there, which keeps 200+ transitive packages out of
 * this repository's dependency graph. It never contacts the Cline API.
 *
 * Usage:
 *   bun run scripts/generate-cline-catalog.ts [packageVersion]
 *
 * Pin the version so a refresh is a deliberate, reviewable change:
 *   bun run scripts/generate-cline-catalog.ts 0.0.86
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../backend/src/runtime/paths';

const DEFAULT_CLINE_LLMS_VERSION = '0.0.86';
const OUTPUT = join(PROJECT_ROOT, 'backend/src/providers/cline-catalog.generated.ts');

/** Canonical order for reasoning-effort tiers this codebase already knows. */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Effort tiers Cline may report that sit outside the canonical ladder. */
function orderLevels(levels: string[]): string[] {
  const known = levels.filter((level) => (EFFORT_LADDER as readonly string[]).includes(level));
  const novel = levels.filter((level) => !(EFFORT_LADDER as readonly string[]).includes(level));
  return [
    ...known.sort((a, b) => EFFORT_LADDER.indexOf(a as never) - EFFORT_LADDER.indexOf(b as never)),
    ...novel.sort(),
  ];
}

interface ReasoningOption {
  type?: unknown;
  values?: unknown;
}

interface CatalogModel {
  reasoningOptions?: unknown;
}

function asOptions(value: unknown): ReasoningOption[] {
  return Array.isArray(value) ? (value as ReasoningOption[]) : [];
}

function effortValues(option: ReasoningOption): string[] {
  if (!Array.isArray(option.values)) return [];
  return option.values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

async function main(): Promise<void> {
  const version = process.argv[2] ?? DEFAULT_CLINE_LLMS_VERSION;
  const packageName = '@cline/llms';
  const specifier = `${packageName}@${version}`;

  // Install into a throwaway directory: the catalog is a build-time input we
  // commit, not a runtime dependency of Koryphaios.
  const staging = join(tmpdir(), `kory-cline-catalog-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    process.stdout.write(`Installing ${specifier} into a temp workspace …\n`);
    const install = Bun.spawnSync(['bun', 'add', specifier, '--no-save', '--cwd', staging], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!install.success) {
      throw new Error(`Failed to install ${specifier} (exit ${install.exitCode})`);
    }

    const entry = Bun.resolveSync(packageName, staging);
    const llms = (await import(pathToFileURL(entry).href)) as {
      getProviderCollectionSync?: (
        providerId: string,
      ) => { models?: Record<string, CatalogModel> } | null;
    };
    const collection = llms.getProviderCollectionSync?.('cline');
    const models = collection?.models;
    if (!models || Object.keys(models).length === 0) {
      throw new Error(`${specifier} exposes no "cline" model collection`);
    }
    const { effort, toggle } = partitionReasoningModels(models);

    const rows = effort.map(([id, levels]) => {
      const quoted = levels.map((level) => `'${level}'`).join(', ');
      return `  '${id}': [${quoted}],`;
    });

    const source = `// GENERATED FILE — do not edit by hand.
// Regenerate with: bun run scripts/generate-cline-catalog.ts ${version}
// Source: ${specifier} → getProviderCollectionSync('cline').models
//
// Per-model reasoning-control metadata for the Cline API, transcribed from
// Cline's own published model catalog — the same data Cline's CLI and IDE
// extension use to populate their model pickers. Cline's inference API
// (\`GET /api/v1/ai/cline/models\`) reports only whether a model *accepts*
// \`reasoning_effort\` / \`include_reasoning\`, never which values are legal, so
// this catalog is the only real per-model evidence that exists.
//
// Nothing here is invented. A model that appears in neither table reports no
// reasoning ladder, and Koryphaios shows no reasoning picker for it, per the
// data-driven rule in shared/src/reasoning/ReasoningConfig.ts.

/** Model id → the exact \`reasoning_effort\` values Cline's catalog declares. */
export const CLINE_EFFORT_REASONING_LEVELS: Readonly<Record<string, readonly string[]>> = {
${rows.join('\n')}
};

/** Model ids whose only reasoning control is the boolean \`include_reasoning\`. */
export const CLINE_TOGGLE_REASONING_MODELS: ReadonlySet<string> = new Set([
${toggle.map((id) => `  '${id}',`).join('\n')}
]);
`;

    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, source, 'utf8');
    process.stdout.write(
      `Wrote ${OUTPUT}\n  ${effort.length} models with reasoning_effort tiers\n` +
        `  ${toggle.length} models with include_reasoning only\n`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Split Cline's catalog into models that take a `reasoning_effort` tier and
 * models whose only reasoning control is the boolean `include_reasoning`.
 * An `effort` entry always wins: it is the finer control.
 */
export function partitionReasoningModels(models: Record<string, CatalogModel>): {
  effort: Array<[string, string[]]>;
  toggle: string[];
} {
  const effort: Array<[string, string[]]> = [];
  const toggle: string[] = [];
  for (const [id, model] of Object.entries(models)) {
    const options = asOptions(model.reasoningOptions);
    const tiered = options.find(
      (option) => option.type === 'effort' && effortValues(option).length > 0,
    );
    if (tiered) {
      effort.push([id, orderLevels(effortValues(tiered))]);
    } else if (options.some((option) => option.type === 'toggle')) {
      toggle.push(id);
    }
  }
  effort.sort(([a], [b]) => a.localeCompare(b));
  toggle.sort();
  return { effort, toggle };
}

await main();
