// Rules & skills mirroring for CLI deep integration (Phase 6).
//
// Writes Koryphaios session rules + skill files to each CLI's isolated home
// directory so the CLI discovers them on startup. This gives the CLI access
// to Kory's domain knowledge (project conventions, tool usage patterns, etc.)
// without the CLI needing its own rules system.
//
// Rules files by CLI:
//   devin       → AGENTS.md + .devin/skills/<name>/SKILL.md
//   claude      → CLAUDE.md
//   antigravity → AGENTS.md
//   codex       → AGENTS.md (codex reads it if present)
//   cline       → .clinerules (cline reads it if present)
//   cursor      → .cursorrules (cursor reads it if present)
//   grok        → .grokrules (grok reads it if present)
//
// Skills files by CLI:
//   devin       → .devin/skills/<name>/SKILL.md (native skills system)
//   antigravity → .claude/skills/<name>/SKILL.md (imported from Claude)
//   others      → no skills system (rules file only)

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { providerLog } from '../logger';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';

export interface KoryRuleContent {
  title: string;
  body: string;
}

export interface KorySkillContent {
  name: string;
  description: string;
  body: string;
}

type CliRulesEnvironment = Pick<
  NodeJS.ProcessEnv,
  'KORY_DISABLE_CLI_AUTODETECT' | 'KORYPHAIOS_DATA_DIR'
>;

export interface CliRulesWriteOptions {
  env?: CliRulesEnvironment;
  homeDirectory?: string;
}

/**
 * Resolve the only directory session creation may use for managed CLI homes.
 *
 * CLI autodetection opt-out is also a filesystem opt-out: a provider-free or
 * isolated run must not create provider homes as a side effect of creating a
 * chat. An explicit KORYPHAIOS_DATA_DIR keeps every managed home inside that
 * same test/profile boundary. Normal desktop installs retain the established
 * ~/.koryphaios location.
 */
export function resolveManagedCliHomeRoot(options: CliRulesWriteOptions = {}): string | null {
  const env = options.env ?? process.env;
  if (env.KORY_DISABLE_CLI_AUTODETECT?.trim()) return null;

  const dataDirectory = env.KORYPHAIOS_DATA_DIR?.trim();
  if (dataDirectory) return join(resolve(dataDirectory), 'cli-homes');

  return join(options.homeDirectory ?? homedir(), '.koryphaios');
}

