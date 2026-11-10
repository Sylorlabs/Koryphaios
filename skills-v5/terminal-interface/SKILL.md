---
name: terminal-interface
description: Design terminal and command-line interfaces around text, keyboard operation, streams, automation, and terminal constraints. Use when the request specifically requires terminal, command line, cli, tui.
---

# Terminal Interface

## Responsibility

Treat terminal interfaces as a distinct medium. Identify whether the product is a composable CLI, an interactive TUI, or both. Preserve predictable arguments, stdin/stdout/stderr separation, exit codes, noninteractive automation, discoverable help, safe confirmation, interruption and cancellation, narrow and wide terminal layouts, color-disabled operation, and keyboard-only interaction.

For terminal anti-slop, make hierarchy legible in plain text before adding color, panels, symbols, or animation. Do not use decorative box drawing, spinners, colors, Unicode, or progress indicators when they reduce piping, scanning, accessibility, or degraded-terminal behavior. For TUIs, define focus, selection, navigation, resize behavior, scroll ownership, shortcuts, screen reader or plain-text fallback expectations, and recovery after terminal suspension. Never import browser layout or pointer-hover assumptions. Verify real terminal behavior, piping, redirection, errors, cancellation, resizing, and degraded color or Unicode environments.

Treat TTY detection and terminal dimensions as runtime state, not decoration. Define explicit behavior for missing/invalid width and height so an absent dimension cannot collapse a valid result to zero rows or corrupt layout. Use width breakpoints to remove or shorten lower-priority columns instead of forcing horizontal overflow. When stdout is not a TTY, bypass cursor control and interactive rendering completely and emit stable record-oriented text with one deterministic line per item.

Interactive overlays must own their key scope. While a modal is open, capture conflicting global bindings and key repeats; one confirmation may enqueue the destructive command at most once, cancellation must enqueue nothing, and both paths restore focus to the intended base view. Resize must not silently steal focus. Install signal/error cleanup around terminal-mode changes and restore cursor, raw mode, and screen state from every exit path; a returned `cursorRestored: true` flag without an actual cleanup path is not recovery evidence.

## Hierarchy and routing

- Broader skills: visual-interface-design, frontend-engineering.
- Narrower children: shell-cli-engineering.
- Cross-cutting facets: interaction-design, content-error-design, accessibility-practice.

## Professional practice

### Operating contract

Design CLI and TUI behavior for streams, automation, text, and keyboard operation.

### Execution sequence

1. Classify composable CLI, interactive TUI, or dual-mode behavior.
2. Define arguments, streams, exit codes, help, configuration, and noninteractive contracts.
3. Model TUI focus, selection, navigation, resize, scroll, interruption, and fallback.
4. Define loading, empty, success, partial/error, and interrupted states, including which keys are active and where focus returns after recovery.
5. Implement hierarchy that remains legible without color or Unicode and collapses predictably at narrow widths.
6. Verify piping, redirection, cancellation, repeated keys, modal focus ownership, resize, narrow terminals, degraded capabilities, and errors.

### Decisions that must be explicit

- Human-readable versus machine-readable output.
- Interactive confirmation versus automation-safe flags.
- stdout versus stderr ownership.
- Whether animation or rich terminal features improve feedback without breaking composition.

### Failure and recovery discipline

- Prompts block automation.
- Diagnostics pollute stdout.
- Color or box drawing carries required meaning.
- Resize, suspension, or cancellation corrupts terminal state.

### Evidence required before completion

- Command and stream contract.
- Exit-code and error matrix.
- Automation and degraded-terminal results.
- TUI keyboard/focus/resize evidence where applicable.

### Anti-misinterpretation boundaries

- Never import pointer-hover or document-layout assumptions.
- Do not emit secrets in commands or diagnostics.
- Do not require Unicode or color for comprehension.
- Do not call a screenshot proof of pipe compatibility.

## Completion evidence

- CLI/TUI contract
- Terminal and automation verification

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
