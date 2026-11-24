# Koryphaios Update System

Koryphaios uses Tauri's updater plugin with a static manifest hosted on GitHub Releases:

```
https://github.com/Sylorlabs/Koryphaios/releases/latest/download/latest.json
```

Updates are never server-pushed. A production desktop build checks for an installable release on launch and every 30 minutes while running, and polls release activity every 5 minutes so a newly triggered Actions run appears promptly. If a newer release is found during an **interactive launch**, the app installs it before the workspace becomes usable and relaunches. If a newer release is found **while the app is already in use**, nothing changes automatically: the title bar shows an update pill to the left of Feedback, and installation starts only when the user opens it and clicks **Install & Restart**.

A `--background` / login-item launch, a development build, and `KORY_DISABLE_AUTO_UPDATE=1` never auto-install. In-session checks only notify.

## Installed-app flow

1. The app fetches `latest.json`.
2. Tauri compares the manifest version with the packaged application version.
3. The user is notified when a newer version is available.
4. The user clicks **Install & Restart**.
5. Tauri downloads the package matching the installed bundle type.
6. Tauri verifies its minisign signature using the public key embedded in `tauri.conf.json`.
7. The package is installed and the application relaunches.

Downloads have a 30-minute timeout. This accommodates the current AppImage size on slow connections while still terminating stalled downloads.

## Release activity (GitHub Actions)

The title-bar pill can appear before a release is installable. The local backend polls the configured release workflows through `GET /api/updates/status` and reports one of two phases:

- **preparing** — `auto-release.yml` was triggered by a `/update` commit or a manual **Prepare Release** dispatch, and the version is read from `tauri.conf.json` at the run's commit.
- **building** — `release-desktop.yml` is queued or in progress on a `v*` tag.

Only queued/in-progress runs newer than the running build are reported. A failed probe is a soft miss and never an update. The signed `latest.json` manifest remains the only source of truth for installability; a preparing/building pill opens the Actions run and cannot install anything.

Configuration:

| Variable                       | Default                | Purpose                                      |
| ------------------------------ | ---------------------- | -------------------------------------------- |
| `KORY_UPDATE_REPO`             | `Sylorlabs/Koryphaios` | Repository to inspect                        |
| `KORY_UPDATE_WORKFLOW`         | `release-desktop.yml`  | Workflow that builds a tagged release        |
| `KORY_UPDATE_PREPARE_WORKFLOW` | `auto-release.yml`     | Workflow that validates and tags a release   |
| `KORY_UPDATE_GITHUB_TOKEN`     | unset                  | Optional read-only token for API rate limits |

Successful probes are cached for five minutes; failures for one minute. `?refresh=1` forces a probe.

## Manifest targets

CI generates `latest.json` from signed release assets. Linux entries are package-specific because Tauri chooses the installed bundle type before the generic target:

| Installed package   | Manifest target         | Artifact               |
| ------------------- | ----------------------- | ---------------------- |
| Windows NSIS        | `windows-x86_64`        | `*-x64-setup.exe`      |
| macOS Apple silicon | `darwin-aarch64`        | `*aarch64*.app.tar.gz` |
| macOS Intel         | `darwin-x86_64`         | `*x86_64*.app.tar.gz`  |
| Linux AppImage      | `linux-x86_64-appimage` | `*.AppImage`           |
| Linux DEB           | `linux-x86_64-deb`      | `*.deb`                |
| Linux RPM           | `linux-x86_64-rpm`      | `*.rpm`                |

Every updater artifact has a non-empty `.sig` generated with `TAURI_SIGNING_PRIVATE_KEY`. A DEB or RPM target must never point to AppImage bytes.

## Release process

Versions are prepared in source control before release. These files must agree:

- `desktop/src-tauri/tauri.conf.json`
- `desktop/src-tauri/Cargo.toml`
- `package.json` and every workspace `package.json`
- `frontend/static/app.config.json`
- `config/app.config.json`

A push containing `/update` in its commit message or a manual **Prepare Release** dispatch performs the following sequence:

