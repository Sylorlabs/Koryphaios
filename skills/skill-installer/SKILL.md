---
name: skill-installer
description: Install Codex skills into $CODEX_HOME/skills from a curated list, experimental list, or a GitHub repo path. Use when a user asks to list installable skills, install a curated or experimental skill, install a skill from another repo (including private repos), update an existing skill from its source, or troubleshoot a failed skill installation. Even for vague requests like "I want to add more skills" or "what skills are available" — this skill handles discovery, installation, conflict detection, and post-install verification.
metadata:
  koryphaios:
    version: 1.0.0
    baseVersion: 1.0.0
    baseHash: __BASE_HASH__
    parent:
    depth: 0
    requires: []
    conflicts: []
    activation: ["install a skill", "list skills", "what skills are available", "install skill from github"]
    excludes: []
    domains: ["skills"]
    targetMedia: ["any"]
    shouldTrigger: ["install the pdf skill", "what skills are available", "install a skill from github"]
    shouldNotTrigger: ["create a new skill from scratch", "fix a CSS bug"]
    evidence: ["Installation result and validation"]
    contextBudget: 4000
    sourceScope: local-only
---

# Skill Installer

Helps install skills from GitHub repos into `$CODEX_HOME/skills` (defaults to `~/.codex/skills`). By default these are from `https://github.com/openai/skills/tree/main/skills/.curated`, but users can install from any GitHub repo including private ones.

## Decision Tree: What Does the User Want?

```
User request?
├─ "What skills are available?" / "list skills" / "show me skills"
│  └─ List skills → scripts/list-skills.py
│     ├─ Default: .curated list
│     └─ If "experimental": --path skills/.experimental
│
├─ "Install <skill-name>" (from curated/experimental)
│  └─ Install from openai/skills → scripts/install-skill-from-github.py
│     ├─ Curated: --repo openai/skills --path skills/.curated/<name>
│     └─ Experimental: --repo openai/skills --path skills/.experimental/<name>
│
├─ "Install from <GitHub URL>" or "install from <owner/repo>"
│  └─ Install from custom repo → scripts/install-skill-from-github.py
│     ├─ With URL: --url https://github.com/<owner>/<repo>/tree/<ref>/<path>
│     └─ With repo+path: --repo <owner>/<repo> --path <path/to/skill>
│
├─ "Update/reinstall <skill>" (already installed)
│  └─ Remove old + reinstall → see Updating section below
│
└─ "Install failed" / "skill not working"
   └─ Troubleshoot → see Failure Modes section below
```

## Workflow

1. **Classify the request** using the decision tree above.
2. **Check prerequisites** — see below.
3. **Run the appropriate script** with the correct arguments.
4. **Verify installation** — see Post-Install Verification below.
5. **Report results** to the user with next steps.

## Prerequisites

Before running any install script:

- **Network access**: All scripts use network. In sandboxed environments, request escalation before running.
- **GitHub token (for private repos)**: Check `GITHUB_TOKEN` or `GH_TOKEN` environment variables. If the repo is private and no token is set, ask the user to set one before proceeding.
- **Destination directory**: Skills install into `$CODEX_HOME/skills/` (or `~/.codex/skills` when `CODEX_HOME` is unset). The directory is created automatically if it doesn't exist.

## Listing Skills

When the user asks what's available, or uses this skill without specifying what to do:

```bash
scripts/list-skills.py
```

For experimental skills:
```bash
scripts/list-skills.py --path skills/.experimental
```

For JSON output (useful for programmatic processing):
```bash
scripts/list-skills.py --format json
```

### Output Format

Present the list to the user approximately as follows, labeling the source:

```
Skills from openai/skills (.curated):
1. skill-1
2. skill-2 (already installed)
3. skill-3

Which ones would you like installed?
```

If the user asked about experimental skills, list from `.experimental` and label accordingly.

## Installing Skills

### From the Curated List

When the user provides a skill name from the curated list:

```bash
scripts/install-skill-from-github.py --repo openai/skills --path skills/.curated/<skill-name>
```

For experimental skills:
```bash
scripts/install-skill-from-github.py --repo openai/skills --path skills/.experimental/<skill-name>
```

### From a GitHub URL

When the user provides a GitHub URL:

```bash
scripts/install-skill-from-github.py --url https://github.com/<owner>/<repo>/tree/<ref>/<path-to-skill>
```

### From a Repo + Path

When the user provides an owner/repo and path:

```bash
scripts/install-skill-from-github.py --repo <owner>/<repo> --path <path/to/skill> [<path/to/second-skill> ...]
```

### Installing Multiple Skills

Multiple `--path` values install multiple skills in one run. Each is named from the path basename unless `--name` is supplied:

```bash
scripts/install-skill-from-github.py --repo openai/skills --path skills/.curated/skill-a skills/.curated/skill-b
```

### Custom Destination

```bash
scripts/install-skill-from-github.py --repo <owner>/<repo> --path <path> --dest /custom/skills/dir
```

## Installation Methods

The installer defaults to `--method auto`, which tries download first and falls back to git sparse checkout:

