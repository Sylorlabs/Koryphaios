# Koryphaios installer scripts

These files are the **source of truth** for the public installers:

| File | Served at | Used by |
| --- | --- | --- |
| `install.sh` | `https://koryphaios.com/install` | macOS and Linux: `curl -fsSL https://koryphaios.com/install \| sh` |
| `install.ps1` | `https://koryphaios.com/install.ps1` | Windows x64 PowerShell |
| `dmg-readme.txt` | Copied into every macOS DMG as "If macOS says the app can't be opened.txt" by `scripts/assemble-macos-bundle.sh` and the universal DMG step in `.github/workflows/release-desktop.yml` | Browser downloads |

## Deploying changes

The website is **not** built from this repository. After changing `install.sh`
or `install.ps1`, the owner must copy the file to the site and confirm it:

1. Copy `scripts/install/install.sh` to the site's `/install` route (served as `text/plain` or `application/x-sh`, no redirects in front of it).
2. Copy `scripts/install/install.ps1` to `/install.ps1`.
3. Verify: `curl -fsSL https://koryphaios.com/install | diff - scripts/install/install.sh` prints nothing, and the same for `install.ps1`.

Until step 1 is done, users keep getting the previous script. Nothing in CI
deploys these files.

## Tests

`bun test scripts/install/install.test.ts` runs without network access or
special privileges:

- `sh -n` and `bash -n` on `install.sh`, and `shellcheck -s sh` when it is installed.
- The macOS flow with stub `uname`, `curl`, `hdiutil`, `ditto`, `xattr`, `open`
  and `osascript` on `PATH`, in a temp directory. It asserts the exact call
  sequence and that quarantine is removed only from the installed app.
- The Linux flow, including the desktop launcher entry.

`install.ps1` has no automated test yet (no `pwsh` on the authoring host).

## Environment overrides

Used by the tests and for debugging; normal installs set none of them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KORYPHAIOS_DOWNLOAD_BASE` | `https://koryphaios.com/api/download` | Release download root |
| `KORYPHAIOS_APPLICATIONS_DIR` | `/Applications` | Where the macOS app is installed first |
| `KORYPHAIOS_INSTALL_TTY` | `/dev/tty` | Where consent questions are asked |
| `KORYPHAIOS_INSTALL_ASSUME_YES` | unset | `1` accepts the "quit the running app" prompt |

## Checksums

If a release publishes `<effective-download-url>.sha256` (a standard
`sha256sum` line, or the bare hex digest), both installers verify the download
against it. A missing sidecar only prints a note. A readable checksum that does
not match stops the install before anything is copied.

The release workflow does not publish these sidecars yet; adding them is what
turns verification on.

## macOS behavior

1. Downloads the DMG for the current CPU into a temp directory (never `~/Downloads`).
2. Attaches it read-only with `hdiutil attach -nobrowse -readonly`.
3. If Koryphaios is running, asks for consent, then quits it with
   `tell application id "com.sylorlabs.koryphaios" to quit` and waits up to 30 s.
4. Copies the app with `ditto` to a staging name, then swaps it into place.
   `/Applications` is used when writable. Otherwise the script asks before using
   `sudo`, and falls back to `~/Applications` if you decline. It never uses sudo silently.
5. Detaches the image, runs `xattr -dr com.apple.quarantine` on the installed app only, and opens it.

Any failure exits non-zero with a `Koryphaios install failed:` message, and a
trap detaches the image and removes the temp directory.

## Browser downloads

Apple's Gatekeeper cannot be bypassed without notarization. The DMG therefore
carries `dmg-readme.txt`, which gives the System Settings → Privacy & Security →
Open Anyway steps and the one-line installer. The file sits beside the `.app`,
never inside it, so `codesign --verify --strict` is unaffected.
