/**
 * Offline evidence inventory, not runtime policy or a supported-version list.
 * Keep imports type-only: reading this catalog must never discover or start a CLI.
 * Paths are repository-relative; anchors make evidence reviewable and detect drift.
 */
import type { ProviderName } from '@koryphaios/shared';

export interface CliCompatibilityEvidence {
  readonly level: 'source-contract' | 'synthetic-fixture' | 'plumbing-test';
  readonly path: string;
  readonly anchor: string;
  readonly scope: string;
}

export interface CliAdapterCompatibility {
  readonly provider: ProviderName;
  readonly binary: string;
  readonly transport: string;
  /** Unknown is deliberate: fixtures and source comments do not qualify releases. */
  readonly supportedVersions: 'unknown';
  readonly liveVerification: 'not-established';
  readonly versionBoundary: {
    readonly kind: 'unknown' | 'implementation-branch' | 'source-reference';
    readonly detail: string;
  };
  readonly evidence: readonly CliCompatibilityEvidence[];
  readonly revalidate: readonly string[];
}

const source = (file: string, anchor: string, scope: string): CliCompatibilityEvidence => ({
  level: 'source-contract',
  path: `backend/src/providers/${file}.ts`,
  anchor,
  scope,
});
const fixture = (
  file: string,
  anchor: string,
  scope: string,
  level: 'synthetic-fixture' | 'plumbing-test' = 'synthetic-fixture',
): CliCompatibilityEvidence => ({
  level,
  path: `backend/src/providers/__tests__/${file}.test.ts`,
  anchor,
  scope,
});
const unknownBoundary = {
  kind: 'unknown',
  detail: 'No CLI release range is established by the cited local evidence.',
} as const;
const unverified = { supportedVersions: 'unknown', liveVerification: 'not-established' } as const;

