# Koryphaios Update System

This document describes how the Koryphaios update system works.

## Overview

Koryphaios uses a multi-channel update system:

1. **Automatic Updates** - Checks every 2 hours + on launch
2. **Manual Updates** - User-triggered via "Check for Updates" button
3. **Package Managers** - Homebrew (macOS/Linux) and Winget (Windows)

## How It Works

### Codeword Protection

To prevent accidental releases, updates require a **codeword** in the changelog:

```typescript
// In koryphaios.com/src/app/changelog/page.tsx AND /api/update/route.ts
{
  version: "0.2.0",
  date: "2026-03-09",
  codeword: "PUBLISH",  // ← Must be "PUBLISH" to trigger updates
  publish: true,        // ← Must be true
  changes: [...]
}
```

**Only versions with `codeword: "PUBLISH"` and `publish: true` will be distributed.**

This means:
- ✅ You can commit code changes without triggering updates
- ✅ You control when updates go live
- ✅ Tiny fixes won't auto-deploy unless you add the codeword

### Update Check Frequency

- **On launch**: 5 seconds after app starts
- **Periodic**: Every 2 hours while app is running
- **Manual**: Any time via View → Check for Updates

### Update Flow

1. App checks `https://koryphaios.com/api/update`
2. Server returns latest version with codeword verification
3. If update available and codeword is "PUBLISH", show dialog
4. User can:
   - **Install Update** - Download and restart
   - **View Changelog** - Open browser to koryphaios.com/changelog
   - **Remind Me Later** - Dismiss dialog (checks again in 2 hours)

## Release Process

### 1. Prepare the Release

```bash
# Update version numbers
# - package.json: "version": "0.2.0"
# - desktop/src-tauri/tauri.conf.json: "version": "0.2.0"
# - desktop/src-tauri/Cargo.toml: version = "0.2.0"
# - desktop/package.json: "version": "0.2.0"
```

### 2. Update Changelog

Edit both files:
- `koryphaios.com/src/app/changelog/page.tsx`
- `koryphaios.com/src/app/api/update/route.ts`

Add new entry with `codeword: "PUBLISH"` and `publish: true`:

```typescript
{
  version: "0.2.1",
  date: "2026-03-10",
  codeword: "PUBLISH",
  publish: true,
  changes: [
    { type: "fix", description: "Fixed critical bug" },
  ],
}
```

### 3. Build and Release

```bash
# Build desktop app
bun run build:desktop

# Create GitHub release with binaries
# - Koryphaios_0.2.1_aarch64.dmg (macOS Apple Silicon)
# - Koryphaios_0.2.1_x64.dmg (macOS Intel)
# - koryphaios_0.2.1_amd64.AppImage (Linux)
# - Koryphaios_0.2.1_x64-setup.exe (Windows)
```

### 4. Update Package Managers

#### Homebrew

Update SHA256 hashes in `homebrew/koryphaios.rb`:

```bash
# Get SHA256 for each binary
shasum -a 256 Koryphaios_0.2.1_aarch64.dmg
shasum -a 256 Koryphaios_0.2.1_x64.dmg
shasum -a 256 koryphaios_0.2.1_amd64.AppImage
```

Update the formula and push to tap repository.

#### Winget

Update `/winget/sylorlabs.koryphaios/sylorlabs.koryphaios.yaml`:
- Update `PackageVersion`
- Update `InstallerUrl`
- Update `InstallerSha256`
- Update `ReleaseNotes`
- Update `ReleaseDate`

Submit PR to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).

## Skipping Updates

To commit changes WITHOUT triggering an update:

1. Add changelog entry with `codeword: "DRAFT"` or any value except "PUBLISH"
2. Or set `publish: false`

```typescript
{
  version: "0.2.1",
  date: "2026-03-10",
  codeword: "DRAFT",    // ← Won't trigger updates
  publish: false,       // ← Won't trigger updates
  changes: [...]
}
```

When ready to release, change to `codeword: "PUBLISH"` and `publish: true`.

## Security

- Updates are signed with Ed25519 signatures
- Tauri verifies signatures before installing
- HTTPS only for all update endpoints
- No user data or telemetry collected during update checks

## Troubleshooting

### Updates Not Showing

1. Check codeword is "PUBLISH"
2. Check publish is true
3. Verify version is newer than current
4. Check browser console for errors

### Manual Check

Users can always check manually:
- **Menu**: View → Check for Updates
- **Keyboard**: (Add shortcut if desired)

### Force Update Check

To force an update check in development:

```typescript
import { updater } from "$lib/stores/updater.svelte";

// In browser console
updater.checkForUpdates();
```

## Files Involved

| File | Purpose |
|------|---------|
| `koryphaios.com/src/app/changelog/page.tsx` | Changelog webpage |
| `koryphaios.com/src/app/api/update/route.ts` | Update API endpoint |
| `frontend/src/lib/stores/updater.svelte.ts` | Frontend update logic |
| `frontend/src/lib/components/UpdateDialog.svelte` | Update notification UI |
| `frontend/src/lib/components/CheckForUpdatesButton.svelte` | Manual check button |
| `desktop/src-tauri/tauri.conf.json` | Tauri updater config |
| `desktop/src-tauri/src/lib.rs` | Rust update commands |
| `homebrew/koryphaios.rb` | Homebrew formula |
| `/winget/sylorlabs.koryphaios/*.yaml` | Winget manifest |
