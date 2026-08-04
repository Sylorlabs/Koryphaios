# Changelog

All notable Koryphaios changes are recorded here. Release automation prepends a versioned entry when an `/update` commit creates a release.

## Unreleased

## [0.1.0] - 2026-08-04

### ✨ Features

- Koryphaios 0.1.0 is the first public native desktop release for Windows x64, macOS Intel, macOS Apple Silicon, and Linux x64.
- A local embedded backend, native Tauri shell, persistent sessions, project workspaces, notes, memory, and provider configuration are packaged together so the workspace can run without a hosted Koryphaios account.
- Multi-provider agent workflows, real-time reasoning and tool activity, project-scoped work, MCP support, and CLI bridges ship in the desktop application.
- The release includes the native updater and signed updater metadata, so later compatible releases can be discovered from inside the app.

### 🚀 Improvements — installation and platform experience

- Windows uses the normal setup executable and creates a Start-menu entry.
- macOS ships Intel and Apple Silicon DMGs; the curl installer copies Koryphaios into the user Applications folder, while a downloaded DMG installs by dragging the app into Applications.
- Linux ships Debian, RPM, and portable AppImage packages. The curl installer creates a desktop launcher, and an AppImage creates or refreshes its launcher when it runs.
- Packaged state is stored in each operating system’s per-user application-data directory rather than beside an installer, AppImage, or source checkout.

### 🐛 Fixes and hardening

- Restored a coherent desktop/backend startup contract, including dynamic local-port recovery when the default port is already occupied.
- Added embedded-backend supervision so a failed backend surfaces a recovery state instead of leaving a misleading live-looking window.
- Aligned desktop data placement so SQLite state, sessions, local credentials, memory, and keys stay in the app data directory.
- Added application-search integration for Linux installs and explicit completion status for the Windows installer.
- Added explicit macOS ad-hoc signing for browser-downloaded builds, preventing unsigned Apple Silicon bundles from being labelled damaged solely because they lack a code signature. macOS may still require a one-time Finder control-click → Open confirmation.
- Kept bundle and backend compatibility checks fail-closed so a stale frontend cannot silently attach to a newer backend.

### 🚀 Improvements — release quality

- The desktop build now requires Debian, RPM, and AppImage artifacts; Linux packaging cannot silently ship only one format.
- macOS CI verifies the generated app bundle with `codesign --verify --deep --strict` before publishing it.
- Version metadata is aligned at 0.1.0 across the native package, website release, and frontend configuration.
- Core type checking and frontend diagnostics pass for this release candidate.

### Known platform notes

- Windows code signing and Apple Developer ID notarization are not included in 0.1.0. Windows may show SmartScreen reputation warnings, and macOS uses ad-hoc signing with a one-time user approval path.
- Linux x64 is supported. ARM Linux is not published in this release.
