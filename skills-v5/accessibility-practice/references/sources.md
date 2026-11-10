# Source map

Accessibility practice is a design and requirements discipline for equitable task completion. It starts from the real medium and platform rather than assuming a browser, and it separates an accessibility requirement from the evidence needed to prove that requirement in a particular environment.

## Maintained interpretation

- Identify the critical tasks, actual medium, applicable standards or policy, platform accessibility services, input/output modes, environments, and combinations of sensory, motor, cognitive, speech/language, temporary, and situational constraints that matter to the product.
- Do not make critical meaning or operation depend on one sense, color, spatial position, sound, fine motor gesture, memory load, strict timing, or motion alone when a practical equivalent is required.
- Prefer native semantics, controls, focus/selection models, text scaling, narration/screen reader APIs, switch/alternative input paths, captions/descriptions, and system accessibility preferences before recreating them in custom UI.
- Design for equivalent task completion, not superficial feature parity. An alternative path must preserve the important result, information, safety boundary, and recovery behavior.
- Treat asynchronous changes and custom semantics as task access problems: track focus and selection by logical item ID across recycled content; relocate and explain focus when an item is removed; expose names/relationships/states and actionable, timed update context. Preserve cancellation, undo, unsaved edit and interrupted operation recovery without claiming a remote save before acknowledgement.
- For game inputs, validate a complete remap before committing it, keep escape/reset reachable and recover from controller loss without a false online pause. Sound cues unrelated to dialogue need source, direction, urgency and an actionable response window, not just text saying a sound occurred. Limit the rate of routine HUD narration so important announcements survive, and provide usable without voice team communication during live play.
- Treat cognitive access and environmental access as essential: clarity, predictable state, time pressure, interruption, lighting, noise, viewing distance, long sessions, and constrained attention can materially change the usable experience.
- Define a verification matrix that names the actual platform, input, assistive technology, content/state, and task combinations that need exercise. Automated scanners are useful for repeatable defects but cannot prove equitable task completion on their own.
- Make every verification row reproducible: expected observation, method, execution status, recorded outcome, test identity/version, evidence artifact and residual risk. Record `planned`, `failed`, `blocked`, or `untested` when the input cannot justify `passed`; static analysis and simulated trees do not establish actual spoken output or real device performance.
- Route execution and evidence claims to `accessibility-verification`. If representative assistive technology or hardware is unavailable, state the gap rather than claiming conformance from static reasoning.

The package's [unexecuted regression oracles](../evals/regression-oracles.md) specify reproducible negative and recovery probes for the two full task fixtures. They are acceptance criteria for future independent execution, **not recorded outcomes**. The registered deterministic checks may cover fixed scope integrity and structured artifact records, but do not execute any real editor, game, assistive technology, or recovery test. A pass on these checks is not a behavioral verdict; promotion still requires legitimate paired results and independent blind review. The [failure case playbook](failure-mode-playbook.md) explains what an implementable requirement must say to detect these failures.

## Source boundaries

WCAG 2.2 is normative for web content and remains the canonical web baseline in this package. It does not make DOM, ARIA, browser reflow, or CSS mechanics universal requirements for native apps, terminal interfaces, games, spatial systems, embedded devices, APIs, or physical controls.

Apple HIG and Android accessibility documentation are authoritative for their respective platforms. When the platform matches, Kory uses their principles of platform accessibility services, meaningful semantics, alternative operation, cues that do not depend on color, scaling, and accessible media.

Microsoft's Xbox Accessibility Guidelines are specific to games guidance for good practice developed with industry experts and the Gaming & Disability Community. Microsoft explicitly does not present the XAGs as legal/compliance validation, so Kory uses them for game design/test coverage rather than universal compliance claims. In particular, [XAG 104](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/104) discusses captions for meaningful audio other than speech and sound direction; [XAG 105](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/105) separates narration volume from effects and recognizes live multiplayer pause limits; [XAG 107](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/107) covers remapping, digital input, and timing barriers beyond remapping alone.

The [WAI-ARIA Authoring Practices tree view pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) explains web tree focus versus selection and virtualized node positions. For a native Windows editor, [Microsoft UI Automation's ItemContainer pattern](https://learn.microsoft.com/en-us/windows/desktop/WinAuto/uiauto-implementingitemcontainer) and [VirtualizedItem guidance](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-workingwithvirtualizeditems) show why offscreen virtual items need a discovery/realization path; the actual UI toolkit may supply or mediate these patterns. For AppKit on macOS, [NSAccessibilityProtocol](https://developer.apple.com/documentation/appkit/nsaccessibilityprotocol) exposes distinct focus, selection, actions and notifications. Do not impose web attributes on native controls or claim a platform API is wired up without toolkit inspection.

Rampstack's MIT `accessibility-audit` package provides useful community workflow patterns around mixed automated/manual evidence and explicitly reporting tool/data gaps. It is currently anchored to WCAG 2.1 and specific to web numeric/test prescriptions, so those are not imported as Kory's current standard or across media defaults.

## Verification record

- WCAG 2.2 Recommendation: official W3C specification verified 2026-09-04; recheck within 180 days or after a new Recommendation.
- Apple HIG Accessibility: official Apple documentation verified 2026-09-04; recheck within 90 days.
- Android accessibility principles: official Android documentation verified 2026-09-04; recheck within 60 days because the documentation is actively being refactored around Compose.
- Xbox Accessibility Guidelines: Microsoft Learn guidance verified 2026-09-04; recheck within 60 days.
- Rampstack `accessibility-audit`: GitHub `main` at `e5bc67519991` inspected 2026-10-03; repository license is MIT. Recheck within 30 days.
- W3C WAI APG tree view, Microsoft UI Automation ItemContainer/VirtualizedItem, Apple AppKit NSAccessibilityProtocol, and Microsoft XAG 104/105/107 official guidance examined 2026-10-10 for these particular failure modes; conditional on the implemented platform/toolkit and subject to actual runtime verification.
