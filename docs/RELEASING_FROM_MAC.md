# Release an update from a Mac

This runbook is for an agent or operator who has been told to make a Koryphaios update from a Mac. It covers the full release path: prepare the version, run the local checks, commit the release trigger, put it on `master`, watch the workflows, and confirm that the public release is installable.

The release is not part of normal CI. A normal CI run only tests and builds the code. A release starts only from one of these triggers:

1. A push to `master` or `main` whose final commit message contains `/update`.
2. A manual run of the **Prepare Release** workflow.
3. A push of a `v*` tag, which starts **Release Desktop Apps** directly. Prefer the first two options.

The repository is `Sylorlabs/Koryphaios`. The default branch is `master`. The updater manifest is `latest.json` on the latest public GitHub release.

## Safety rules

1. Do not push, tag, or dispatch a release until the user explicitly asks for an update. A request to "make this an update" is that authorization. A request to "prepare" or "check" is not.
2. Do not force push, delete a tag, edit a published release, or bypass branch protection.
3. Do not reuse a version tag. If the tag exists, stop and choose a new version.
4. Do not put signing keys or other secrets in the repository, a commit, a log, or a chat message.
5. Do not use a direct `v*` tag unless the user asks for it. The normal path is the `/update` commit or the **Prepare Release** dispatch.
6. Do not include unrelated work in the release commit.
7. If a workflow asks for approval and you are not the approver, stop and report the run URL.

## What you need

- A clean checkout of the repository.
- Bun 1.3.14 or the version in `.github/workflows/ci.yml`.
- Git and the GitHub CLI (`gh`).
- `gh auth status` must show an account with write access to `Sylorlabs/Koryphaios`.
- The GitHub token must have `repo` and `workflow` scopes.
- The user must have authorized the release.

Run these first:

```sh
git status --short --branch
git remote -v
gh auth status
```

If the working tree is not clean, stop and ask the user what to include. Do not hide unrelated changes in the release commit.

## Step 1: Choose the version

Read the current version:

```sh
jq -r .version desktop/src-tauri/tauri.conf.json
```

Use the version the user named. If the user did not name one and asked for a normal update, use the next patch version. For example, if the current version is `0.5.0`, use `0.5.1`.

Check that the tag does not exist:

```sh
VERSION=0.5.1
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "Tag exists. Choose a new version."
else
  echo "Tag is free."
fi
```

If the tag exists, the version is already used. Choose a new version. Release tags are immutable.

## Step 2: Update every version surface

Set the version in these files:

- `desktop/src-tauri/tauri.conf.json`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/Cargo.lock`
- `package.json`
- `desktop/package.json`
- `backend/package.json`
- `frontend/package.json`
- `shared/package.json`
- `mcp-server/package.json`
- `frontend/static/app.config.json`
- `config/app.config.json`
- `backend/src/constants.ts`

In `backend/src/constants.ts`, update `VERSION`, `COMPAT.minFrontend`, and `COMPAT.currentFrontend`. If you are not sure whether the frontend and backend contract changed, keep all three equal to the release version.

The release workflow validates the JSON manifests, `Cargo.toml`, and both app configs. It does not validate `Cargo.lock` or `backend/src/constants.ts`, but they must still match so the packaged app reports the correct version.

A safe way to update the JSON files is:

```sh
VERSION=0.5.1

for file in \
  package.json \
  desktop/package.json \
  backend/package.json \
  frontend/package.json \
  shared/package.json \
  mcp-server/package.json
do
  jq --arg version "$VERSION" '.version = $version' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
done

jq --arg version "$VERSION" '.version = $version' \
  desktop/src-tauri/tauri.conf.json > desktop/src-tauri/tauri.conf.json.tmp
mv desktop/src-tauri/tauri.conf.json.tmp desktop/src-tauri/tauri.conf.json

for file in frontend/static/app.config.json config/app.config.json
do
  jq --arg version "$VERSION" '.app.version = $version' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
done
```

For `desktop/src-tauri/Cargo.toml`, change the `version` line in the `[package]` section. For `desktop/src-tauri/Cargo.lock`, change the version under `name = "koryphaios-desktop"`. If Cargo is installed, `cargo check --manifest-path desktop/src-tauri/Cargo.toml` updates the lock file, but that build can take a long time on a Mac.

Add a `CHANGELOG.md` entry under `## Unreleased` or under the new version heading. Describe what users will notice, not internal refactors.

