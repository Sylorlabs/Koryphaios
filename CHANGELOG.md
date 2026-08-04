# Changelog

All notable Koryphaios changes are recorded here. Release automation prepends a versioned entry when an `/update` commit creates a release.

## Unreleased

## [0.1.0] - 2026-08-04

### ✨ Features

- native CLI slash-command bridge + Devin capability probing

### 🐛 Bug Fixes

- validate workspace paths on Windows
- cross-platform test failures round 2
- cross-platform test failures on Windows and macOS
- start backend in playwright e2e config
- implement parseDevinModelsOutput for devin-capabilities test
- resolve remaining 4 CI test failures
- commit remaining in-progress feature changes for CI
- commit migration 0023/0024 and message-store changes for CI
- resolve CI test failures from in-progress feature work
- replace vitest import with bun:test in speech-text test
- resolve CI typecheck errors from in-progress feature work
- shorten bearer probe token to avoid CI secret scanner false positive
- cross-platform consistency for macOS and Windows
- all UI elements now adapt to selected accent color
- remove read-only heuristic that stripped agent write capabilities
- Tauri supervisor discovers backend's actual port after EADDRINUSE fallback
- dynamic port fallback prevents backend crashes on EADDRINUSE
- unknown slash commands fall through to model + notes sync dedup

### 🚀 Improvements

- ci: restore MCP dependencies and Windows test runner
- test: isolate browser release checks
- ci: publish exact signed updater releases
- recover billing and memory import overhaul
- index on master: 60655b5 fix: cross-platform test failures round 2
- Add contributor credits and product media
- ci: add cross-platform test matrix for Windows and macOS
- test: skip shortcuts e2e in CI (requires interactive session)
- Match composer model to selected agent
- Adapt Poe icon to app theme
- Add Poe API key provider setup
