// Renders every generated contract file in memory. The generator script writes
// them; `api:check` compares them against the committed files.

import { format } from 'prettier';
import { buildRouteManifest, type ManifestRoute } from './manifest';
import { buildOpenApiDocument } from './openapi';
import { renderGeneratedClient } from './client';

export const OPENAPI_PATH = 'openapi.json';
export const CLIENT_PATH = 'shared/src/api/generated-client.ts';

export type ContractFiles = Readonly<Record<string, string>>;

/** Mirrors the repository's `.prettierrc`; `render.test.ts` fails if they diverge. */
export const PRETTIER_OPTIONS = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  bracketSpacing: true,
  arrowParens: 'always',
} as const;

/** Generated files are committed in the repository's formatting so `format:changed` stays green. */
async function formatGenerated(path: string, text: string): Promise<string> {
  const parser = path.endsWith('.json') ? 'json' : 'typescript';
  return format(text, { ...PRETTIER_OPTIONS, parser });
}

/** JSON with object keys sorted at every depth, so output never depends on declaration order. Arrays keep their order. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortValue(value), null, indent) + '\n';
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export async function renderContractFromManifest(
  routes: readonly ManifestRoute[],
): Promise<ContractFiles> {
  const document = buildOpenApiDocument(routes);
  const raw: Record<string, string> = {
    [OPENAPI_PATH]: stableStringify(document),
    [CLIENT_PATH]: renderGeneratedClient(routes),
  };
  const files: Record<string, string> = {};
  for (const path of Object.keys(raw)) files[path] = await formatGenerated(path, raw[path]!);
  return files;
}

/** Builds the manifest from the real app and renders all files. Requires the process environment set up by the caller (see scripts/generate-api-contract.ts). */
export async function renderApiContract(): Promise<ContractFiles> {
  const routes = await buildRouteManifest();
  return renderContractFromManifest(routes);
}

/** Paths whose committed content differs from the freshly rendered content (a missing file counts as different). */
export function findStaleFiles(
  expected: ContractFiles,
  actual: (path: string) => string | undefined,
): string[] {
  return Object.keys(expected)
    .sort()
    .filter((path) => actual(path) !== expected[path]);
}
