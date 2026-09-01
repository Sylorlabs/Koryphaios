# Changelog

All notable Koryphaios changes are recorded here. Release automation prepends a versioned entry when an `/update` commit creates a release.

## Unreleased

### ✨ Features

- **Multi-provider image studio**: image generation now works across OpenAI (GPT Image 2/1.5/1/1-mini, DALL·E 3), xAI Grok, Google Gemini & AI Studio (Gemini 2.5 Flash Image, Imagen 4), OpenRouter, and Local / LM Studio / llama.cpp OpenAI-compatible endpoints, with per-model canvas, quality, format, and background options plus custom model IDs.
- **Image editing**: GPT Image and Gemini 2.5 Flash Image models accept a source image for edit-style generation through the new `/api/images/edit` route.
- **Image history**: generated and edited images persist under the data dir with a gallery that can re-open, copy prompts, and delete entries.
- **API usage ledger**: every billable image/voice call is recorded with an estimated cost and surfaced via `GET /api/usage`.
- **Multi-provider voice**: speech synthesis dispatches to the selected provider — OpenAI TTS, Groq PlayAI TTS, Deepgram Aura, and local/custom OpenAI-compatible endpoints — with per-provider voice lists and speech models discovered from connected providers.
- **Voice model discovery**: transcription and speech model dropdowns merge models discovered from authenticated providers, so local endpoints and newly released audio models appear without app changes.

### 🐛 Fixes

- Image effect presets apply again — a refactor had silently stopped sending the effect field to the backend.
- Voice settings no longer advertise downloadable model packs that nothing consumed; local speech models are supported through OpenAI-compatible endpoints, and the unused `liveTranscription` stub flag was removed.

## [0.2.0] - 2026-08-22

### ✨ Features

- **Freebuff provider**: a new provider integration has been added to the provider registry.
- **Account selection**: discovered CLI accounts can be selectively enabled or reordered via a saved fallback order, giving users control over which accounts supply models and run requests.
- **CLI research boundary**: native research answers are now validated for inspectable source URLs before being accepted, with a clear eligibility/reason contract.
- **Conversation history service**: a dedicated conversation-history service persists and retrieves multi-turn context across sessions.
- **Metrics endpoint**: an Elysia metrics plugin wraps every request with timing and status recording, feeding the `/metrics` endpoint.
- **Appearance settings**: a new frontend settings panel for theme and appearance preferences.
- **Context-window tracker**: a frontend utility for tracking and displaying context-window usage.
- **Agent skills**: six new bundled skills — `imagegen`, `openai-docs`, `plugin-creator`, `review-agent`, `skill-creator`, and `skill-installer`.
- **MCP v2 protocol**: both stdio servers use `@modelcontextprotocol/server` v2 with the 2026-07-28 protocol and legacy negotiation fallback.
- **Image studio**: OpenAI image generation includes canvas, quality, format, transparency, visual-effect presets, animated previews, and downloads.
- **Voice workflows**: composer microphone recording, OpenAI transcription and speech synthesis, system voice playback, reply read-aloud controls, and verified Moonshine model downloads.

### 🐛 Fixes

- Removed eager model validation that broke startup after the model catalog consolidation.
- Removed obsolete Gemini provider alias.
- Fixed feedback delivery error handling.
- Fixed macOS startup window and public feedback path.
- Fixed AppImage extraction validation and cross-platform install release paths.
- Restored native macOS cut, copy, paste, select-all, undo, and redo behavior with predefined Edit menu actions.
- Replaced forced macOS startup fullscreen with a resizable maximized window and added cross-platform edge resize handles.
- Restored auth-token inputs for providers that advertise token authentication and expanded branded provider icon coverage.
- Enforced saved permissions across internal tool paths and CLI bridge approvals.

### 🚀 Improvements

- **Backend decoupled from Rust shell**: the backend now ships as a Tauri resource read from disk at runtime instead of being embedded in the Rust binary via `include_bytes!`. This eliminates the need for Windows/macOS Rust compilation on every release — most releases only swap the backend binary in the resources directory.
- **Windows installer assembled on Linux**: NSIS installers are produced via `makensis` on Linux, no Windows runner needed. macOS bundles are assembled from pre-built shells with codesign + DMG creation — no Rust compilation, just file assembly (~2 min vs 30+ min).
- **Pre-built shell caching**: the 1,800-line Tauri shell is compiled once per platform and cached as a CI artifact (90-day retention). It's only recompiled when `desktop/src-tauri/**` changes, not on every backend or frontend update.
- **Post-release smoke tests**: Windows and macOS runners download the published installers, install them silently, launch the app, and poll the backend `/api/health` endpoint to verify the full stack works. Non-blocking — reports failures as a separate check.
- **AppImage CI runtime independence**: Linux AppImage builds no longer depend on the build-host runtime, improving portability across distributions.
- **Cross-platform artifact validation**: release artifacts are validated per-platform before publishing, preventing silent partial shipments.
- **Serialized release publishing**: verified release publishing is serialized to avoid race conditions between artifact upload and updater-metadata generation.
- **Permission enforcement**: saved permissions are enforced across all internal tool paths; CLI bridge approvals are authenticated; permission presets propagate to CLI sandboxes.
- **mcp-server type safety**: fixed 18 TypeScript errors across detectors, monitoring, and validation modules — base detector now provides a shared logger, Zod v4 API usage corrected, chokidar v3 option compatibility fixed.
- **Model catalog consolidated**: per-provider model catalogs merged into a single `models/index` registry, simplifying new provider onboarding.
- **Reasoning picker now data-driven**: appears only when a provider explicitly reports reasoning capability, removing hardcoded per-provider assumptions.
- **Browser-auth flows extracted into strategy registry**: OAuth, device-code, and CLI-login flows are self-contained strategies instead of central switch blocks.
- **Process completion coordinator**: a new coordinator service manages process lifecycle completion events, ensuring clean handoffs between worker pipelines and the orchestrator.
- **Global error-handling middleware**: a single chokepoint normalizes all unhandled API errors — structured response bodies, taxonomy-driven status codes, and correlation-ID logging.
- **Architecture Decision Records**: seven ADRs added under `docs/adr/` covering pino destination mode, terminal event delivery guarantees, process-supervisor restart backoff, bootstrap graceful degradation, session-store optimistic locking, embeddings explicit stub, and KMS env-based selection.

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
