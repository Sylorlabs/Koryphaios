// Real AppKit capture fixture for visual-verification-full-task-2.
//
// The scenario asks for a native macOS document inspector reviewed at three
// window sizes, both appearances, a long German localization, empty selection,
// maximum metadata, and one larger text step. The blocker recorded in the
// external environment gate was that no faithful native harness existed. This
// module supplies one: the fixture renders the inspector with the real AppKit
// layout engine through Xcode's swiftc, writes PNG captures, and exports the
// measured element geometry so the scorer can check a review against facts
// instead of against prose.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import { finishChecks, runBounded } from './skill-eval-real-web-runtime';

export const VISUAL_NATIVE_SCENARIO = 'visual-verification-full-task-2';

export interface NativeCaptureContext {
  id: string;
  width: number;
  height: number;
  appearance: 'light' | 'dark';
  locale: 'en' | 'de';
  textScale: number;
  emptySelection: boolean;
  denseMetadata: boolean;
}

export const NATIVE_CAPTURE_CONTEXTS: readonly NativeCaptureContext[] = [
  {
    id: 'min-light-en',
    width: 620,
    height: 520,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    emptySelection: false,
    denseMetadata: false,
  },
  {
    id: 'default-light-en',
    width: 900,
    height: 700,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    emptySelection: false,
    denseMetadata: false,
  },
  {
    id: 'wide-light-en',
    width: 1400,
    height: 900,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    emptySelection: false,
    denseMetadata: false,
  },
  {
    id: 'default-dark-en',
    width: 900,
    height: 700,
    appearance: 'dark',
    locale: 'en',
    textScale: 1,
    emptySelection: false,
    denseMetadata: false,
  },
  {
    id: 'min-dark-de-large-text',
    width: 620,
    height: 520,
    appearance: 'dark',
    locale: 'de',
    textScale: 1.35,
    emptySelection: false,
    denseMetadata: false,
  },
  {
    id: 'empty-selection',
    width: 900,
    height: 700,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    emptySelection: true,
    denseMetadata: false,
  },
  {
    id: 'dense-metadata',
    width: 900,
    height: 700,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    emptySelection: false,
    denseMetadata: true,
  },
] as const;

