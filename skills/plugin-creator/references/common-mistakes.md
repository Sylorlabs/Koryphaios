# Common Plugin Manifest Mistakes and Edge Cases

Read this when troubleshooting plugin creation or when the user hits validation failures.

## Table of Contents

- [Common Manifest Mistakes](#common-manifest-mistakes)
- [Marketplace Mistakes](#marketplace-mistakes)
- [Edge Cases](#edge-cases)

## Common Manifest Mistakes

| Mistake | Why it happens | Fix |
|---------|---------------|-----|
| `[TODO: ...]` placeholders left in manifest | Scaffold generates placeholders that weren't filled in | Replace all TODOs with real values before validating |
| `hooks` field in plugin.json | Copied from a reference that included it | Remove `hooks` from plugin.json — validation rejects it. Hooks go in a separate hooks file referenced by the `hooks` path |
| `apps` field without `.app.json` | Added the field but didn't create the companion file | Either create `.app.json` or remove the `apps` field |
| `mcpServers` field without `.mcp.json` | Same as apps — field without companion file | Create `.mcp.json` or remove the field, or use inline object form |
| Folder name doesn't match `plugin.json` name | Manually renamed one but not the other | Both must be the same normalized name — use `--force` to re-scaffold or rename both |
| `version` not strict semver | Used "1.0" or "v1.0.0" instead of "1.0.0" | Use strict semver: `MAJOR.MINOR.PATCH` without `v` prefix |
| Non-https URLs in `websiteURL`/`privacyPolicyURL`/`termsOfServiceURL` | Used `http://` or relative paths | Must be absolute `https://` URLs |
| Screenshot paths outside `./assets/` | Referenced files in other directories | Screenshots must be PNG files under `./assets/` |
| More than 3 `defaultPrompt` entries | Added many starter prompts | Keep at most 3; extras are silently ignored |
| `defaultPrompt` entries over 128 chars | Long prompt strings | Truncate to ≤128 chars; prefer ~50 chars for UI scanning |
| Icon/logo paths pointing to non-existent files | Referenced assets not yet created | Create the asset files first, or remove the path |
| `name` with uppercase or spaces | Used display name as identifier | Normalize to lowercase hyphen-case |

## Marketplace Mistakes

| Mistake | Why it happens | Fix |
|---------|---------------|-----|
| `displayName` inside individual plugin entry | Confused marketplace-level vs plugin-level fields | `displayName` belongs in top-level `interface`, not in `plugins[]` entries |
| Missing `policy.installation` on entry | Assumed defaults would be filled in | Always write `policy.installation` explicitly, even when it's the default `AVAILABLE` |
| Missing `policy.authentication` on entry | Same as above | Always write `policy.authentication` explicitly |
| Missing `category` on entry | Assumed optional | Always include `category` — it's required on every entry |
| `source.path` not relative to marketplace root | Used absolute path or wrong relative base | Use `./plugins/<plugin-name>` relative to the marketplace file |
| Using `--marketplace-name` to rename existing file | Misunderstood the flag's purpose | `--marketplace-name` is only for seeding a NEW marketplace with a different name. To use an existing file, just point to it |
| Telling user to run `codex plugin marketplace add` for personal marketplace | Over-applied the non-default flow | The default `~/.agents/plugins/marketplace.json` is discovered implicitly — no install command needed |
| Not verifying non-default marketplace is installed | User specified `--marketplace-path` but marketplace wasn't configured | Run `codex plugin marketplace add <path>` before giving reinstall instructions |

## Edge Cases

### Plugin name normalization

The scaffold normalizes names automatically, but understand the rules:

| Input | Normalized | Rule |
|-------|-----------|------|
| `My Plugin` | `my-plugin` | Spaces → hyphens, lowercase |
| `My--Plugin` | `my-plugin` | Consecutive hyphens collapsed |
| `My_Plugin` | `my-plugin` | Underscores → hyphens |
| `My.Plugin!` | `my-plugin` | Punctuation → hyphens |
| `plugin-name` | `plugin-name` | Already normalized |
| `  My Plugin  ` | `my-plugin` | Trimmed then normalized |

### Multiple plugins in one run

When creating multiple plugins, each gets its own directory and manifest. The `--with-marketplace` flag adds all of them to the same marketplace file in order.

### Updating an existing plugin during development

Don't hand-edit `marketplace.json` or `plugin.json` metadata fields that the scaffold manages. Use:

```bash
python3 scripts/update_plugin_cachebuster.py <plugin-path>
```

This bumps the cachebuster and triggers a reinstall flow. See `references/installing-and-updating.md` for the full update workflow.

### Deeplinks for Codex app handoff

After creating or updating a marketplace-backed plugin, end with a Codex app handoff:

- **View**: `codex://plugins/<normalized-name>?marketplacePath=<absolute-marketplace-json-path>`
- **Share**: same URL with `&mode=share`

URL-encode the path segment and query value. Do not add `pluginName` or `hostId` — Codex derives both after the click. Only emit these links when a marketplace entry was actually created or updated.
