---
name: game-development
description: Engineer game systems around simulation, input, timing, state, content, save/load, networking, performance, tooling, and player experience. Use when the request specifically requires game development, gameplay system, game engine, game loop.
---

# Game Development

## Responsibility

Separate deterministic simulation, presentation, input mapping, physics, AI, animation, audio, content data, save state, online authority, and tooling. Define fixed/variable timestep behavior, pause/interruption, entity lifecycle, serialization/versioning, and frame budgets before adding mechanics.

Verification focus: Exercise low/high frame rates, pause/resume, controller/input changes, save/load/version migration, long sessions, scene transitions, network loss if relevant, and representative target hardware performance.

Failure boundaries: Do not tie simulation correctness to render frame rate, hide game rules in presentation scripts, serialize unstable runtime pointers, or optimize only an empty test scene.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification, performance-verification.

## Own state and time

Separate authoritative game state from its visual presentation. Define when input is sampled, when simulation advances, and which clock governs cooldowns, physics, animation, and network reconciliation. Choose fixed ticks, interpolation, or another supported scheme from the game's consistency and latency requirements; interpolation improves presentation but may add latency and does not repair incorrect simulation.

Give entities explicit creation, destruction, and ownership rules. Persist stable identities and versioned state rather than addresses or engine objects. Exercise save migration, interrupted writes, missing content, scene transitions, and resume behavior when those contracts exist.

For online play, identify the authority for each consequential state change and handle delayed, duplicate, rejected, and reordered inputs. Do not assume local physics ticks align with network snapshots or that a smooth animation proves agreement between peers.

Test low and high render rates against the same gameplay behavior, plus pause, focus loss, controller changes, long sessions, and representative load on target hardware. Measure frame cost, memory, responsiveness, and player facing failure or recovery. Preserve the existing engine and content workflow unless the task justifies changing them; this skill is not a mandate for a new entity system or a particular engine.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