| Method | How it works | When it's used |
|--------|-------------|----------------|
| `auto` (default) | Tries download, falls back to git on auth/404 errors | Most cases |
| `download` | Downloads repo ZIP via codeload.github.com | Public repos, faster |
| `git` | Sparse checkout via git clone | Private repos, specific ref needs |

Download is faster and doesn't require git, but fails on private repos without auth. Git fallback tries HTTPS first, then SSH.

### Private Repos

Private repos require either:
- `GITHUB_TOKEN` or `GH_TOKEN` environment variable set
- Existing git credentials (SSH keys or HTTPS credential helper)

If download fails with HTTP 401/403, the installer automatically falls back to git. If git also fails, ask the user to set up authentication.

## Post-Install Verification

After installing a skill, verify it landed correctly:

1. **Check the skill directory exists** and contains `SKILL.md`:
   ```bash
   ls "$CODEX_HOME/skills/<skill-name>/SKILL.md" 2>/dev/null || ls ~/.codex/skills/<skill-name>/SKILL.md 2>/dev/null
   ```

2. **Validate the skill structure** using the skill-creator validator:
   ```bash
   python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" "$CODEX_HOME/skills/<skill-name>"
   ```

3. **Tell the user** the skill will be available on their next turn. Codex discovers skills at session start, so a restart or new turn may be needed.

## Updating an Existing Skill

If the user wants to update or reinstall a skill that's already installed:

1. **Check if the skill exists**: `ls "$CODEX_HOME/skills/<skill-name>"`
2. **Ask for confirmation** before removing: "Skill `<name>` is already installed. Reinstalling will replace it. Proceed?"
3. **Remove the old copy**: `rm -rf "$CODEX_HOME/skills/<skill-name>"`
4. **Reinstall** using the appropriate install command above.

Never silently overwrite an existing skill — always confirm with the user first.

## Failure Modes and Recovery

| Error | Likely cause | Recovery |
|-------|-------------|----------|
| `HTTP 404` on list/install | Wrong repo path or ref | Verify the repo and path exist on GitHub; check the `--ref` (default: `main`) |
| `HTTP 401/403` on download | Private repo without auth | Set `GITHUB_TOKEN` or `GH_TOKEN`; or use `--method git` with SSH credentials |
| `Destination already exists` | Skill with same name already installed | Remove the old skill first (see Updating above) or use `--name` to install under a different name |
| `SKILL.md not found` | Path doesn't point to a valid skill directory | Verify the path contains a `SKILL.md` file; the path should point to the skill folder, not its parent |
| `Git command failed` | Git not installed, or network/SSH issues | Ensure git is installed; for SSH issues, check SSH keys and GitHub connectivity |
| `Network unreachable` / timeout | No network access or proxy blocking | In sandboxed environments, request network escalation; check proxy settings |
| `Invalid skill name` | Name contains path separators or invalid characters | Skill names must be single path segments (no `/`); use `--name` to override |

## When NOT to Use This Skill

- **Installing `.system` skills**: The skills at `https://github.com/openai/skills/tree/main/skills/.system` are preinstalled. If the user asks about these, explain they're already available. If they insist on reinstalling, you can download and overwrite.
- **Creating a new skill from scratch**: Use the `skill-creator` skill instead.
- **Installing plugins**: Use the `plugin-creator` skill or the plugin installation flow.
- **Managing MCP servers**: Use `codex mcp add` directly, not this skill.

## Scripts

All scripts use network — request escalation in sandboxed environments.

| Script | Purpose |
|--------|---------|
| `scripts/list-skills.py` | List available skills with installed annotations |
| `scripts/list-skills.py --format json` | JSON output for programmatic use |
| `scripts/list-skills.py --path skills/.experimental` | List experimental skills |
| `scripts/install-skill-from-github.py --repo <owner>/<repo> --path <path>` | Install from repo + path |
| `scripts/install-skill-from-github.py --url <github-url>` | Install from a GitHub URL |
| `scripts/install-skill-from-github.py --method git` | Force git sparse checkout (for private repos) |

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--repo <owner>/<repo>` | `openai/skills` | GitHub repo to install from |
| `--url <github-url>` | — | Full GitHub URL (alternative to --repo + --path) |
| `--path <path> [<path>...]` | — | Path(s) to skill(s) inside the repo |
| `--ref <ref>` | `main` | Git ref (branch, tag, or commit) |
| `--dest <path>` | `$CODEX_HOME/skills` | Destination skills directory |
| `--name <name>` | basename of path | Destination skill name (for single-skill installs) |
| `--method auto\|download\|git` | `auto` | Installation method |

## Notes

- Curated listing is fetched from the GitHub API. If it's unavailable, explain the error and exit gracefully.
- Git fallback tries HTTPS first, then SSH.
- Installed annotations come from scanning `$CODEX_HOME/skills` for existing directories.
- The installer validates that each source path contains a `SKILL.md` before copying.
- The installer aborts if the destination skill directory already exists — this prevents accidental overwrites.