## Step 3: Run the local checks

Run the release dry run after you commit, because it reads the HEAD commit message. Before the commit, it will warn that the trigger is missing. That warning is expected.

Before the commit, run:

```sh
bun run typecheck:ci
bun run test:guards
bun run format:changed
```

Run any focused tests for the code you changed. If a known unrelated test fails, record the failure and do not hide it.

The release workflow requires a successful `ci.yml` run for the release commit. **Prepare Release** waits for CI and refuses to create the tag if CI fails. Do not bypass that gate.

## Step 4: Commit with the trigger

The trigger is the exact string `/update` anywhere in the final commit message on `master`. Put it on its own line so there is no ambiguity.

```sh
git add <the files you changed>
git commit -m "$(cat <<'EOF'
chore(release): prepare v0.5.1

/update
EOF
)"
```

Do not use an em dash or a similar separator in the commit message. The workflow only looks for `/update`.

## Step 5: Run the dry run

```sh
bun run release:dry-run -- --version 0.5.1
```

Read the **Verdict** section. The script checks:

- The HEAD commit message contains `/update`.
- Every version surface matches.
- The version tag does not exist.
- The branch is ahead of its origin branch.
- The working tree is clean.
- Shell source changes will require a fresh shell build.
- The updater public key is present and valid.

The dry run cannot check the CI run or the shell build. The real workflow requires a successful `ci.yml` run and a successful `build-shell.yml` run whose shell source matches the release commit.

The script exits nonzero when it finds blockers. Read the Verdict section and fix every blocker before you push.

The dry run uses the current branch upstream when one exists. If the branch has no upstream, it compares against `origin/master` or `origin/main`. If neither origin branch exists, it warns that it cannot check pushed state.

## Step 6: Put the commit on master

The release trigger only runs on a push to `master` or `main`. A push to a feature branch does not start the release workflow.

Choose one path:

1. If the user authorized a direct push and branch protection allows it, merge or fast forward the release commit into `master`, then push.
2. If branch protection requires a pull request, open a pull request to `master`. The final squash commit or merge commit must contain `/update`.
3. If the user wants a manual release without a merge, use the manual dispatch in Step 7 on `master`. The version must already be prepared on `master`.

For a merge commit:

```sh
git switch master
git pull --ff-only origin master
git merge --no-ff <release_branch> -m "$(cat <<'EOF'
chore(release): prepare v0.5.1

/update
EOF
)"
git push origin master
```

For a squash merge, edit the squash commit message in GitHub so the body contains `/update`. A `/update` commit inside the pull request is not enough, because GitHub checks the final commit message on `master`.

If branch protection blocks the push, stop. Do not use an admin override. Report the protection rule and ask the user how to proceed.

Before you trigger the release, confirm that a successful `ci.yml` run exists for the release commit and that a successful `build-shell.yml` run exists or shell source did not change. If shell source changed, the push to `master` starts `build-shell.yml`. **Prepare Release** waits for CI and for that run, and fails if either gate does not pass.

## Step 7: Manual trigger, if needed

Use this when the user wants a manual release or when the release commit is already on `master` but you do not want to add another commit.

```sh
gh workflow run auto-release.yml --ref master -f version=0.5.1
```

The `version` input is optional. If you provide it, it must match `desktop/src-tauri/tauri.conf.json`. The manual dispatch must run on `master` or `main`. The workflow refuses a feature branch. It does not need `/update`.

If you dispatch from a feature branch, the workflow stops before it creates a tag. Move the prepared commit to `master` or `main` first.

## Step 8: Watch the release

Find the **Prepare Release** run:

```sh
gh run list --workflow=auto-release.yml --limit 5
```

Watch it:

```sh
gh run watch <run_id> --exit-status
```

Then watch the desktop release:

```sh
gh run list --workflow=release-desktop.yml --limit 5
gh run watch <run_id> --exit-status
```

Then watch the smoke test and promotion:

```sh
gh run list --workflow=smoke-test.yml --limit 5
gh run watch <run_id> --exit-status
```