/** Build the default Kory rules content for a session. */
export function buildKoryRules(systemPrompt: string): string {
  return [
    '# Koryphaios Session Rules',
    '',
    '## Tool Usage',
    '',
    '- Use kory__ MCP tools for ALL file, shell, web, and note operations.',
    '- Do NOT use native built-in tools (Read, Edit, Write, Bash, etc.) — they are disabled.',
    '- Every kory__ tool call goes through Koryphaios permission + sandbox policy.',
    '- Use kory__delegate_to_worker for parallelization — never spawn subagents.',
    '',
    '## Orchestration',
    '',
    '- Koryphaios owns orchestration: the manager dispatches tasks to workers.',
    '- Workers complete tasks and return results to the manager.',
    '- The critic verifies work quality before tasks are marked complete.',
    '',
    '## Session Context',
    '',
    systemPrompt.trim(),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build the default Kory skills for a session. */
export function buildKorySkills(): KorySkillContent[] {
  return [
    {
      name: 'kory-tool-usage',
      description: 'How to use kory__ MCP tools instead of native CLI tools',
      body: [
        '# Kory Tool Usage',
        '',
        '## File Operations',
        '- kory__read_file: Read a file',
        '- kory__write_file: Write/create a file',
        '- kory__edit_file: Edit a file (find & replace)',
        '- kory__batch_edit: Multiple edits to one file',
        '- kory__delete_file: Delete a file',
        '- kory__move_file: Move/rename a file',
        '- kory__diff: Show diff between two files',
        '- kory__patch: Apply a unified diff patch',
        '',
        '## Search',
        '- kory__grep: Search file contents (ripgrep)',
        '- kory__glob: Find files by pattern',
        '- kory__ls: List directory contents',
        '',
        '## Shell',
        '- kory__bash: Execute a shell command (sandboxed)',
        '',
        '## Web',
        '- kory__web_search: Search the web',
        '- kory__web_fetch: Fetch a URL',
        '',
        '## Notes (Knowledge Graph)',
        '- kory__record_work_note: Record a structured result with Kory-owned run provenance',
        '- kory__create_note: Create a note',
        '- kory__read_note: Read a note',
        '- kory__search_notes: Full-text search notes',
        '- kory__recall_notes: Semantic recall from notes',
        '- kory__link_notes: Link two notes',
        '',
        '## Delegation',
        '- kory__delegate_to_worker: Delegate a task to a Kory worker agent',
        '- kory__delegate_to_jules: Delegate to Google Jules (cloud async)',
        '',
        '## Git',
        '- kory__commit_and_create_pr: Commit + create PR',
      ].join('\n'),
    },
    {
      name: 'kory-orchestration',
      description: 'How Koryphaios orchestration works (manager/worker/critic)',
      body: [
        '# Koryphaios Orchestration',
        '',
        '## Roles',
        '- **Manager**: Decomposes tasks, delegates to workers, verifies results.',
        '- **Worker**: Executes tasks using kory__ tools, returns results.',
        '- **Critic**: Reviews work quality, gates task completion.',
        '',
        '## Delegation Flow',
        '1. Manager receives a task from the user.',
        '2. Manager calls kory__delegate_to_worker with a subtask description.',
        '3. Koryphaios dispatches a worker agent that executes the subtask.',
        '4. Worker returns its result to the manager.',
        '5. Manager may call the critic to verify quality.',
        '6. Manager returns the final result to the user.',
        '',
        '## Rules',
        '- Never spawn native subagents — always use kory__delegate_to_worker.',
        '- Workers should not delegate further — return results to the manager.',
        '- The critic can block task completion if quality is insufficient.',
        '',
        '## Goals and reusable workflows',
        '- Suggest Goal Mode when an outcome is long-running, multi-session, dependency-heavy, or needs durable evidence tracking.',
        '- Suggest a reusable workflow when the same ordered procedure is likely to recur.',
        '- Suggest briefly at a natural boundary. Do not interrupt active work or suggest either for ordinary questions, one-off fixes, or small edits.',
        '- Never create a goal or workflow without explicit user approval.',
      ].join('\n'),
    },
  ];
}

/** Write rules + skills files to a CLI's isolated home directory. */
export function writeRulesAndSkills(
  homeDir: string,
  provider: string,
  systemPrompt: string,
  rulesFile: string,
  skillsDir: string | null,
  managedRoot?: string,
): void {
  try {
    const storage = managedRoot ? { root: managedRoot } : {};
    ensureManagedCliDirectory(homeDir, storage);
    // Write the rules file.
    const rulesPath = join(homeDir, rulesFile);
    writeManagedCliFile(rulesPath, buildKoryRules(systemPrompt), { encoding: 'utf8' }, storage);
    // Write skills if the CLI supports them.
    if (skillsDir) {
      const skills = buildKorySkills();
      for (const skill of skills) {
        const skillDir = join(homeDir, skillsDir, skill.name);
        ensureManagedCliDirectory(skillDir, storage);
        writeManagedCliFile(join(skillDir, 'SKILL.md'), skill.body, { encoding: 'utf8' }, storage);
      }
    }
    providerLog.debug({ provider, rulesFile }, 'Wrote private Kory rules + skills for CLI');
  } catch {
    providerLog.warn({ provider }, 'Failed to write private Kory rules + skills');
  }
}

/** Write rules + skills for all supported CLIs. Called once at session start. */
export function writeAllCliRulesAndSkills(
  sessionId: string,
  systemPrompt: string,
  options: CliRulesWriteOptions = {},
): boolean {
  const base = resolveManagedCliHomeRoot(options);
  if (!base) {
    providerLog.debug(
      { sessionId },
      'Skipped CLI rules + skills because CLI autodetection is disabled',
    );
    return false;
  }
  // Devin: AGENTS.md + .devin/skills/
  writeRulesAndSkills(
    join(base, 'devin-home', sessionId),
    'devin',
    systemPrompt,
    'AGENTS.md',
    '.devin/skills',
    base,
  );
  // Claude Code: CLAUDE.md (no skills system)
  writeRulesAndSkills(join(base, 'claude-home'), 'claude', systemPrompt, 'CLAUDE.md', null, base);
  // Antigravity: AGENTS.md + .claude/skills/ (imported from Claude)
  writeRulesAndSkills(
    join(base, 'antigravity-home'),
    'antigravity',
    systemPrompt,
    'AGENTS.md',
    '.claude/skills',
    base,
  );
  // Codex: AGENTS.md (no skills)
  writeRulesAndSkills(join(base, 'codex-home'), 'codex', systemPrompt, 'AGENTS.md', null, base);
  // Cline: .clinerules
  writeRulesAndSkills(join(base, 'cline-home'), 'cline', systemPrompt, '.clinerules', null, base);
  // Cursor: .cursorrules
  writeRulesAndSkills(
    join(base, 'cursor-home'),
    'cursor',
    systemPrompt,
    '.cursorrules',
    null,
    base,
  );
  // Grok: .grokrules
  writeRulesAndSkills(join(base, 'grok-home'), 'grok', systemPrompt, '.grokrules', null, base);
  return true;
}
