---
name: game-spatial-interface
description: Design game, simulation, immersive, and spatial interfaces around attention, embodiment, controllers, world context, and performance. Use when the request specifically requires game ui, game hud, spatial interface, vr interface.
---

# Game Spatial Interface

## Responsibility

Treat game and spatial interfaces as situated experiences rather than flat application screens. Identify play or operational goals, camera and world relationship, attention budget, input devices, distance and scale, locomotion, handedness, latency and frame budget, interruption, multiplayer or spectator context, and accessibility options before choosing presentation.

Decide what belongs in the world, on objects, near the player, in a HUD, in menus, or outside active play. Preserve situational awareness, avoid unnecessary modality, communicate state through redundant channels, and ensure critical information survives motion, visual complexity, audio loss, color-vision differences, and alternate controls. Design onboarding through safe progressive practice instead of instruction dumps.

For game and spatial anti-slop, reject HUD clutter, cosmetic chrome, faux dashboards, and motion that competes with play or operation. Every persistent element must earn attention, screen/world space, and frame budget; every diegetic treatment must preserve legibility and accessibility. Verify with the actual engine/runtime and representative controls. Test camera extremes, aspect ratios or fields of view, rapid state changes, pause/resume, controller disconnect, remapping, subtitles, motion reduction, comfort settings, performance under load, and transitions between play and menus. Do not import website navigation, hover, or document-layout assumptions.

## Hierarchy and routing

- Broader skills: visual-interface-design, frontend-engineering.
- Narrower children: three-d-graphics.
- Cross-cutting facets: interaction-design, accessibility-practice.

## Professional practice

### Operating contract

Design situated game, simulation, immersive, or spatial interaction under attention and performance constraints.

### Execution sequence

1. Establish play/operation goals, camera/world context, devices, distance, comfort, and frame budget.
2. Allocate information among world, objects, player-relative layers, HUD, menus, and external surfaces.
3. Design redundant feedback, safe onboarding, pause/interruption, remapping, and accessibility.
4. Implement elements only when they earn attention and runtime cost.
5. Verify representative controls, camera extremes, rapid states, performance, comfort, and transitions.

### Decisions that must be explicit

- Diegetic, spatial, HUD, menu, or out-of-experience placement.
- Persistent versus contextual visibility.
- Which channels redundantly communicate critical state.
- How comfort, accessibility, and competitive integrity constrain behavior.

### Failure and recovery discipline

- HUD chrome competes with primary action.
- Diegetic novelty destroys legibility.
- Controller disconnect or remap makes recovery impossible.
- Ideal camera and quiet scene hide failures.

### Evidence required before completion

- Situated interaction and attention contract.
- Engine/device runtime captures and traces.
- Control, comfort, subtitle, remapping, and pause results.
- Frame-time and transition evidence.

### Anti-misinterpretation boundaries

- Do not import website navigation.
- Do not rely on one sensory channel.
- Do not spend frame budget on ornamental motion.
- Do not claim device comfort without representative testing.

## Completion evidence

- Situated interaction contract
- Engine/device runtime verification

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