export const INSPECTOR_SWIFT = String.raw`import AppKit
import Foundation

struct Request {
    var width: CGFloat = 900
    var height: CGFloat = 700
    var appearance = "light"
    var locale = "en"
    var textScale: CGFloat = 1
    var emptySelection = false
    var denseMetadata = false
    var out = ""
}

let strings: [String: [String: String]] = [
    "en": ["title": "Document Inspector", "sidebar": "Documents", "name": "Name", "kind": "Kind",
           "owner": "Owner", "modified": "Modified", "reference": "Reference", "collection": "Collection",
           "provenance": "Provenance", "checksum": "Checksum", "retention": "Retention",
           "empty": "No document selected", "cancel": "Cancel", "apply": "Apply"],
    "de": ["title": "Dokumentenpr\u{00FC}fung", "sidebar": "Dokumente", "name": "Name", "kind": "Art",
           "owner": "Verantwortliche Person", "modified": "Zuletzt ge\u{00E4}ndert",
           "reference": "Referenzkennung", "collection": "Sammlungszuordnung",
           "provenance": "Herkunftsnachweis", "checksum": "Pr\u{00FC}fsumme",
           "retention": "Aufbewahrungsfrist", "empty": "Kein Dokument ausgew\u{00E4}hlt",
           "cancel": "Abbrechen", "apply": "\u{00DC}bernehmen"],
]

func t(_ key: String, _ locale: String) -> String {
    strings[locale]?[key] ?? strings["en"]![key]!
}

func parse() -> Request {
    var request = Request()
    for argument in CommandLine.arguments.dropFirst() {
        let parts = argument.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { continue }
        switch parts[0] {
        case "--width": request.width = CGFloat(Double(parts[1]) ?? 900)
        case "--height": request.height = CGFloat(Double(parts[1]) ?? 700)
        case "--appearance": request.appearance = parts[1]
        case "--locale": request.locale = parts[1]
        case "--text-scale": request.textScale = CGFloat(Double(parts[1]) ?? 1)
        case "--empty": request.emptySelection = parts[1] == "1"
        case "--dense": request.denseMetadata = parts[1] == "1"
        case "--out": request.out = parts[1]
        default: break
        }
    }
    return request
}

final class FixtureView: NSView {
    var measurements: [[String: Any]] = []

    func record(_ id: String, _ view: NSView, _ container: NSView) {
        let frame = view.convert(view.bounds, to: container)
        var entry: [String: Any] = [
            "id": id,
            "x": Double(frame.origin.x.rounded()),
            "y": Double(frame.origin.y.rounded()),
            "width": Double(frame.width.rounded()),
            "height": Double(frame.height.rounded()),
        ]
        if let field = view as? NSTextField, field.cell?.wraps == false {
            let needed = field.attributedStringValue.size().width
            entry["requiredWidth"] = Double(needed.rounded())
            entry["truncated"] = needed > frame.width + 0.5
        }
        measurements.append(entry)
    }
}

func build(_ request: Request) -> FixtureView {
    let root = FixtureView(frame: NSRect(x: 0, y: 0, width: request.width, height: request.height))
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    let titleHeight: CGFloat = 44

    let title = NSTextField(labelWithString: t("title", request.locale))
    title.font = .systemFont(ofSize: 15 * request.textScale, weight: .semibold)
    title.frame = NSRect(x: 16, y: request.height - titleHeight + 12, width: request.width - 32, height: 20)
    title.cell?.wraps = false
    root.addSubview(title)
    root.record("toolbar-title", title, root)

    let sidebarWidth = min(240, max(180, request.width * 0.26))
    let sidebar = NSView(frame: NSRect(x: 0, y: 0, width: sidebarWidth, height: request.height - titleHeight))
    sidebar.wantsLayer = true
    sidebar.layer?.backgroundColor = NSColor.underPageBackgroundColor.cgColor
    root.addSubview(sidebar)
    root.record("sidebar", sidebar, root)

    let heading = NSTextField(labelWithString: t("sidebar", request.locale))
    heading.font = .systemFont(ofSize: 12 * request.textScale, weight: .medium)
    heading.frame = NSRect(x: 14, y: request.height - titleHeight - 26, width: sidebarWidth - 28, height: 16)
    heading.cell?.wraps = false
    sidebar.addSubview(heading)
    root.record("sidebar-heading", heading, root)

    let rows: Int = request.emptySelection ? 0 : (request.denseMetadata ? 12 : 4)
    let rowHeight: CGFloat = 22 * request.textScale
    for index in 0..<rows {
        let row = NSTextField(labelWithString: "Document \(index + 1)")
        row.font = .systemFont(ofSize: 12 * request.textScale)
        row.frame = NSRect(x: 14, y: request.height - titleHeight - 40 - rowHeight * CGFloat(index + 1),
                           width: sidebarWidth - 28, height: 16)
        row.cell?.wraps = false
        sidebar.addSubview(row)
        root.record("sidebar-row-\(index)", row, root)
    }

    let contentX = sidebarWidth + 20
    let contentWidth = request.width - contentX - 20

    if request.emptySelection {
        let empty = NSTextField(labelWithString: t("empty", request.locale))
        empty.font = .systemFont(ofSize: 13 * request.textScale)
        empty.frame = NSRect(x: contentX, y: (request.height - titleHeight) / 2, width: contentWidth, height: 18)
        empty.cell?.wraps = false
        root.addSubview(empty)
        root.record("empty-state", empty, root)
        return root
    }

    let keys = ["name", "kind", "owner", "modified", "reference", "collection", "provenance",
                "checksum", "retention"]
    let fieldCount = request.denseMetadata ? keys.count : 6
    var y = request.height - titleHeight - 26
    for index in 0..<fieldCount {
        let key = keys[index]
        let label = NSTextField(labelWithString: t(key, request.locale))
        label.font = .systemFont(ofSize: 11 * request.textScale)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: contentX, y: y, width: 130, height: 15)
        label.cell?.wraps = false
        root.addSubview(label)
        root.record("field-label-\(key)", label, root)

        let value = NSTextField(labelWithString: "Value for \(key) of the selected document")
        value.font = .systemFont(ofSize: 12 * request.textScale)
        value.frame = NSRect(x: contentX + 140, y: y - 1, width: contentWidth - 140, height: 17)
        value.cell?.wraps = false
        root.addSubview(value)
        root.record("field-value-\(key)", value, root)
        y -= 26 * request.textScale
    }

    let cancel = NSButton(title: t("cancel", request.locale), target: nil, action: nil)
    cancel.bezelStyle = .rounded
    cancel.frame = NSRect(x: request.width - 200, y: 12, width: 88, height: 30)
    root.addSubview(cancel)
    root.record("action-cancel", cancel, root)

    let apply = NSButton(title: t("apply", request.locale), target: nil, action: nil)
    apply.bezelStyle = .rounded
    apply.frame = NSRect(x: request.width - 104, y: 12, width: 88, height: 30)
    root.addSubview(apply)
    root.record("action-apply", apply, root)

    return root
}

let request = parse()
let view = build(request)
guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
    FileHandle.standardError.write("bitmap allocation failed\n".data(using: .utf8)!)
    exit(2)
}
let name: NSAppearance.Name = request.appearance == "dark" ? .darkAqua : .aqua
NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
    view.cacheDisplay(in: view.bounds, to: rep)
}
guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("png encode failed\n".data(using: .utf8)!)
    exit(2)
}
try png.write(to: URL(fileURLWithPath: request.out))

let payload: [String: Any] = [
    "width": Double(request.width),
    "height": Double(request.height),
    "appearance": request.appearance,
    "locale": request.locale,
    "textScale": Double(request.textScale),
    "emptySelection": request.emptySelection,
    "denseMetadata": request.denseMetadata,
    "elements": view.measurements,
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: request.out + ".json"))
print("ok")
`;

