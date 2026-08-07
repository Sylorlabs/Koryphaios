# Changelog

All notable Koryphaios changes are recorded here. Release automation prepends a versioned entry when an `/update` commit creates a release.

## Unreleased

## [0.2.0] - 2026-08-06

### ✨ Features

- **Unified model catalog**: per-provider model catalogs are consolidated into a single `models/index` registry, eliminating duplicated model definitions and making new provider onboarding a catalog-entry instead of a multi-file change.
- **Provider-reported reasoning picker**: the reasoning-effort picker now appears only when a provider explicitly reports reasoning capability, removing all hardcoded per-provider reasoning assumptions.
- **Browser-auth strategy registry**: browser-based OAuth/device-code/CLI-login flows (Copilot, Codex, KimiCode, Claude, Grok, Antigravity) are now self-contained `BrowserAuthStrategy` objects registered in a map, replacing two central `switch` blocks. Adding a browser-auth provider is one strategy + one map entry.
- **Account selection**: discovered CLI accounts can be selectively enabled or reordered via a saved fallback order, giving users control over which accounts supply models and run requests.
- **CLI research boundary**: native research answers are now validated for inspectable source URLs before being accepted, with a clear eligibility/reason contract.
- **Freebuff provider**: a new provider integration has been added to the provider registry.
- **Process completion coordinator**: a new coordinator service manages process lifecycle completion events, ensuring clean handoffs between worker pipelines and the orchestrator.
- **Conversation history module**: a dedicated conversation-history service persists and retrieves multi-turn context across sessions.
- **Metrics middleware**: an Elysia metrics plugin wraps every request with timing and status recording, feeding the `/metrics` endpoint. The prior unused `httpMetricsMiddleware` stub has been replaced.
- **Global error-handling middleware**: a single chokepoint normalizes all unhandled API errors — structured response bodies, taxonomy-driven status codes, and correlation-ID logging. Route handlers no longer need ad-hoc try/catch formatting.
- **Appearance settings**: a new frontend settings panel for theme and appearance preferences.
- **Context-window utility**: a frontend utility for tracking and displaying context-window usage.
- **Structured logging utility**: a new frontend `log.ts` module for consistent client-side logging.
- **Agent skills**: six new bundled skills — `imagegen`, `openai-docs`, `plugin-creator`, `review-agent`, `skill-creator`, and `skill-installer`.
- **Architecture Decision Records**: seven ADRs added under `docs/adr/` covering pino destination mode, terminal event delivery guarantees, process-supervisor restart backoff, bootstrap graceful degradation, session-store optimistic locking, embeddings explicit stub, and KMS env-based selection.

### 🚀 Improvements

- **AppImage CI runtime independence**: Linux AppImage builds no longer depend on the build-host runtime, improving portability across distributions.
- **Cross-platform artifact validation**: release artifacts are validated per-platform before publishing, preventing silent partial shipments.
- **Serialized release publishing**: verified release publishing is serialized to avoid race conditions between artifact upload and updater-metadata generation.
- **Permission enforcement**: saved permissions are enforced across all internal tool paths; CLI bridge approvals are authenticated; permission presets propagate to CLI sandboxes.
- **Feedback delivery**: error handling in the feedback delivery pipeline has been hardened.
- **macOS startup**: fixed a startup window issue and public feedback delivery on macOS.
- **mcp-server type safety**: fixed 18 TypeScript errors across detectors, monitoring, and validation modules — base detector now provides a shared logger, Zod v4 API usage corrected, chokidar v3 option compatibility fixed.

### 🐛 Fixes

- Removed eager model validation that broke startup after the model catalog consolidation.
- Removed obsolete Gemini provider alias.
- Fixed feedback delivery error handling.
- Fixed macOS startup window and public feedback path.
- Fixed AppImage extraction validation and cross-platform install release paths.
- Enforced saved permissions across internal tool paths and CLI bridge approvals.

### 📦 Version alignment

- All package manifests, Tauri config, Cargo.toml, and app config are aligned at **0.2.0**.
- Obsolete 1.0.x version tags and build artifacts have been removed.

### Known platform notes

- Windows code signing and Apple Developer ID notarization are not included in 0.2.0. Windows may show SmartScreen reputation warnings, and macOS uses ad-hoc signing with a one-time user approval path.
- Linux x64 is supported. ARM Linux is not published in this release.

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
