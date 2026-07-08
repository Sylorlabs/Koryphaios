# Changelog

All notable Koryphaios changes are recorded here. Release automation prepends a versioned entry when an `/update` commit creates a release.

## Unreleased

### Added

- Native in-app feedback reporting with anonymous-by-default delivery, optional reply email, basic diagnostic consent, and Koryphaios-styled client and email presentation.
- Blacksmith-backed CI and desktop build coverage on the repository's real `master` development branch.
- A client-seeded website demo with a realistic sample workspace, model choices, controlled limitations, and a full-screen handoff to the native app.
- Playwright coverage for desktop, mobile, keyboard, demo-isolation, and feedback-endpoint boundaries.

### Fixed

- Desktop packaging now compiles the backend sidecar for Windows, macOS Intel, macOS Apple Silicon, Linux x64, and universal macOS builds before Tauri bundles the frontend.
- Removed the known-broken Linux ARM cross-build until its WebKit/sysroot and Bun sidecar toolchain can be supported end to end.
- The desktop now fails closed when its bundled backend is absent, verifies health against the spawned PID, restarts unhealthy sidecars, and serves the frontend and API from one origin.
- Managers animate into the agent rail from the left while every spawned non-manager agent appears from the top.
- Release automation now builds from the committed version bump and rejects package, Cargo, Tauri, and release-tag version drift.
- The website release-dispatch workflow can push its rebuild marker instead of failing with a read-only token.

### Verified

- Team workspaces remain separate from personal sessions and retain host-defined access-policy enforcement at the relay and tool layers.
- The embedded demo performs no backend requests during its guided interactions and does not expose destructive, collaboration, notes, or feedback dead ends.