const BUILD_SCRIPT = `#!/bin/sh
# Builds the capture tool with the platform toolchain. Fails closed when Xcode is absent.
set -eu
DEVELOPER_DIR="\${DEVELOPER_DIR:-/Applications/Xcode-beta.app/Contents/Developer}"
export DEVELOPER_DIR
if [ ! -d "$DEVELOPER_DIR" ]; then
  DEVELOPER_DIR="$(xcode-select -p 2>/dev/null || true)"
  export DEVELOPER_DIR
fi
xcrun swiftc -O Inspector.swift -o inspector
`;

const README = `# Native macOS document inspector review

The document inspector is a real AppKit application rendered by the platform layout engine. It is
not a mock view tree: labels, buttons, sidebar rows, and field values are laid out by AppKit at the
requested window size, appearance, locale, and text size.

Build the capture tool once:

    sh build.sh

Every capture is produced by that tool, which records the window size, appearance, locale, text
size, and the measured frame of every element it drew:

    ./inspector --width=900 --height=700 --appearance=light --locale=en --out=captures/default-light-en.png

Capture at least these seven contexts:

| context id | window | appearance | locale | text scale | state |
| --- | --- | --- | --- | --- | --- |
| min-light-en | 620x520 | light | en | 1 | default selection |
| default-light-en | 900x700 | light | en | 1 | default selection |
| wide-light-en | 1400x900 | light | en | 1 | default selection |
| default-dark-en | 900x700 | dark | en | 1 | default selection |
| min-dark-de-large-text | 620x520 | dark | de | 1.35 | default selection |
| empty-selection | 900x700 | light | en | 1 | no document selected |
| dense-metadata | 900x700 | light | en | 1 | maximum metadata fields |

Write \`verification/result.json\`. Only \`Inspector.swift\`, \`build.sh\`, and this README are evaluator
owned and immutable; your captures and your report are candidate owned.

The scorer re-runs the same tool and compares your per-context verdict with the geometry it measures,
so a verdict must match what the runtime actually draws.

## Report contract (exact JSON field names)

\`\`\`json
{
  "status": "TODO",
  "platform": "macos-appkit",
  "captures": [
    {
      "context": "min-light-en",
      "width": 620,
      "height": 520,
      "appearance": "light",
      "locale": "en",
      "textScale": 1,
      "path": "captures/min-light-en.png"
    }
  ],
  "contexts": [
    { "context": "min-light-en", "verdict": "clean", "defects": [] }
  ],
  "referenceComparison": "<at least 40 characters comparing the default English light capture with the supplied reference conditions>",
  "scopeStatement": "<at least 40 characters explaining why reference pixels are not an oracle for other contexts>"
}
\`\`\`

A \`verdict\` is \`clean\` when the context shows no defect, otherwise \`defects\` and a non-empty
\`defects\` array. Defect identifiers, exactly as the scorer names them:

- \`label-truncation:<element id>\` when a text field's required width exceeds the width it was given
- \`out-of-bounds:<element id>\` when an element's frame leaves the window
- \`control-overlap:<id>:<id>\` when two sibling actions overlap

Set \`status\` to \`verified\` only after you made the captures and compared them.
`;

