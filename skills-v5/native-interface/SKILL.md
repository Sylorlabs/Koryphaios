---
name: native-interface
description: Design and implement native desktop or mobile interfaces using confirmed platform and toolkit conventions. Use when the target is a native app, desktop app, mobile app, iOS interface, Android interface, or another OS-level application surface rather than a browser or terminal UI.
---

# Native interface

Confirm the native platform, toolkit, supported OS versions, window or scene model, lifecycle, input methods, accessibility APIs, localization, scaling, and existing application components before editing. Preserve platform conventions unless a concrete user benefit justifies divergence.

For native visual anti-slop, start from the platform's information density, commands, display behavior, and user tasks rather than web-page composition. On desktop, cover windows, menus, shortcuts, keyboard-first operation, precision input, focus across active/inactive states, scaling, long sessions, and multi-window behavior where relevant. On mobile, cover touch, safe areas, virtual keyboards, rotation or window changes where supported, permissions, interruptions, navigation restoration, and constrained attention.

Keep lifecycle and interaction state explicit. Verify loading, empty, partial, disabled, destructive, success, failure, cancellation, background/foreground transitions, restoration, resize or display changes, and supported alternate inputs in the real runtime or a faithful platform simulator. Do not substitute browser screenshots for native verification.

Give every lifecycle state its own truthful status text. A cancelled job must not
still read as running, a disabled surface must not report progress it is not
making, and a restored job must not be indistinguishable from a fresh success,
because the status line is the user's only evidence of what the job is doing. Two
states that share a sentence are one state to the reader. Measured example: a
desktop operations window whose cancelled state printed "Running: cancellation
requested", whose disabled state printed the running text, and whose recovered
state printed "Job complete" left the user unable to tell a stopped job from a
live one, even though the cancel button was correctly disabled.

When the evaluator supplies an immutable shell and the deliverable is one model
file, read that boundary as part of the platform contract. Editing the shell to
make the window fit, or adding the missing element there, moves work outside the
part that gets measured.

Scope native evidence to the inspected application, platform, toolkit, and
states. AppKit/WindowServer accessibility observations and compositor captures
can establish evidence for the inspected macOS app and state when their source
and hashes are recorded; they do not by themselves establish Electron/Tauri
behavior, another native toolkit, device behavior, or full task qualification.

[Sources](references/sources.md).
