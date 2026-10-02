# Source map

`native-interface` owns platform-native application behavior after the native medium is confirmed. iOS/SwiftUI, Android/Compose, React Native/Expo, and desktop Electron/Tauri implementation details remain with their narrower children when the stack is known.

## Maintained interpretation

- Establish the actual platform and toolkit before choosing patterns. Native desktop and mobile share OS-level lifecycle, accessibility, input, and presentation constraints, but they must not be flattened into one screen model.
- Prefer platform conventions and existing application primitives because familiarity reduces interaction cost and improves interoperability with system features. Divergence should solve a demonstrated product or task problem.
- Desktop work must account for window resizing, multi-window/document behavior where applicable, menus and commands, shortcuts, keyboard and precision-pointer workflows, active/inactive focus state, display scaling, long sessions, and restoration after relaunch.
- Mobile work must account for touch target ergonomics, virtual keyboards, safe areas, permission flows, background/foreground transitions, interruptions, deep-link or navigation restoration, constrained attention, and changing available window space on modern multi-window/foldable environments.
- Do not infer device behavior from a fixed physical form factor. Current Android adaptive guidance treats app-window size as dynamic and emphasizes testing across changing window configurations; the same broader principle applies to resizable native surfaces where supported.
- Accessibility uses the platform's actual accessibility services and semantics. Keep labels, roles/traits, state, focus traversal, announcements, alternate input, text scaling, contrast/legibility, and motion preferences aligned to the target platform rather than importing web-only mechanics.
- Critical state must survive lifecycle changes proportionally to user expectations and data risk. Distinguish ephemeral presentation state, resumable task state, durable domain state, and sensitive state that must not be persisted casually.
- Verify on the real runtime or a faithful simulator/emulator with representative inputs and lifecycle transitions. Static screenshots do not prove commands, accessibility semantics, restoration, keyboard behavior, touch interaction, or window-management correctness.

## Verification record

- Apple Human Interface Guidelines: inspected 2026-09-04; recheck within 90 days.
- Android Adaptive Apps guidance: inspected 2026-09-04; recheck within 90 days.
- Android pointer/touch input guidance: inspected 2026-09-04; recheck within 90 days.
- Apple accessibility guidance is treated as platform-specific supporting evidence and should be refreshed alongside the HIG before qualification.