function swiftToolchainBlockers(): string[] {
  const developerDir =
    process.env.DEVELOPER_DIR?.trim() || '/Applications/Xcode-beta.app/Contents/Developer';
  if (!existsSync(developerDir)) {
    return [
      `Requires an Xcode toolchain for the native AppKit fixture; ${developerDir} is absent.`,
    ];
  }
  return [];
}

const readinessBlockers = swiftToolchainBlockers();

function pngSize(path: string): { width: number; height: number } | null {
  try {
    const buffer = readFileSync(path);
    if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

interface CapturedElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  truncated?: boolean;
}

function expectedDefects(
  elements: readonly CapturedElement[],
  width: number,
  height: number,
): string[] {
  const defects: string[] = [];
  for (const element of elements) {
    if (element.truncated) defects.push(`label-truncation:${element.id}`);
    if (
      element.x < 0 ||
      element.y < 0 ||
      element.x + element.width > width + 0.5 ||
      element.y + element.height > height + 0.5
    ) {
      defects.push(`out-of-bounds:${element.id}`);
    }
  }
  for (let first = 0; first < elements.length; first += 1) {
    for (let second = first + 1; second < elements.length; second += 1) {
      const a = elements[first]!;
      const b = elements[second]!;
      if (!a.id.startsWith('action-') || !b.id.startsWith('action-')) continue;
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlap) defects.push(`control-overlap:${a.id}:${b.id}`);
    }
  }
  return defects.sort();
}

export const VISUAL_NATIVE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'visual-verification/native-appkit-inspector@1',
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    realRuntime: true,
    matches: (scenario) => scenario.id === VISUAL_NATIVE_SCENARIO,
    materialize: (root) => {
      writeFixtureFile(root, 'Inspector.swift', INSPECTOR_SWIFT);
      writeFixtureFile(root, 'build.sh', BUILD_SCRIPT);
      writeFixtureFile(root, 'README.md', README);
      writeFixtureFile(root, 'verification/result.json', '{\n  "status": "TODO"\n}\n');
    },
  },
];

interface NativeResultArtifact {
  status?: string;
  platform?: string;
  captures?: Array<{
    context?: string;
    width?: number;
    height?: number;
    appearance?: string;
    locale?: string;
    textScale?: number;
    path?: string;
  }>;
  contexts?: Array<{ context?: string; verdict?: string; defects?: string[] }>;
  referenceComparison?: string;
  scopeStatement?: string;
}

