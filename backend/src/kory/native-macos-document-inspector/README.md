# macOS native document inspector — V5 scenario 2

This directory contains a native AppKit document-inspector fixture and an
independent WindowServer/Accessibility/PNG observer. No webview, Playwright,
browser layout engine, synthetic screenshot, or candidate-authored oracle is
involved in the qualification runner.

## What exists

- `DocumentInspector.swift` builds the actual resizable AppKit window. Compiling
  with `-D INSPECTOR_FAULT` deliberately breaks minimum-size metadata layout.
  Its `NSWindowDelegate` responds to native window resize events by updating
  the existing sidebar and field constraints; the layout is not solely rebuilt
  between scripted capture states.
- `InspectorObserver.swift` runs in a **separate process**, requests native AX
  controls/geometry and records the window title, owning PID, number, and bounds
  from WindowServer. When Screen Recording privacy redacts a WindowServer title,
  it accepts a uniquely matching on-screen window only if the owning PID, layer,
  and all four bounds agree with the independently titled AX window. Missing or
  ambiguous matches fail closed. It also records fixture-PID-only on-screen and
  all-window counts when the expected window cannot be identified.
- `PixelObserver.swift` decodes **real** PNG bytes from `screencapture -l`,
  measuring image dimensions, sampled colors/luminance and (when supplied) the
  matching-condition approved-reference pixel difference.
- `evidence.ts` defines 72 state combinations (three sizes, light/dark,
  English/German, empty/normal/max metadata and standard/larger application text)
  and three sequential resize transitions. It fails for missing/blank captures,
  missing AX measurements, invalid native window geometry and horizontal
  clipping/overlap. Cross-state comparisons demand distinct light/dark pixels
  and measured text growth.
- `qualification.ts` builds both native fixture variants with Xcode 27 beta,
  waits for two matching independent WindowServer/AX measurements at least
  150ms apart, gathers 75 healthy captures and the fault capture, then writes a
  `qualification.json` receipt (including compiled binary SHA-256 hashes) and
  original PNGs in an isolated output folder.

## Focused tests

```sh
bun test backend/src/kory/native-macos-document-inspector/evidence.test.ts
```

The nine test cases use invented geometry objects to exercise **fail-closed
validation logic only**, including strict ordering of the 75-state matrix,
localized accessible names, row overlap and the deliberate native fault
signature. They cannot establish live native visual success.

## Build the native bundles without capturing the desktop

```sh
bun run backend/src/kory/native-macos-document-inspector/qualification.ts --build-only
```

This compiles and validates the Info.plist for both real AppKit `.app` bundles,
plus independent WindowServer/AX and PNG observers, under Xcode 27 beta. It
records actual source and binary SHA-256 digests in `build.json`. This build
path does not launch an app, observe a window, or attempt a screen capture.

## Runtime qualification (requires permitted interactive Mac desktop capture)

```sh
bun run backend/src/kory/native-macos-document-inspector/qualification.ts
```

The script saves original PNGs, process-bound native AX geometry, hashes,
failures and runtime version to a newly created `/tmp/kory-native-inspector-*`
directory. Optional `--output <directory>` sets the destination. A trusted,
**independently approved** reference can be supplied with
`--reference <900x700-English-light-PNG> --reference-sha256 <trusted-hash>`.
The fixture's own screenshot is **not** an approved reference. Pixel difference
is merely a measurement; humans must independently review the observed changes
and accessibility and visual semantics.

If a run stops with zero captures, inspect `qualification.json`'s
`runtimeFailures`. The native observer reports both WindowServer's on-screen
and all-window counts for the fixture PID, together with AX trust and window
status. The fixture must run in an active interactive Aqua session with
WindowServer/Accessibility access; a background launch context can prevent
native window observation. The actual macOS console session must be **unlocked**:
the observer rejects `CGSSessionScreenIsLocked` rather than trying to use a
locked desktop as evidence. A successful build or AX window alone is not proof
that a real screenshot was captured.

## Promotion boundary

`visual-verification-full-task-2` **remains blocked** in the primary registry.
Successful source compilation or pure-function unit tests do not satisfy the
scenario's runtime gate. The following evidence remains required:

1. Native WindowServer PNGs at 620x520, 900x700 and 1400x900, including all
   light/dark, dense/empty, long German, larger-font and live resize states;
   screenshots must pass independent pixel, AX, and geometry checks.
2. A real native red (`INSPECTOR_FAULT`) and green (repaired source), on the
   same GUI host, with an exact screenshot of the broken layout.
3. An independently approved reference with authenticated provenance, and
   matching-condition reference audit for 900x700/en/light/normal/standard.
4. Review of visual appearance, meaningful truncation, native materials and
   system-level enlarged-text behavior. The `large` configuration explicitly
   changes application fonts; it has **not** yet verified the macOS system text
   size preference or live VoiceOver interaction.
5. The scenario's candidate-authored evidence artifacts, independently checked
   claim verdicts, and same-model paired skill/no-skill runs.

The standalone qualification tool **never registers or promotes** a scenario;
the historic `EXTERNAL_ENVIRONMENT` fallback remains authoritative until those
conditions have been demonstrated.
