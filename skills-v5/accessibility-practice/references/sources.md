# Source map

Accessibility practice is a design and requirements discipline for equitable task completion. It starts from the real medium and platform rather than assuming a browser, and it separates an accessibility requirement from the evidence needed to prove that requirement in a particular environment.

## Maintained interpretation

- Identify the critical tasks, actual medium, applicable standards or policy, platform accessibility services, input/output modes, environments, and combinations of sensory, motor, cognitive, speech/language, temporary, and situational constraints that matter to the product.
- Do not make critical meaning or operation depend on one sense, color, spatial position, sound, fine-motor gesture, memory load, strict timing, or motion alone when a practical equivalent is required.
- Prefer native semantics, controls, focus/selection models, text scaling, narration/screen-reader APIs, switch/alternative-input paths, captions/descriptions, and system accessibility preferences before recreating them in custom UI.
- Design for equivalent task completion, not superficial feature parity. An alternative path must preserve the important result, information, safety boundary, and recovery behavior.
- Treat cognitive access and environmental access as first-class: clarity, predictable state, time pressure, interruption, lighting, noise, viewing distance, long sessions, and constrained attention can materially change the usable experience.
- Define a verification matrix that names the actual platform, input, assistive technology, content/state, and task combinations that need exercise. Automated scanners are useful for repeatable defects but cannot prove equitable task completion on their own.
- Route execution and evidence claims to `accessibility-verification`. If representative assistive technology or hardware is unavailable, state the gap rather than claiming conformance from static reasoning.

## Source boundaries

WCAG 2.2 is normative for web content and remains the canonical web baseline in this package. It does not make DOM, ARIA, browser reflow, or CSS mechanics universal requirements for native apps, terminal interfaces, games, spatial systems, embedded devices, APIs, or physical controls.

Apple HIG and Android accessibility documentation are authoritative for their respective platforms. When the platform matches, Kory uses their principles of platform accessibility services, meaningful semantics, alternative operation, cues that do not depend on color, scaling, and accessible media.

Microsoft's Xbox Accessibility Guidelines are game-specific best-practice guidance developed with industry experts and the Gaming & Disability Community. Microsoft explicitly does not present the XAGs as legal/compliance validation, so Kory uses them for game design/test coverage rather than universal compliance claims.

Rampstack's MIT `accessibility-audit` package provides useful community workflow patterns around mixed automated/manual evidence and explicitly reporting tool/data gaps. It is currently anchored to WCAG 2.1 and web-specific numeric/test prescriptions, so those are not imported as Kory's current standard or cross-medium defaults.

## Verification record

- WCAG 2.2 Recommendation: official W3C specification verified 2026-09-04; recheck within 180 days or after a new Recommendation.
- Apple HIG Accessibility: official Apple documentation verified 2026-09-04; recheck within 90 days.
- Android accessibility principles: official Android documentation verified 2026-09-04; recheck within 60 days because the documentation is actively being refactored around Compose.
- Xbox Accessibility Guidelines: Microsoft Learn guidance verified 2026-09-04; recheck within 60 days.
- Rampstack `accessibility-audit`: GitHub `main` inspected 2026-09-04; repository license is MIT. Recheck within 30 days.