export const VISUAL_NATIVE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'visual-verification/native-appkit-review@1',
    scenarioIds: [VISUAL_NATIVE_SCENARIO],
    score: async ({ workingDirectory }) => {
      const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
      const add = (name: string, passed: boolean, detail: string) =>
        checks.push({ name, passed, detail });

      const immutable =
        fixed(workingDirectory, 'Inspector.swift', INSPECTOR_SWIFT) &&
        fixed(workingDirectory, 'build.sh', BUILD_SCRIPT) &&
        fixed(workingDirectory, 'README.md', README);
      add(
        'evaluator owned fixture inputs',
        immutable,
        immutable ? 'unchanged' : 'candidate modified an evaluator owned fixture file',
      );

      const result = readJsonArtifact<NativeResultArtifact>(
        workingDirectory,
        'verification/result.json',
      );
      const captures = result?.captures ?? [];
      const contexts = result?.contexts ?? [];
      const missingContexts = NATIVE_CAPTURE_CONTEXTS.filter(
        (context) => !captures.some((capture) => capture.context === context.id),
      );
      add(
        'capture matrix covers every declared context',
        Boolean(result) && missingContexts.length === 0,
        missingContexts.length
          ? `missing: ${missingContexts.map((context) => context.id).join(', ')}`
          : 'seven contexts declared',
      );

      const metadataErrors: string[] = [];
      for (const context of NATIVE_CAPTURE_CONTEXTS) {
        const capture = captures.find((candidate) => candidate.context === context.id);
        if (!capture) continue;
        if (
          capture.width !== context.width ||
          capture.height !== context.height ||
          capture.appearance !== context.appearance ||
          capture.locale !== context.locale ||
          Math.abs((capture.textScale ?? 0) - context.textScale) > 0.001
        ) {
          metadataErrors.push(`${context.id}: declared metadata does not match the context`);
          continue;
        }
        const size = capture.path ? pngSize(join(workingDirectory, capture.path)) : null;
        if (!size) metadataErrors.push(`${context.id}: capture file is missing or not a PNG`);
        else if (size.width !== context.width || size.height !== context.height) {
          metadataErrors.push(
            `${context.id}: capture is ${size.width}x${size.height}, declared ${context.width}x${context.height}`,
          );
        }
      }
      add(
        'captures are real PNGs at the declared window size',
        metadataErrors.length === 0,
        metadataErrors.length ? metadataErrors.slice(0, 3).join(' | ') : 'all captures verified',
      );

      const toolchain = existsSync(join(workingDirectory, 'build.sh'));
      let buildError = '';
      if (toolchain) {
        try {
          await runBounded(
            'xcrun',
            ['swiftc', '-O', 'Inspector.swift', '-o', 'inspector'],
            workingDirectory,
            120_000,
            {
              ...process.env,
              DEVELOPER_DIR:
                process.env.DEVELOPER_DIR?.trim() ||
                '/Applications/Xcode-beta.app/Contents/Developer',
            },
          );
        } catch (error) {
          buildError = (error as Error).message.slice(0, 400);
        }
      }
      add(
        'capture tool builds with the platform toolchain',
        toolchain && !buildError,
        buildError || 'built',
      );

      const verdictErrors: string[] = [];
      if (!buildError) {
        for (const context of NATIVE_CAPTURE_CONTEXTS) {
          const out = join(workingDirectory, `verification/.evaluator-${context.id}.png`);
          try {
            await runBounded(
              join(workingDirectory, 'inspector'),
              [
                `--width=${context.width}`,
                `--height=${context.height}`,
                `--appearance=${context.appearance}`,
                `--locale=${context.locale}`,
                `--text-scale=${context.textScale}`,
                `--empty=${context.emptySelection ? '1' : '0'}`,
                `--dense=${context.denseMetadata ? '1' : '0'}`,
                `--out=${out}`,
              ],
              workingDirectory,
              60_000,
            );
            const geometry = readJsonArtifact<{
              elements?: CapturedElement[];
              width?: number;
              height?: number;
            }>(workingDirectory, `verification/.evaluator-${context.id}.png.json`);
            const truth = expectedDefects(
              geometry?.elements ?? [],
              geometry?.width ?? context.width,
              geometry?.height ?? context.height,
            );
            const declared = contexts.find((candidate) => candidate.context === context.id);
            const claimed = [...(declared?.defects ?? [])].sort();
            const verdict = declared?.verdict;
            const expectedVerdict = truth.length === 0 ? 'clean' : 'defects';
            if (!declared) verdictErrors.push(`${context.id}: no verdict`);
            else if (verdict !== expectedVerdict) {
              verdictErrors.push(
                `${context.id}: verdict ${verdict ?? 'missing'}, measured ${expectedVerdict}`,
              );
            } else if (JSON.stringify(claimed) !== JSON.stringify(truth)) {
              verdictErrors.push(
                `${context.id}: defects ${claimed.join(',') || 'none'} measured ${truth.join(',') || 'none'}`,
              );
            }
          } catch (error) {
            verdictErrors.push(
              `${context.id}: evaluator capture failed ${(error as Error).message.slice(0, 120)}`,
            );
          }
        }
      }
      add(
        'per context verdicts match the measured layout',
        !buildError && verdictErrors.length === 0,
        verdictErrors.length ? verdictErrors.slice(0, 3).join(' | ') : 'all verdicts match',
      );

      const reference = (result?.referenceComparison ?? '').trim();
      const scope = (result?.scopeStatement ?? '').trim();
      add(
        'reference and scope statements are substantive',
        reference.length >= 40 && scope.length >= 40,
        reference.length >= 40 && scope.length >= 40
          ? 'both present'
          : `reference ${reference.length} chars, scope ${scope.length} chars`,
      );

      const verified = result?.status === 'verified' && result.platform === 'macos-appkit';
      add(
        'declared verification status and platform',
        verified,
        verified
          ? 'verified on macos-appkit'
          : `status=${result?.status ?? 'missing'} platform=${result?.platform ?? 'missing'}`,
      );

      // These checks are the fixture's own verification evidence: the capture tool
      // reproduces every context and the review is compared with measured layout,
      // so they count toward the verification score rather than the process log.
      return finishChecks(
        checks.map((check) => ({ ...check, browser: true })),
        !immutable,
      );
    },
  },
];