1. Validate version alignment and confirm the version tag does not exist.
2. Resolve a successful all-platform `build-shell.yml` run whose shell-relevant source exactly matches the prepared commit.
3. Create and push the immutable version tag only after shell preflight succeeds.
4. Dispatch `release-desktop.yml` on that tag.
5. Revalidate the tag, signing key, versions, and exact shell-build provenance.
6. Assemble and sign Windows, macOS, AppImage, DEB, and RPM packages.
7. Upload assets and `latest.json` to a draft GitHub release.
8. Fresh-install and launch the candidate packages on Windows, macOS, and Linux.
9. Promote the draft only when those packaged smoke tests pass.
10. Install public v0.1.0 packages, discover the new public release, download it, verify it, install it, and confirm relaunch into the expected version on Windows, macOS, Linux AppImage, and Linux DEB.

The old-to-new upgrade matrix runs after promotion because GitHub intentionally excludes draft releases from the fixed `/releases/latest` endpoint used by v0.1.0. Its result is still a release quality check, but it cannot prevent that release from becoming public. RPM joins the upgrade matrix with the next release because v0.1.0 did not publish an RPM artifact.

Do not run `/update` until an all-platform shell build with matching shell-relevant source can succeed. The workflow refuses to create the tag when shell provenance is missing or failed, so a failed preflight cannot consume the version.

## Windows updater contract

Tauri launches the NSIS updater with its managed flags:

- `/P` for passive mode or `/S` for quiet mode
- `/R` to relaunch after installation
- `/UPDATE` to identify an update installation
- `/ARGS` followed by the current application arguments

The custom installer parses these flags, skips interactive pages during an update, preserves the prior install directory, and relaunches Koryphaios after passive or silent installation.

## Required GitHub configuration

| Name                                 | Type   | Purpose                                                        |
| ------------------------------------ | ------ | -------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Secret | Signs updater artifacts                                        |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | Unlocks the signing key when configured                        |
| `RELAY_URL`                          | Secret | Builds the collaboration relay endpoint into packaged backends |

A repository-level `SHELL_BUILD_RUN_ID` variable is not required. Both release workflows resolve and pin a successful `build-shell.yml` run with shell-relevant source identical to the release commit.

## Files involved

| File                                                     | Purpose                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `.github/workflows/build-shell.yml`                      | Builds native shell binaries on all supported platforms                  |
| `.github/workflows/auto-release.yml`                     | Validates the prepared release and creates the tag after shell preflight |
| `.github/workflows/release-desktop.yml`                  | Assembles, signs, uploads, and generates `latest.json`                   |
| `.github/workflows/smoke-test.yml`                       | Fresh-install smoke tests, promotion, and old-to-new upgrade checks      |
| `scripts/assemble-windows-installer.sh`                  | Builds the custom updater-compatible NSIS installer                      |
| `desktop/src-tauri/tauri.conf.json`                      | Updater endpoint, public key, and packaged version                       |
| `desktop/src-tauri/src/lib.rs`                           | Native check, download, verification, installation, and restart commands |
| `frontend/src/lib/stores/updater.svelte.ts`              | Launch/manual/periodic checks and UI state                               |
| `frontend/src/lib/components/UpdateDialog.svelte`        | User-confirmed installation UI                                           |
| `frontend/src/lib/components/LaunchUpdateOverlay.svelte` | Blocking launch-time install UI                                          |
| `backend/src/services/update-release-status.ts`          | Cached GitHub Actions release-activity probe                             |
| `backend/src/routes/v1/updates.ts`                       | `GET /api/updates/status`                                                |

## Troubleshooting

1. Confirm the release is public and marked latest.
2. Confirm `latest.json` is attached and has a version newer than the installed application.
3. Confirm the installed bundle's package-specific target exists.
4. Confirm its URL points to the matching file format and its signature is non-empty.
5. Confirm the asset URL returns the expected package bytes.
6. Review the packaged smoke and post-promotion upgrade jobs.
7. Use the in-app **Check for Updates** action in a production build; development builds intentionally do not update.
