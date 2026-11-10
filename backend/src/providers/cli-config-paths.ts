import { join } from 'node:path';

/**
 * Where a native CLI might look for its MCP server list inside an isolated home.
 *
 * Koryphaios redirects a CLI's home/config root to a private directory and then
 * writes `mcp.json` into it. Whether the CLI resolves that file relative to the
 * root it was handed (`<home>/mcp.json`) or relative to a dot-directory inside
 * it (`<home>/.cursor/mcp.json`) depends on a config-root environment variable
 * whose semantics are unconfirmed for some providers.
 *
 * For `codex` and `devin` this is settled: `CODEX_HOME` is a documented root and
 * `DEVIN_CONFIG_DIR`/`devin/config.json` was confirmed by running the CLI's own
 * `doctor`. For `cursor` and `grok` the CLI is not installed on the authoring
 * host, so the resolution is a genuine unknown.
 *
 * Writing every candidate is a deliberate hedge, not an assertion that any one
 * is right: the CLI reads exactly one of them, an unread extra file is inert,
 * and it means a Koryphaios turn can never silently end up with no `kory__*`
 * tools at all. Once a CLI can be measured, replace this with the single
 * verified path and record it in AGENTS.md.
 */
export function mcpConfigCandidates(homeDir: string, dotDir: string): string[] {
  return [join(homeDir, 'mcp.json'), join(homeDir, dotDir, 'mcp.json')];
}

/**
 * Credential/config files that must be visible inside an isolated home.
 *
 * Same reasoning as {@link mcpConfigCandidates}: a CLI that resolves its config
 * relative to a dot-directory needs the file nested there, while one handed the
 * directory itself expects it at the root. Linking both keeps the child
 * authenticated either way — the failure mode this avoids is the CLI reporting
 * "sign in" on every turn, which is exactly what an empty isolated home causes.
 */
export function credentialLinkCandidates(
  realConfigDir: string,
  homeDir: string,
  dotDir: string,
  files: readonly string[],
): Array<{ source: string; target: string }> {
  const out: Array<{ source: string; target: string }> = [];
  for (const file of files) {
    const source = join(realConfigDir, file);
    out.push({ source, target: join(homeDir, file) });
    out.push({ source, target: join(homeDir, dotDir, file) });
  }
  return out;
}