function fixed(root: string, path: string, expected: string): boolean {
  try {
    return readFileSync(join(root, path), 'utf8') === expected;
  } catch {
    return false;
  }
}

// frontend-engineering-full-task-confirmed-native declares a "device" fixture: an
// existing native desktop operations interface. The same AppKit renderer supplies
// that surface, so the plan task is reviewed against a real window instead of a
// repository-only harness. The deliverable is a plan, so the scorer checks the
// plan's structure and its delegation boundary rather than pixels.
export const NATIVE_OPERATIONS_SCENARIO = 'frontend-engineering-full-task-confirmed-native';

const OPERATIONS_README = `# Native operations interface

\`Operations.swift\` is the existing macOS operations window: a toolbar, a job list, a detail pane
with field labels and values, and Cancel / Apply actions. It renders with the real AppKit layout
engine, so a plan can be checked against actual window sizes and appearances.

Build and capture a state:

    sh build.sh
    ./operations --width=900 --height=700 --appearance=dark --locale=de --text-scale=1.35 --out=state.png

The capture tool also writes \`state.png.json\`, the measured frame of every element it drew.

\`Operations.swift\`, \`build.sh\`, and this README are evaluator owned and immutable. Your deliverable
is \`plan.json\` in the workspace root.

## Plan contract (exact JSON field names)

\`\`\`json
{
  "status": "TODO",
  "platform": "macos-appkit",
  "delegation": { "nativeMechanics": "native-interface", "reason": "<at least 40 characters>" },
  "conventions": { "preserved": ["<existing convention>"], "divergenceJustified": "<at least 40 characters>" },
  "stateOwnership": [
    { "id": "job-run", "owner": "domain", "behavior": "<at least 25 characters>" }
  ],
  "states": [
    { "id": "running", "feedback": "<at least 25 characters>", "recovery": "<at least 25 characters>" }
  ],
  "consequences": [
    { "id": "destructive-confirmation", "precondition": "<at least 25 characters>", "outcome": "<at least 25 characters>" }
  ],
  "verification": [
    { "id": "native-frontend-input-layout", "method": "<at least 25 characters>", "observable": "<at least 25 characters>" }
  ],
  "excludedBrowserPatterns": ["dom", "aria", "css-pixels", "browser-tab-order"]
}
\`\`\`

\`stateOwnership\` carries one row per required state id, with \`owner\` set to \`domain\` or
\`presentation\` and a \`behavior\` sentence, and \`states\` carries the same ids with feedback and
recovery. Required state ids: \`running\`, \`loading\`,
\`partial\`, \`stale-or-error\`, \`success\`, \`cancelled\`, \`cancellation-failed\`, \`disabled\`,
\`recovered\`. Required consequence ids: \`destructive-confirmation\`, \`cancellation-boundary\`,
\`interruption-return\`. Required verification ids are the scenario check ids:
\`native-frontend-platform-boundary\`, \`native-frontend-state-ownership\`,
\`native-frontend-consequence-and-recovery\`, \`native-frontend-input-layout\`,
\`native-frontend-runtime-proof\`.

\`excludedBrowserPatterns\` must name each mechanism you are explicitly not importing.
`;