The release sequence is:

1. **Prepare Release** validates versions, confirms the tag is new, finds a successful shell build, creates the tag, and dispatches the desktop release.
2. **Release Desktop Apps** builds and signs the Windows, macOS, AppImage, DEB, and RPM packages. It uploads the assets and `latest.json` to a draft release.
3. **Packaged App Smoke Test** installs and launches the candidate packages on Windows, macOS, Linux AppImage, and Linux DEB. It promotes the draft only after the packaged checks pass.
4. The public release becomes the latest release, and the updater can see it.

Do not announce the release until the smoke test has promoted it.

## Step 9: Verify the public release

```sh
gh release view v0.5.1 --json isDraft,isLatest,assets
```

The release must have `isDraft: false` and `isLatest: true`. Download and inspect the manifest:

```sh
rm -rf /tmp/kory-release
mkdir -p /tmp/kory-release
gh release download v0.5.1 --pattern latest.json --dir /tmp/kory-release
jq '{version, platforms: (.platforms | keys)}' /tmp/kory-release/latest.json
```

The manifest must list these six targets:

- `darwin-aarch64`
- `darwin-x86_64`
- `windows-x86_64`
- `linux-x86_64-appimage`
- `linux-x86_64-deb`
- `linux-x86_64-rpm`

If a target is missing, the release is not installable on that platform. Do not tell users the update is ready.

## What users see

- On the next interactive launch, the app installs the update before the workspace becomes usable and then relaunches.
- If the app is already open, it does not restart by itself. The title bar shows an update pill. The user must click it and choose **Install & Restart**.
- A background launch, a development build, and a run with `KORY_DISABLE_AUTO_UPDATE=1` do not install automatically.
- Users on a build that contains the updater do not need to download a new version manually.

## Check who started a release

Only a user with write access can push to `master`, run **Prepare Release**, or create a `v*` tag. A read only collaborator cannot.

To see the actor for recent runs:

```sh
gh run list --workflow=auto-release.yml \
  --json databaseId,displayTitle,actor,createdAt,status,conclusion
```

The workflows do not check the actor. If the repository has more than one writer, protect `master`, protect `v*` tags, and add a `release` environment with required reviewers. Do not change repository settings during a release.

If someone else starts a release, check the run actor and whether the tag exists. Do not delete the tag. Report the run URL to the user.

## If something fails

**Prepare Release fails before it creates the tag.** Fix the version alignment or shell build, then retry. The version is not consumed because no tag exists.

**Prepare Release fails because the shell build is missing.** Run the shell build on `master`:

```sh
gh workflow run build-shell.yml --ref master
```

Wait for it to succeed, then rerun **Prepare Release**. If shell source changed, the workflow will not accept an older shell build.

**Prepare Release fails because the tag already exists.** Stop. Choose a new version. Do not delete or reuse the tag.

**Release Desktop Apps fails while the release is still a draft.** Inspect the failed job, fix the cause, and rerun the workflow on the same tag:

```sh
gh workflow run release-desktop.yml --ref v0.5.1
```

A draft release can be reused.

**Release Desktop Apps fails after the release is public.** Do not reuse the tag. Bump the version and start a new release.

**Smoke tests fail.** The draft stays unpublished. Inspect the failed platform or package, fix the cause, and rerun the release or the smoke test. Do not promote manually unless the user explicitly asks.

**The signing secret is missing.** Stop. Only a repository owner can fix the secret. Do not try to sign with a local key.

## Commands that do not release

These are safe to run for checks:

```sh
bun run release:dry-run -- --version 0.5.1
bun run typecheck:ci
bun run test:guards
gh run list --workflow=auto-release.yml --limit 5
gh release view v0.5.1 --json isDraft,isLatest,assets
```

A normal CI run does not release. A feature branch push does not release. A pull request does not release. A draft release does not reach users.

## Related documents

- `docs/UPDATES.md` explains the updater contract and the release sequence.
- `.github/workflows/auto-release.yml` is the release trigger.
- `.github/workflows/release-desktop.yml` builds and signs the packages.
- `.github/workflows/smoke-test.yml` promotes the draft.
- `scripts/release-dry-run.ts` is the local rehearsal.
