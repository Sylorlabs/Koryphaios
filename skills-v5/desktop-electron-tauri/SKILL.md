---
name: desktop-electron-tauri
description: Engineer Electron and Tauri desktop applications with process boundaries, IPC, filesystem authority, updates, packaging, and native behavior. Use when the request specifically requires electron app, tauri app, desktop webview, electron ipc; prefer a narrower child only when its boundary is established.
---

# Desktop Electron Tauri

## Boundary

Trace renderer or webview code, privileged host code, IPC or commands, filesystem authority, deep links, windows, tray behavior, updates, signing, and packaging as separate trust and lifecycle boundaries. Electron and Tauri have different privilege models, so establish which runtime is active before applying security guidance.

## Hierarchy and routing

- Broader skills: native-interface.
- No narrower bundled child is declared.
- Cross-cutting facets: application-security.
- Required skills: verification.

Compose `application-security` when the change affects privileged IPC, command exposure, navigation, remote content, filesystem or shell authority, update trust, or capability scope. A purely visual window change does not by itself require expanding security scope. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- In Electron, keep context isolation and a narrow preload bridge. Do not expose raw `ipcRenderer` or generic shell and filesystem primitives to renderer code. Validate IPC sender and arguments at the privileged handler.
- Register process-wide IPC handlers at process scope, with per-window ownership tied to the live `webContents` and its frame lifecycle. Handle renderer reload, window destruction, and simultaneous windows without stale owners, duplicate listeners, or duplicate writes; validate the sender at the time of each request and avoid losing valid requests during a navigation transition.
- In Tauri v2, grant only the command and resource capability needed by the target window or webview. Treat allow and deny scopes as the enforcement boundary rather than copying Electron preload patterns.
- Treat deep links, file open events, update URLs, and navigation targets as external input before they reach privileged operations.
- Preserve the repository's packaging, signing, and update model unless the task explicitly changes distribution.

## Failure discriminators

- If behavior works in dev but not after packaging, inspect resource paths, permissions or entitlements, signing, sandboxing, and packaged configuration before changing application logic.
- If an IPC call fails only from one window, distinguish handler logic from sender validation, preload exposure, or Tauri capability scope.
- If a window does not restore or quit correctly, trace ownership across all windows, tray state, app lifecycle events, and persisted bounds.
- If a native file or URL action behaves differently by OS, verify platform path and protocol handling instead of normalizing away the difference.

## Verification at the desktop boundary

- Exercise the packaged artifact on every supported OS affected by the change, not only browser dev mode.
- For privileged calls, verify one allowed request and the denied or malformed request with the highest risk from the actual renderer or webview boundary.
- Cover cold start, second-window or deep-link activation where applicable, close versus quit behavior, and state restoration.
- For window-owned IPC, verify one action after reload and independent actions from concurrent windows, then prove each produces one authorized effect and no stale listener persists after closure.
- If updates change, test download, verification, restart, and recovery behavior using the configured update channel or a faithful test channel.
- Record which security model was exercised: Electron process isolation or Tauri capabilities.

## Completion evidence

- Runtime and privilege boundary affected: Electron or Tauri
- Packaged lifecycle evidence from the supported OS boundary
- Allowed and denied privileged-call evidence when IPC, commands, or capabilities changed

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