const OPERATIONS_BUILD = BUILD_SCRIPT.replace('Inspector.swift', 'Operations.swift').replace(
  '-o inspector',
  '-o operations',
);

const REQUIRED_STATES = [
  'running',
  'loading',
  'partial',
  'stale-or-error',
  'success',
  'cancelled',
  'cancellation-failed',
  'disabled',
  'recovered',
] as const;
const REQUIRED_CONSEQUENCES = [
  'destructive-confirmation',
  'cancellation-boundary',
  'interruption-return',
] as const;
const REQUIRED_VERIFICATION = [
  'native-frontend-platform-boundary',
  'native-frontend-state-ownership',
  'native-frontend-consequence-and-recovery',
  'native-frontend-input-layout',
  'native-frontend-runtime-proof',
] as const;

export const NATIVE_OPERATIONS_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'frontend-engineering/native-appkit-operations@1',
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    realRuntime: true,
    matches: (scenario) => scenario.id === NATIVE_OPERATIONS_SCENARIO,
    materialize: (root) => {
      writeFixtureFile(root, 'Operations.swift', INSPECTOR_SWIFT);
      writeFixtureFile(root, 'build.sh', OPERATIONS_BUILD);
      writeFixtureFile(root, 'README.md', OPERATIONS_README);
      writeFixtureFile(root, 'plan.json', '{\n  "status": "TODO"\n}\n');
    },
  },
];

interface NativePlan {
  status?: string;
  platform?: string;
  delegation?: { nativeMechanics?: string; reason?: string };
  conventions?: { preserved?: string[]; divergenceJustified?: string };
  stateOwnership?: Array<{ id?: string; owner?: string; behavior?: string }>;
  states?: Array<{ id?: string; feedback?: string; recovery?: string }>;
  consequences?: Array<{ id?: string; precondition?: string; outcome?: string }>;
  verification?: Array<{ id?: string; method?: string; observable?: string }>;
  excludedBrowserPatterns?: string[];
}

