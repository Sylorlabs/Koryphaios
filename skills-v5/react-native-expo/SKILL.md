---
name: react-native-expo
description: Engineer React Native and Expo applications across JavaScript, native modules, navigation, lifecycle, offline, and platform behavior. Use when the request specifically requires react native, expo app, expo router, native module expo; prefer a narrower child only when its boundary is established.
---

# React Native Expo

## Boundary

Confirm Expo SDK, routing model, supported platforms, native dependencies, development-client requirements, and EAS runtime compatibility before changing an Expo or React Native application. Keep JavaScript state, native module lifecycle, permissions, app state, deep links, safe areas, keyboard behavior, and over-the-air update compatibility explicit.

## Hierarchy and routing

- Broader skills: native-interface.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill for React Native and Expo application behavior. Compose platform-native skills when the task crosses into custom Swift, Objective-C, Kotlin, or Java code. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Determine whether the change is JavaScript-only or changes native code, native configuration, permissions, or bundled libraries. A native change requires a matching native build or development client.
- Treat Expo Go as a fixed native runtime with a limited library set. Do not use it as proof for a custom native module or production native configuration.
- Keep EAS Update `runtimeVersion` aligned with native compatibility. A build must not receive an update whose JavaScript expects incompatible native code.
- Preserve platform-specific behavior when iOS and Android contracts differ. Do not hide meaningful differences behind a shared abstraction that cannot express them.
- Resolve deep-link and Expo Router identity against the actual route tree before changing navigation state or URL handling.

## Failure discriminators

- If JavaScript works in Expo Go but a development build fails, inspect native dependency installation, config plugins, rebuild state, and platform permissions before rewriting JS logic.
- If an OTA update fails only on older installed builds, compare `runtimeVersion` and native dependency changes before changing update code.
- If behavior differs by platform, separate React state from native lifecycle, permission, keyboard, safe-area, and OS API behavior.
- If a deep link works on warm launch but not cold launch, inspect route readiness and initial URL handling rather than only navigation actions.

## Verification at the React Native boundary

- Use a development or production-like build whenever the changed path depends on native libraries or configuration.
- Exercise cold start, background and foreground, deep link, offline state, and permission denial when relevant to the feature.
- Verify both iOS and Android when the shared code path claims cross-platform behavior.
- For OTA changes, verify the intended update is accepted by compatible runtimes and excluded from incompatible native builds.
- Distinguish Expo Go, development-build, simulator or emulator, and physical-device evidence in the result.

## Completion evidence

- Expo SDK, native-runtime, and platform assumptions affected
- Development or production-build evidence for native-dependent paths
- OTA runtime-compatibility and cross-platform evidence when those contracts changed

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
