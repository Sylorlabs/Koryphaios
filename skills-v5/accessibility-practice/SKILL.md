---
name: accessibility-practice
description: Design equitable access across perception, operation, comprehension, environment, and assistive technology. Use when a task requires accessibility, assistive technology, alternative input, screen-reader support, reduced motion, or inclusive interaction design.
---

# Accessibility practice

Start from the actual medium and the critical tasks people must complete. Identify applicable standards/policy, platform accessibility services, input/output modes, environment, content/state, and the sensory, motor, cognitive, speech/language, temporary, and situational constraints that could change successful use. Do not assume browser mechanics apply to native, terminal, game/spatial, embedded, API, or physical-control surfaces.

Do not make critical meaning or operation depend on one sense, color, spatial position, sound, fine-motor gesture, memory burden, strict timing, or motion alone when a practical equivalent is required. Prefer native semantics, controls, focus/selection behavior, scaling, narration/screen-reader APIs, alternative-input paths, captions/descriptions, and system accessibility preferences before recreating them with custom behavior.

Design for equivalent task completion, not cosmetic feature parity. An alternative path must preserve the important result, information, safety boundary, and recovery behavior. Include cognitive and environmental access: clarity, predictable state, time pressure, interruption, lighting/noise, viewing distance, constrained attention, and long sessions can be material accessibility conditions.

For games and other non-browser interactive media, map each critical gameplay or navigation task to its medium-specific input, perception, communication, and recovery alternatives. Name how controller remapping, captions or narration, redundant cues, camera or motion settings, menu/HUD readability, and co-operative communication preserve the gameplay objective; do not reduce the design to a generic web checklist.

Define a verification matrix before claiming success: platform/device, input method, assistive technology or accessibility feature, representative content/state, critical task, expected behavior, and observable evidence. Automated scanners are useful for repeatable defects but cannot prove equitable task completion. Route execution and conformance evidence to `accessibility-verification`; when representative hardware or assistive technology is unavailable, state the evidence gap explicitly.

[Sources](references/sources.md).
