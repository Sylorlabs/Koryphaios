# Changelog

All notable Koryphaios changes are recorded here. Release automation prepends a versioned entry when an `/update` commit creates a release.

## Unreleased

## [1.0.23] - 2026-07-10

### ✨ Features
- embed backend and harden release validation
- sub-agent worker cards fly in from the top of the rail on spawn
- looping scripted playback + guard dead-ends (notes, send)
- demo mode for the marketing site's live embed

### 🐛 Bug Fixes
- bake RELAY_URL into the release build too
- make model-sharing work for a Windows client + all-platform build
- declare Bun test types
- declare runtime auth and telemetry dependencies
- isolate supported gates on clean runners
- download appimagetool if not cached on CI runner
- reorder AppImage repair before verify step
- repair AppImage sidecar after linuxdeploy corrupts bun binary
- remove conflicting libappindicator3-dev on Ubuntu 24.04
- repair self-update download, progress, restart, and button UI

### 🚀 Improvements
- style(tests): format isolated provider fixtures
- test(grok): accept live CLI model catalogs
- test(credentials): isolate user and audit fixtures
- test(auth): isolate API key database fixtures

## [1.0.22] - 2026-07-08

### Added

- Native in-app feedback reporting with anonymous-by-default delivery, optional reply email, basic diagnostic consent, and Koryphaios-styled client and email presentation.
- Blacksmith-backed CI and desktop build coverage on the repository's real `master` development branch.
- A client-seeded website demo with a realistic sample workspace, model choices, controlled limitations, and a full-screen handoff to the native app.
- Playwright coverage for desktop, mobile, keyboard, demo-isolation, and feedback-endpoint boundaries.

### Fixed

- Desktop packaging now embeds the compiled backend payload directly in the main executable for Windows, macOS Intel, macOS Apple Silicon, Linux x64, and universal macOS builds; there is no Tauri external sidecar to ship or repair.
- Removed the known-broken Linux ARM cross-build until its WebKit/sysroot and Bun payload toolchain can be supported end to end.
- The desktop materializes its internal backend privately, verifies health against the spawned PID, restarts it if unhealthy, and serves the frontend and API from one origin.
- Managers animate into the agent rail from the left while every spawned non-manager agent appears from the top.
- Release automation now builds from the committed version bump and rejects package, Cargo, Tauri, and release-tag version drift.
- The website release-dispatch workflow can push its rebuild marker instead of failing with a read-only token.

### Verified

- Team workspaces remain separate from personal sessions and retain host-defined access-policy enforcement at the relay and tool layers.
- The embedded demo performs no backend requests during its guided interactions and does not expose destructive, collaboration, notes, or feedback dead ends.