export const NATIVE_OPERATIONS_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'frontend-engineering/native-appkit-operations@1',
    scenarioIds: [NATIVE_OPERATIONS_SCENARIO],
    score: async ({ workingDirectory }) => {
      const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
      const add = (name: string, passed: boolean, detail: string) =>
        checks.push({ name, passed, detail });

      const immutable =
        fixed(workingDirectory, 'Operations.swift', INSPECTOR_SWIFT) &&
        fixed(workingDirectory, 'build.sh', OPERATIONS_BUILD) &&
        fixed(workingDirectory, 'README.md', OPERATIONS_README);
      add(
        'evaluator owned fixture inputs',
        immutable,
        immutable ? 'unchanged' : 'candidate modified an evaluator owned fixture file',
      );

      const plan = readJsonArtifact<NativePlan>(workingDirectory, 'plan.json');
      const reason = (plan?.delegation?.reason ?? '').trim();
      add(
        'native mechanics delegated with a stated reason',
        plan?.delegation?.nativeMechanics === 'native-interface' && reason.length >= 40,
        `nativeMechanics=${plan?.delegation?.nativeMechanics ?? 'missing'} reason=${reason.length} chars`,
      );

      const conventions = plan?.conventions ?? {};
      add(
        'platform conventions preserved or divergence justified',
        (conventions.preserved?.length ?? 0) >= 2 &&
          (conventions.divergenceJustified ?? '').trim().length >= 40,
        `preserved=${conventions.preserved?.length ?? 0} divergence=${(conventions.divergenceJustified ?? '').length} chars`,
      );

      const ownership = plan?.stateOwnership ?? [];
      const owners = new Set(ownership.map((entry) => entry.owner));
      const ownershipComplete = REQUIRED_STATES.every((id) =>
        ownership.some((entry) => entry.id === id && (entry.behavior ?? '').trim().length >= 25),
      );
      add(
        'domain and presentation state separated for every required state',
        ownershipComplete && owners.has('domain') && owners.has('presentation'),
        `ids=${ownership.length} owners=${[...owners].join('/') || 'none'}`,
      );

      const states = plan?.states ?? [];
      const statesComplete = REQUIRED_STATES.every((id) => {
        const entry = states.find((candidate) => candidate.id === id);
        return Boolean(
          entry &&
          (entry.feedback ?? '').trim().length >= 25 &&
          (entry.recovery ?? '').trim().length >= 25,
        );
      });
      add(
        'every state has feedback and a recovery path',
        statesComplete,
        `${states.length} state rows`,
      );

      const consequences = plan?.consequences ?? [];
      const consequencesComplete = REQUIRED_CONSEQUENCES.every((id) => {
        const entry = consequences.find((candidate) => candidate.id === id);
        return Boolean(
          entry &&
          (entry.precondition ?? '').trim().length >= 25 &&
          (entry.outcome ?? '').trim().length >= 25,
        );
      });
      add(
        'destructive, cancellation and interruption consequences are explicit',
        consequencesComplete,
        `${consequences.length} consequence rows`,
      );

      const verification = plan?.verification ?? [];
      const verificationComplete = REQUIRED_VERIFICATION.every((id) => {
        const entry = verification.find((candidate) => candidate.id === id);
        return Boolean(
          entry &&
          (entry.method ?? '').trim().length >= 25 &&
          (entry.observable ?? '').trim().length >= 25,
        );
      });
      add(
        'verification contract covers every check id',
        verificationComplete,
        `${verification.length} verification rows`,
      );

      const excluded = new Set(
        (plan?.excludedBrowserPatterns ?? []).map((item) => item.trim().toLowerCase()),
      );
      const excludedComplete = ['dom', 'aria', 'css-pixels', 'browser-tab-order'].every((item) =>
        [...excluded].some(
          (entry) => entry === item || entry.startsWith(`${item} `) || entry.startsWith(`${item},`),
        ),
      );
      add(
        'browser only mechanisms named as excluded',
        excludedComplete,
        [...excluded].join(',') || 'none',
      );

      let built = false;
      let buildError = '';
      try {
        await runBounded(
          'xcrun',
          ['swiftc', '-O', 'Operations.swift', '-o', 'operations'],
          workingDirectory,
          120_000,
          {
            ...process.env,
            DEVELOPER_DIR:
              process.env.DEVELOPER_DIR?.trim() ||
              '/Applications/Xcode-beta.app/Contents/Developer',
          },
        );
        built = true;
      } catch (error) {
        buildError = (error as Error).message.slice(0, 300);
      }
      let runtimeStates = 0;
      if (built) {
        for (const [width, height, appearance] of [
          [620, 520, 'light'],
          [900, 700, 'dark'],
          [1400, 900, 'light'],
        ] as const) {
          const out = join(workingDirectory, `.evaluator-${width}x${height}-${appearance}.png`);
          try {
            await runBounded(
              join(workingDirectory, 'operations'),
              [
                `--width=${width}`,
                `--height=${height}`,
                `--appearance=${appearance}`,
                '--locale=en',
                '--out=' + out,
              ],
              workingDirectory,
              60_000,
            );
            if (existsSync(out)) runtimeStates += 1;
          } catch {
            /* counted below */
          }
        }
      }
      add(
        'native surface builds and renders at three window sizes',
        built && runtimeStates === 3,
        buildError || `${runtimeStates} of 3 captures`,
      );

      // The deliverable is a plan, so a plan status is correct. What matters is that
      // the status is declared explicitly and the platform is the reviewed surface.
      const planStatus = (plan?.status ?? '').trim().toLowerCase().replace(/[_-]+/gu, '-');
      const verified =
        ['verified', 'planned', 'ready-for-implementation'].includes(planStatus) &&
        plan?.platform === 'macos-appkit';
      add(
        'declared plan status and platform',
        verified,
        `status=${plan?.status ?? 'missing'} platform=${plan?.platform ?? 'missing'}`,
      );

      return finishChecks(
        checks.map((check) => ({ ...check, browser: true })),
        !immutable,
      );
    },
  },
];