export const CLI_ADAPTER_COMPATIBILITY = [
  {
    ...unverified,
    provider: 'claude',
    binary: 'claude',
    transport: 'Print mode with stream-json output and private prompt artifacts/stdin',
    versionBoundary: unknownBoundary,
    evidence: [
      source(
        'claude-code',
        '--append-system-prompt-file',
        'Private system prompt file and stream-json invocation.',
      ),
      fixture(
        'claude-code',
        'isAvailable requires opt-in or detected login; disabled blocks it',
        'Local availability/plumbing only; gated live tests are not evidence of a completed live run.',
        'plumbing-test',
      ),
    ],
    revalidate: [
      'Print flags and stream-json events',
      'Private input, MCP restrictions, effort capability probing',
    ],
  },
  {
    ...unverified,
    provider: 'codex',
    binary: 'codex',
    transport: 'exec --json; app-server --stdio for model discovery',
    versionBoundary: unknownBoundary,
    evidence: [
      source(
        'codex-cli',
        "['app-server', '--stdio']",
        'Model discovery uses the local app-server protocol.',
      ),
      fixture(
        'codex-cli',
        'surfaces native file/web/todo items as display-only tool rows instead of dropping them',
        'Canned event normalization, not native tool execution.',
      ),
      fixture(
        'codex-cli',
        'keeps real auth failures fail-closed',
        'Synthetic retry/auth error classification.',
      ),
    ],
    revalidate: [
      'exec flags, stdin/image input, JSON event variants',
      'App-server discovery, MCP profile, retry and auth errors',
    ],
  },
  {
    ...unverified,
    provider: 'codex-auth',
    binary: 'codex',
    transport: 'Managed app-server account/model state plus Codex CLI execution',
    versionBoundary: unknownBoundary,
    evidence: [
      source(
        'codex-auth',
        'getManagedCodexAppServer',
        'Managed account state; separate from API-key OpenAI provider.',
      ),
      fixture(
        'codex-auth',
        'activates a fresh provider from app-server ChatGPT state without raw OAuth tokens',
        'Mocked account/model RPC and registry activation.',
        'plumbing-test',
      ),
    ],
    revalidate: [
      'Managed account/model RPC shapes',
      'Private Codex execution profile and shared JSON parser',
    ],
  },
  {
    ...unverified,
    provider: 'grok',
    binary: 'grok',
    transport: 'Headless JSON output plus session updates.jsonl telemetry',
    versionBoundary: unknownBoundary,
    evidence: [
      source(
        'grok-build',
        'updates.jsonl',
        'Session tool telemetry tailing is an implementation contract.',
      ),
      fixture(
        'grok-build',
        'parses the documented --output-format json final object',
        'Canned final-output parsing.',
      ),
      fixture(
        'grok-build',
        'does not inherit MCP or workspace authority',
        'Research capability restrictions.',
      ),
    ],
    revalidate: [
      'Headless flags and private prompt transport',
      'Final JSON, NDJSON, session telemetry and research restrictions',
    ],
  },
  {
    ...unverified,
    provider: 'antigravity',
    binary: 'agy',
    transport: 'stream-json input/output with transcript telemetry',
    versionBoundary: unknownBoundary,
    evidence: [
      source(
        'antigravity',
        'this agy version lacks private stream input support',
        'Fails closed when private stream input is absent.',
      ),
      fixture(
        'antigravity-stream',
        'does not leak stream protocol or malformed lines into chat',
        'Canned stream parser rejection.',
      ),
      fixture(
        'antigravity-stream',
        'emits authoritative final usage for accounting and Billing',
        'Usage mapping from a synthetic final record.',
      ),
    ],
    revalidate: [
      'Private stream input capability and output event shapes',
      'Transcript telemetry and final usage mapping',
    ],
  },
  {
    ...unverified,
    provider: 'cursor',
    binary: 'cursor-agent',
    transport: 'Print mode with stream-json output',
    versionBoundary: unknownBoundary,
    evidence: [
      source(
        'cursor',
        'stream-json',
        'Streaming invocation is source evidence, not a tested CLI release.',
      ),
      fixture(
        'cursor',
        'parses JSON list output',
        'Model-list parsing only; does not cover generation streaming.',
      ),
      fixture(
        'cursor',
        'records an empty catalog as a fetched result instead of probing on every read',
        'Mocked negative model-cache lifecycle.',
        'plumbing-test',
      ),
    ],
    revalidate: [
      'Print flags, private input, stream and tool events',
      'Model-list command variants and negative cache',
    ],
  },
  {
    ...unverified,
    provider: 'devin',
    binary: 'devin',
    transport: 'Print mode with --prompt-file and --export',
    versionBoundary: unknownBoundary,
    evidence: [
      source('devin', '--prompt-file', 'Private file input and exported response transport.'),
      fixture(
        'devin',
        'prefers exported agent messages over CLI stdout messages',
        'Synthetic export preference and stdout fallback.',
      ),
      fixture(
        'devin-capabilities',
        'does not mistake the models command help for a catalog',
        'Canned model-list rejection.',
      ),
    ],
    revalidate: [
      'Prompt-file/export flags and export schema',
      'Agent-config, permission and sandbox capabilities; model list',
    ],
  },
  {
    ...unverified,
    provider: 'freebuff',
    binary: 'freebuff',
    transport: 'Ink TUI through tmux PTY; log.jsonl evidence; mandatory Linux bubblewrap',
    versionBoundary: {
      kind: 'source-reference',
      detail:
        'AGENTS.md and adapter comments reference 0.0.162. No live validation is established here. Fixture versions 9.8.7 and 10.0.0 are synthetic and are not support claims.',
    },
    evidence: [
      source(
        'freebuff-cli',
        '0.0.162',
        'Version-sensitive TUI/log assumptions recorded in source.',
      ),
      fixture(
        'freebuff-codebuff-contract',
        'discovers picker models and image capabilities from the installed-binary shape',
        'Synthetic bundled-picker bytes, not execution of an installed binary.',
      ),
      fixture(
        'freebuff-codebuff-contract',
        'fails closed when an upgraded binary no longer exposes a recognizable picker catalog',
        'Synthetic unrecognized picker rejection.',
      ),
    ],
    revalidate: [
      'Picker extraction, startup keystrokes, .agents/mcp.json loading and log.jsonl shapes',
      'Linux bubblewrap confinement, disposable checkout, tmux and bridge grants; native tools remain enabled',
    ],
  },
] as const satisfies readonly CliAdapterCompatibility[];

export type CliAdapterProviderName = (typeof CLI_ADAPTER_COMPATIBILITY)[number]['provider'];

/** Derive external-suite categorization from the inventory, not a second list. */
export const CLI_ADAPTER_PROVIDER_NAMES: readonly CliAdapterProviderName[] =
  CLI_ADAPTER_COMPATIBILITY.map((entry) => entry.provider);

/** Evidence scopes and concrete suite paths are available to offline reports. */
export const CLI_ADAPTER_COMPATIBILITY_BY_PROVIDER: ReadonlyMap<
  CliAdapterProviderName,
  CliAdapterCompatibility
> = new Map<CliAdapterProviderName, CliAdapterCompatibility>(
  CLI_ADAPTER_COMPATIBILITY.map((entry) => [entry.provider, entry]),
);

/** Exact identifiers only; unknown providers must not inherit a family claim. */
export function getCliAdapterCompatibility(provider: string): CliAdapterCompatibility | undefined {
  return CLI_ADAPTER_COMPATIBILITY.find((entry) => entry.provider === provider);
}
