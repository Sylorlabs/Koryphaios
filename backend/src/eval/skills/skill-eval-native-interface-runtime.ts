// Real AppKit desktop runtime for native-interface-full-task-desktop-operations.
//
// The scenario asks for a native desktop operations window whose job states,
// keyboard focus, resize/scaling behaviour and relaunch restoration are observable
// in the real toolkit. The environment gate recorded that no faithful native
// harness existed. This module supplies one: the evaluator owns an AppKit shell
// that renders whatever the candidate's model reports, captures the live window
// through the toolkit's own drawing path, and exports the measured element
// geometry, the window's real first responder, and the durable payload the model
// asked to persist.
//
// What is measured is the toolkit, not a description of it. A candidate that
// claims correct focus but leaves the window's first responder on the content
// view fails, because the responder is read from `NSWindow.firstResponder` after
// the window is key. A candidate that claims a fitting layout at 640x420 fails
// when an interactive frame is outside the content rect.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import type { RuntimeCheck } from './skill-eval-real-web-runtime';
import { finishChecks, runBounded } from './skill-eval-real-web-runtime';

export const NATIVE_INTERFACE_DESKTOP_SCENARIO = 'native-interface-full-task-desktop-operations';
export const NATIVE_INTERFACE_MOBILE_SCENARIO = 'native-interface-full-task-mobile-recovery';

export interface NativeInterfaceToolchain {
  swiftc: string | null;
  sdk: string | null;
  blocker: string | null;
}

/** Discovery is by absolute path: a PATH hit on CommandLineTools' swiftc cannot
 * build against the Xcode SDK on this host, which is the difference between a
 * native build and a compiler error the harness would misread as a candidate fault. */
export function nativeInterfaceToolchain(): NativeInterfaceToolchain {
  const developer =
    process.env.DEVELOPER_DIR?.trim() || '/Applications/Xcode-beta.app/Contents/Developer';
  const swiftc = join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc');
  const sdk = join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk');
  if (!existsSync(swiftc) || !existsSync(sdk)) {
    return {
      swiftc: null,
      sdk: null,
      blocker:
        'Native AppKit target toolchain is unavailable (Xcode swiftc plus the macOS SDK at a known absolute path)',
    };
  }
  return { swiftc, sdk, blocker: null };
}

export const NATIVE_INTERFACE_REQUIRED_STATES = [
  'idle',
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

const NATIVE_IFACE_BUILD = `#!/bin/sh
# Builds the operations fixture with the Xcode toolchain. Fails closed when Xcode is absent.
set -eu
DEVELOPER_DIR="\${DEVELOPER_DIR:-/Applications/Xcode-beta.app/Contents/Developer}"
export DEVELOPER_DIR
SWIFTC="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
SDK="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
if [ ! -x "$SWIFTC" ] || [ ! -d "$SDK" ]; then
  echo "native toolchain unavailable" >&2
  exit 3
fi
"$SWIFTC" -sdk "$SDK" -target arm64-apple-macos13.0 -O -o operations main.swift OperationsModel.swift
`;

const NATIVE_IFACE_README = `# Native operations window

\`main.swift\` is the existing macOS operations window: a titled window, an application
menu, a job list, a detail pane, a status line, and the job actions. It renders with the
real AppKit layout engine and captures through the toolkit's own drawing path, so its
geometry and first responder are facts about a live window.

Build and capture a state:

    sh build.sh
    ./operations --state=stale-or-error --width=900 --height=700 --text-scale=1 --report=state.json --out=state.png
    ./operations --state=recovered --width=640 --height=420 --text-scale=1.35 --report=narrow.json

\`main.swift\`, \`build.sh\`, and this README are evaluator owned and immutable. Your
deliverable is \`OperationsModel.swift\` plus \`verification/desktop-result.json\`.

## Model contract

\`OperationsModel\` must expose:

- \`select(state: String)\` for each required state id
- \`statusText() -> String\` — the text the status line shows in the selected state
- \`layout(width:height:scale:) -> LayoutSpec\` — the element frames the window renders,
  including the ids \`title\`, \`job-list\`, \`detail\`, \`status\`, \`retry\`, \`cancel\`,
  \`primary-action\`, with \`enabled\` and \`focused\` set from the job state
- \`saveableState() -> [String: Any]\` — the durable state a relaunch must restore
- \`restore(from: [String: Any])\` — the same payload on the next launch

Required state ids: ${NATIVE_INTERFACE_REQUIRED_STATES.map((id) => `\`${id}\``).join(', ')}.

## What the evaluator measures

It builds your model behind the shell and runs the real window. It reads element frames
and the window's actual first responder from the capture report, and it compares the
durable payload written on the first launch with the state reported on the second. The
checks are the scenario's own: \`desktop-native-platform-contract\`,
\`desktop-native-job-state\`, \`desktop-native-input-focus\`,
\`desktop-native-resize-scaling\`, \`desktop-native-restoration-proof\`.

## Verification artifact

\`verification/desktop-result.json\` must contain:

\`\`\`json
{
  "status": "verified",
  "platform": "macos-appkit",
  "editor": "OperationsModel.swift",
  "stateMatrix": { "<required state id>": "<status text the window shows>" },
  "focus": { "stale-or-error": "retry", "running": "job-list" },
  "sizes": ["900x700", "640x420"],
  "restoration": { "durable": ["lastState", "windowWidth", "windowHeight"], "ephemeral": ["scrollOffset"] },
  "excludedBrowserPatterns": ["dom", "css-pixels", "browser-tab-order"]
}
\`\`\`

A check you could not observe in the real window belongs in \`unverified\`, never in a
claim.

## Work in this order and stop when the artifact is written

The evaluator runs the window itself, so a private sweep is not required and will
consume the turn budget.

1. Run \`sh build.sh\` once. It must produce \`./operations\`.
2. Run \`./operations --state=stale-or-error --report=/tmp/a.json\` and read
   \`firstResponder\` and \`elements\` to confirm focus and geometry.
3. Run it at \`--width=640 --height=420 --text-scale=1.35\` in the
   \`partial\` state to confirm every frame is inside the content rect.
4. Write \`verification/desktop-result.json\` with the ten state texts exactly as
   \`OperationsModel.statusText()\` returns them.
5. Stop. Extra captures do not score anything.

\`verification/desktop-result.json\` is what the last check reads, so an
unfinished artifact is a failed check even when the window is correct.
`;

/** The evaluator-owned shell. It is a real AppKit application: a titled key window,
 * an application menu, subviews laid out from the model's frames, a real responder
 * chain, and a capture path through `cacheDisplay` rather than a synthetic renderer. */
const NATIVE_IFACE_SHELL = String.raw`import AppKit
import Foundation

struct ElementFrame: Codable {
  let id: String
  let kind: String
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  let enabled: Bool
  let focused: Bool
}

struct CaptureReport: Codable {
  let schema: Int
  let state: String
  let windowWidth: Double
  let windowHeight: Double
  let textScale: Double
  let title: String
  let status: String
  let menuTitles: [String]
  let elements: [ElementFrame]
  let firstResponder: String
  let saved: [String: String]
  let restored: Bool
  let states: [String: String]
}

let arguments = CommandLine.arguments
func argument(_ name: String, _ fallback: String) -> String {
  for (index, value) in arguments.enumerated() {
    if value == "--\(name)", index + 1 < arguments.count { return arguments[index + 1] }
    if value.hasPrefix("--\(name)=") { return String(value.dropFirst(name.count + 3)) }
  }
  return fallback
}

let stateName = argument("state", "running")
let outPath = argument("out", "")
let reportPath = argument("report", "")
let persistPath = argument("persist", "")
let width = Double(argument("width", "900")) ?? 900
let height = Double(argument("height", "700")) ?? 700
let textScale = Double(argument("text-scale", "1")) ?? 1
let appearanceName = argument("appearance", "dark")

// The harness must never take over the host screen: an evaluation runs unattended,
// often beside the user's own work, so the application is prohibited from activating,
// the window is never ordered front, and nothing is drawn to the display server's
// visible surface. A window object still exists, so it can hold a real responder chain
// and render its subviews into an offscreen bitmap.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

let model = OperationsModel()
var restored = false
if !persistPath.isEmpty {
  let url = URL(fileURLWithPath: persistPath)
  if let data = try? Data(contentsOf: url),
     let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
    model.restore(from: payload)
    restored = true
  }
}
model.select(state: stateName)

let view = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
let window = NSWindow(
  contentRect: NSRect(x: 0, y: 0, width: width, height: height),
  styleMask: [.titled, .closable, .resizable, .miniaturizable],
  backing: .buffered,
  defer: false)
window.title = "Kory Operations"
window.contentView = view
if appearanceName == "dark" { window.appearance = NSAppearance(named: .darkAqua) }

let menu = NSMenu()
let appMenuItem = NSMenuItem()
let appMenu = NSMenu()
appMenu.addItem(withTitle: "About Kory Operations", action: nil, keyEquivalent: "")
appMenu.addItem(withTitle: "Quit Kory Operations", action: nil, keyEquivalent: "q")
appMenuItem.submenu = appMenu
menu.addItem(appMenuItem)
let fileMenuItem = NSMenuItem()
let fileMenu = NSMenu(title: "File")
fileMenu.addItem(withTitle: "Start Job", action: nil, keyEquivalent: "n")
fileMenu.addItem(withTitle: "Cancel Job", action: nil, keyEquivalent: ".")
fileMenuItem.submenu = fileMenu
menu.addItem(fileMenuItem)
application.mainMenu = menu

let spec = model.layout(width: width, height: height, scale: textScale)
var frames: [ElementFrame] = []
var focusTarget: NSView? = nil
var focusId = "window"

for element in spec.elements {
  let control: NSView
  switch element.kind {
  case "button":
    let button = NSButton(title: element.title, target: nil, action: nil)
    button.bezelStyle = .rounded
    button.isEnabled = element.enabled
    control = button
  case "label":
    control = NSTextField(labelWithString: element.title)
  case "progress":
    let bar = NSProgressIndicator()
    bar.style = .bar
    if element.enabled { bar.isIndeterminate = true; bar.startAnimation(nil) } else { bar.doubleValue = 45 }
    control = bar
  case "field":
    let field = NSTextField(string: element.title)
    field.isEditable = true
    control = field
  default:
    let box = NSBox()
    box.title = element.title
    control = box
  }
  control.frame = NSRect(
    x: element.x,
    y: height - element.y - element.height,
    width: element.width,
    height: element.height)
  control.toolTip = element.id
  view.addSubview(control)
  if element.focused {
    focusTarget = control
    focusId = element.id
  }
  frames.append(ElementFrame(
    id: element.id, kind: element.kind, x: element.x, y: element.y,
    width: element.width, height: element.height,
    enabled: element.enabled, focused: element.focused))
}

window.contentView?.display()
if let focusTarget = focusTarget {
  window.makeFirstResponder(focusTarget)
} else {
  window.makeFirstResponder(view)
  focusId = "content-view"
}
RunLoop.current.run(until: Date().addingTimeInterval(0.35))

var responderId = "window"
if let responder = window.firstResponder {
  if responder === view { responderId = "content-view" }
  for subview in view.subviews where subview === responder { responderId = subview.toolTip ?? "element" }
}

var saved: [String: String] = [:]
for (key, value) in model.saveableState() { saved[key] = String(describing: value) }
if !persistPath.isEmpty {
  if let data = try? JSONSerialization.data(withJSONObject: model.saveableState(), options: []) {
    try? data.write(to: URL(fileURLWithPath: persistPath))
  }
}

var stateMatrix: [String: String] = [:]
for id in [
  "idle", "running", "loading", "partial", "stale-or-error", "success",
  "cancelled", "cancellation-failed", "disabled", "recovered",
] {
  model.select(state: id)
  stateMatrix[id] = model.statusText()
  _ = model.layout(width: width, height: height, scale: textScale)
}
model.select(state: stateName)

let report = CaptureReport(
  schema: 1,
  state: stateName,
  windowWidth: width,
  windowHeight: height,
  textScale: textScale,
  title: window.title,
  status: model.statusText(),
  menuTitles: application.mainMenu?.items.map { $0.submenu?.title ?? "" } ?? [],
  elements: frames,
  firstResponder: responderId,
  saved: saved,
  restored: restored,
  states: stateMatrix)

if !reportPath.isEmpty {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  if let data = try? encoder.encode(report) {
    try? data.write(to: URL(fileURLWithPath: reportPath))
  }
}
if !outPath.isEmpty {
  let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
  view.cacheDisplay(in: view.bounds, to: representation)
  if let png = representation.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: outPath))
  }
}
exit(0)
`;

/** The shipped model. Every defect is one a real candidate plausibly writes: a
 * footer that overflows the content rect, cancel always enabled, error recovery
 * that leaves focus on the content view, and nothing durable to restore. */
const NATIVE_IFACE_STARTER = String.raw`import Foundation

struct ElementSpec {
  let id: String
  let kind: String
  let title: String
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  let enabled: Bool
  let focused: Bool
}

struct LayoutSpec { let elements: [ElementSpec] }

final class OperationsModel {
  private var state = "idle"

  func select(state: String) { self.state = state }

  func statusText() -> String {
    switch state {
    case "running": return "Running: shard 3 of 8"
    case "loading": return "Loading job list"
    case "partial": return "Partial results: 5 of 8 shards"
    case "stale-or-error": return "Error: upstream timeout"
    case "success": return "Job complete"
    case "cancelled": return "Running: cancellation requested"
    case "cancellation-failed": return "Job complete"
    case "disabled": return "Running: shard 3 of 8"
    case "recovered": return "Job complete"
    default: return "No job selected"
    }
  }

  func layout(width: Double, height: Double, scale: Double) -> LayoutSpec {
    let title = ElementSpec(id: "title", kind: "label", title: "Operations",
      x: 20, y: 20, width: 400, height: 24, enabled: true, focused: false)
    let jobs = ElementSpec(id: "job-list", kind: "box", title: "Jobs",
      x: 20, y: 60, width: 380, height: 240, enabled: true, focused: true)
    let detail = ElementSpec(id: "detail", kind: "box", title: "Detail",
      x: 20, y: 320, width: 760, height: 200, enabled: true, focused: false)
    let status = ElementSpec(id: "status", kind: "label", title: statusText(),
      x: 20, y: 270, width: 500, height: 20, enabled: true, focused: false)
    let retry = ElementSpec(id: "retry", kind: "button", title: "Retry",
      x: width - 250, y: height - 60, width: 190, height: 32, enabled: true, focused: false)
    let primary = ElementSpec(id: "primary-action", kind: "button", title: "Start job",
      x: width - 40, y: height - 60, width: 200, height: 32, enabled: true, focused: false)
    let cancel = ElementSpec(id: "cancel", kind: "button", title: "Cancel job",
      x: width - 250, y: height - 100, width: 190, height: 32, enabled: true, focused: false)
    return LayoutSpec(elements: [title, jobs, detail, status, retry, primary, cancel])
  }

  func saveableState() -> [String: Any] { return [:] }

  func restore(from payload: [String: Any]) { }
}
`;

export const NATIVE_INTERFACE_TOOLCHAIN = nativeInterfaceToolchain();

const readinessBlockers = NATIVE_INTERFACE_TOOLCHAIN.blocker
  ? [NATIVE_INTERFACE_TOOLCHAIN.blocker]
  : [];

export const NATIVE_INTERFACE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'native-interface/appkit-operations@1',
    readinessBlockers: readinessBlockers.length ? readinessBlockers : undefined,
    realRuntime: true,
    matches: (scenario) => scenario.id === NATIVE_INTERFACE_DESKTOP_SCENARIO,
    materialize: (root) => {
      writeFixtureFile(root, 'main.swift', NATIVE_IFACE_SHELL);
      writeFixtureFile(root, 'OperationsModel.swift', NATIVE_IFACE_STARTER);
      writeFixtureFile(root, 'build.sh', NATIVE_IFACE_BUILD);
      writeFixtureFile(root, 'README.md', NATIVE_IFACE_README);
      writeFixtureFile(root, 'verification/desktop-result.json', '{\n  "status": "TODO"\n}\n');
    },
  },
];

interface CaptureReport {
  schema?: number;
  state?: string;
  windowWidth?: number;
  windowHeight?: number;
  textScale?: number;
  title?: string;
  status?: string;
  menuTitles?: string[];
  elements?: Array<{
    id?: string;
    kind?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    enabled?: boolean;
    focused?: boolean;
  }>;
  firstResponder?: string;
  saved?: Record<string, string>;
  restored?: boolean;
  states?: Record<string, string>;
}

interface DesktopResult {
  status?: string;
  platform?: string;
  editor?: string;
  stateMatrix?: Record<string, string>;
  focus?: Record<string, string>;
  sizes?: string[];
  restoration?: { durable?: string[]; ephemeral?: string[] };
  excludedBrowserPatterns?: string[];
  unverified?: string[];
}

interface BuildOutcome {
  ok: boolean;
  log: string;
  binary: string;
}

function buildOperations(root: string): BuildOutcome {
  const toolchain = NATIVE_INTERFACE_TOOLCHAIN;
  const binary = join(root, 'operations');
  if (!toolchain.swiftc || !toolchain.sdk) {
    return { ok: false, log: toolchain.blocker ?? 'toolchain unavailable', binary };
  }
  const built = spawnSync(
    toolchain.swiftc,
    [
      '-sdk',
      toolchain.sdk,
      '-target',
      'arm64-apple-macos13.0',
      '-O',
      '-o',
      binary,
      join(root, 'main.swift'),
      join(root, 'OperationsModel.swift'),
    ],
    { encoding: 'utf8', timeout: 180_000, cwd: root },
  );
  const log = `${built.stdout ?? ''}${built.stderr ?? ''}`.trim();
  return { ok: built.status === 0 && existsSync(binary), log, binary };
}

interface Captured {
  ok: boolean;
  detail: string;
  report: CaptureReport | null;
  pixels: number;
}

function capture(
  root: string,
  binary: string,
  options: {
    state: string;
    width: number;
    height: number;
    scale?: number;
    persist?: string;
    id: string;
  },
): Captured {
  const reportPath = join(root, `.report-${options.id}.json`);
  const pngPath = join(root, `.capture-${options.id}.png`);
  const args = [
    `--state=${options.state}`,
    `--width=${String(options.width)}`,
    `--height=${String(options.height)}`,
    `--text-scale=${String(options.scale ?? 1)}`,
    `--report=${reportPath}`,
    `--out=${pngPath}`,
  ];
  if (options.persist) args.push(`--persist=${options.persist}`);
  const run = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000, cwd: root });
  if (run.status !== 0) {
    return {
      ok: false,
      detail: `window capture failed (status ${String(run.status)}): ${((run.stderr ?? '') + (run.stdout ?? '')).trim().slice(0, 400)}`,
      report: null,
      pixels: 0,
    };
  }
  const report = readJsonArtifact<CaptureReport>(root, `.report-${options.id}.json`);
  let pixels = 0;
  try {
    pixels = readFileSync(pngPath).byteLength;
  } catch {
    pixels = 0;
  }
  if (!report) return { ok: false, detail: 'capture report missing', report: null, pixels };
  return { ok: true, detail: 'captured', report, pixels };
}

function insideBounds(report: CaptureReport): string[] {
  const width = report.windowWidth ?? 0;
  const height = report.windowHeight ?? 0;
  const outside: string[] = [];
  for (const element of report.elements ?? []) {
    const x = element.x ?? 0;
    const y = element.y ?? 0;
    const w = element.width ?? 0;
    const h = element.height ?? 0;
    if (x < -0.01 || y < -0.01 || x + w > width + 0.01 || y + h > height + 0.01) {
      outside.push(
        `${element.id ?? '?'} at ${x.toFixed(0)},${y.toFixed(0)} ${w.toFixed(0)}x${h.toFixed(0)}`,
      );
    }
  }
  return outside;
}

type Frame = NonNullable<CaptureReport['elements']>[number];

function overlaps(left: Frame | undefined, right: Frame | undefined): boolean {
  if (!left || !right) return false;
  const a = {
    x1: left.x ?? 0,
    y1: left.y ?? 0,
    x2: (left.x ?? 0) + (left.width ?? 0),
    y2: (left.y ?? 0) + (left.height ?? 0),
  };
  const b = {
    x1: right.x ?? 0,
    y1: right.y ?? 0,
    x2: (right.x ?? 0) + (right.width ?? 0),
    y2: (right.y ?? 0) + (right.height ?? 0),
  };
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w > 1 && h > 1;
}

const element = (
  report: CaptureReport | null,
  id: string,
): NonNullable<CaptureReport['elements']>[number] | undefined =>
  (report?.elements ?? []).find((item) => item.id === id);

export const NATIVE_INTERFACE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'native-interface/appkit-operations@1',
    scenarioIds: [NATIVE_INTERFACE_DESKTOP_SCENARIO],
    score: async ({ workingDirectory }): Promise<SkillEvalDeterministicScore> => {
      const checks: RuntimeCheck[] = [];
      // The five runtime checks are the verification evidence: each one is a measurement
      // of the live window, so a candidate that skips the native proof scores 0 there.
      const add = (name: string, passed: boolean, detail: string, verification = false) =>
        checks.push({ name, passed, detail, browser: verification });

      const immutable =
        readFixtureText(workingDirectory, 'main.swift') === NATIVE_IFACE_SHELL &&
        readFixtureText(workingDirectory, 'build.sh') === NATIVE_IFACE_BUILD &&
        readFixtureText(workingDirectory, 'README.md') === NATIVE_IFACE_README;
      add(
        'evaluator owned fixture inputs',
        immutable,
        immutable ? 'unchanged' : 'candidate modified an evaluator owned fixture file',
      );

      const built = buildOperations(workingDirectory);
      const modelSource = (() => {
        try {
          return readFileSync(join(workingDirectory, 'OperationsModel.swift'), 'utf8');
        } catch {
          return '';
        }
      })();
      const nativeOnly = !/WKWebView|NSWebView|document\.getElementById|<html/iu.test(modelSource);
      const wide = capture(workingDirectory, built.binary, {
        state: 'stale-or-error',
        width: 900,
        height: 700,
        id: 'wide',
      });
      const report = wide.report;
      const liveWindow =
        wide.ok &&
        report?.title === 'Kory Operations' &&
        (report.menuTitles ?? []).length >= 2 &&
        (report.elements ?? []).length >= 7 &&
        wide.pixels > 5_000;
      const platformContract =
        built.ok &&
        immutable &&
        nativeOnly &&
        liveWindow &&
        NATIVE_INTERFACE_REQUIRED_STATES.every((id) => typeof report?.states?.[id] === 'string');
      add(
        'desktop-native-platform-contract',
        platformContract,
        built.ok
          ? `real AppKit window "${report?.title ?? ''}" with ${String((report?.menuTitles ?? []).length)} menus, ${String(wide.pixels)} captured bytes, native-only source=${String(nativeOnly)}`
          : `native build failed: ${built.log.slice(0, 300)}`,
        true,
      );

      const expected: Record<string, (text: string) => boolean> = {
        idle: (text) => /no job selected/iu.test(text),
        running: (text) => /running/iu.test(text),
        loading: (text) => /loading/iu.test(text),
        partial: (text) => /partial/iu.test(text),
        'stale-or-error': (text) => /error/iu.test(text),
        success: (text) => /complete|success/iu.test(text),
        cancelled: (text) => /cancel/iu.test(text) && !/^running/iu.test(text),
        'cancellation-failed': (text) => /fail/iu.test(text),
        disabled: (text) => /disabled|locked/iu.test(text),
        recovered: (text) => /recover|resum/iu.test(text),
      };
      const distinct = new Set(Object.values(report?.states ?? {}));
      const wrongStates = Object.entries(expected)
        .filter(([id, predicate]) => !predicate(report?.states?.[id] ?? ''))
        .map(([id]) => id);
      const runningReport = capture(workingDirectory, built.binary, {
        state: 'running',
        width: 900,
        height: 700,
        id: 'running',
      });
      const cancelRunning = element(runningReport.report, 'cancel')?.enabled === true;
      const cancelledReport = capture(workingDirectory, built.binary, {
        state: 'cancelled',
        width: 900,
        height: 700,
        id: 'cancelled',
      });
      const disabledReport = capture(workingDirectory, built.binary, {
        state: 'disabled',
        width: 900,
        height: 700,
        id: 'disabled',
      });
      const cancelCancelled = element(cancelledReport.report, 'cancel')?.enabled === true;
      const primaryDisabled = element(disabledReport.report, 'primary-action')?.enabled === true;
      const jobState =
        correctStatuses(report) &&
        distinct.size >= 8 &&
        cancelRunning &&
        !cancelCancelled &&
        !primaryDisabled &&
        wrongStates.length === 0;
      add(
        'desktop-native-job-state',
        jobState,
        `statuses ${String(wrongStates.length)} wrong (${wrongStates.join(', ') || 'none'}), distinct=${String(distinct.size)}, cancel-in-running=${String(cancelRunning)}, cancel-after-cancel=${String(cancelCancelled)}, start-when-disabled=${String(primaryDisabled)}`,
        true,
      );

      const focusReport = capture(workingDirectory, built.binary, {
        state: 'stale-or-error',
        width: 900,
        height: 700,
        id: 'focus',
      });
      const focused = focusReport.report?.firstResponder ?? 'window';
      const focusedElement = element(focusReport.report, focused);
      const focusCorrect =
        focused === 'retry' && focusedElement?.focused === true && focusedElement?.enabled === true;
      add(
        'desktop-native-input-focus',
        focusCorrect,
        `window first responder is ${JSON.stringify(focused)} for the error state; the retry control is marked focused=${String(focusedElement?.focused ?? false)} and enabled=${String(focusedElement?.enabled ?? false)}`,
        true,
      );

      // The narrow captures run in a state where starting a job is legitimate, so a
      // disabled primary action there is a real regression rather than the state's own rule.
      const narrow = capture(workingDirectory, built.binary, {
        state: 'partial',
        width: 640,
        height: 420,
        id: 'narrow',
      });
      const scaled = capture(workingDirectory, built.binary, {
        state: 'partial',
        width: 640,
        height: 420,
        scale: 1.35,
        id: 'scaled',
      });
      const outsideWide = insideBounds(report ?? {});
      const outsideNarrow = insideBounds(narrow.report ?? {});
      const outsideScaled = insideBounds(scaled.report ?? {});
      const primaryNarrow = element(narrow.report, 'primary-action');
      const primaryVisible =
        Boolean(primaryNarrow) &&
        (primaryNarrow?.width ?? 0) >= 80 &&
        (primaryNarrow?.height ?? 0) >= 24 &&
        (primaryNarrow?.enabled ?? false);
      const statusNarrow = element(narrow.report, 'status');
      const overlap = overlaps(element(narrow.report, 'primary-action'), statusNarrow);
      const resizeOk =
        outsideWide.length === 0 &&
        outsideNarrow.length === 0 &&
        outsideScaled.length === 0 &&
        primaryVisible &&
        !overlap;
      add(
        'desktop-native-resize-scaling',
        resizeOk,
        `outside bounds: wide=${outsideWide.join('; ') || 'none'}, 640x420=${outsideNarrow.join('; ') || 'none'}, 640x420@1.35=${outsideScaled.join('; ') || 'none'}; primary visible=${String(primaryVisible)}, overlaps status=${String(overlap)}`,
        true,
      );

      const persistPath = join(workingDirectory, '.restore.json');
      const first = capture(workingDirectory, built.binary, {
        state: 'recovered',
        width: 900,
        height: 700,
        persist: persistPath,
        id: 'persist',
      });
      const second = capture(workingDirectory, built.binary, {
        state: 'idle',
        width: 900,
        height: 700,
        persist: persistPath,
        id: 'restore',
      });
      const durable = first.report?.saved ?? {};
      const restoredState = second.report?.states?.[durable.lastState ?? ''] ?? '';
      const restoration =
        first.ok &&
        second.ok &&
        second.report?.restored === true &&
        Object.keys(durable).length >= 3 &&
        typeof durable.lastState === 'string' &&
        durable.windowWidth !== undefined &&
        durable.windowHeight !== undefined &&
        restoredState.length > 0;
      add(
        'desktop-native-restoration-proof',
        restoration,
        `first launch persisted ${String(Object.keys(durable).length)} durable keys (${Object.keys(durable).join(', ') || 'none'}); second launch restored=${String(second.report?.restored)} with state text ${JSON.stringify(restoredState)}`,
        true,
      );

      const artifact = readJsonArtifact<DesktopResult>(
        workingDirectory,
        'verification/desktop-result.json',
      );
      const matrix = artifact?.stateMatrix ?? {};
      const artifactAgrees = NATIVE_INTERFACE_REQUIRED_STATES.every(
        (id) => typeof matrix[id] === 'string' && matrix[id] === report?.states?.[id],
      );
      const artifactOk =
        artifact?.status === 'verified' &&
        artifact?.platform === 'macos-appkit' &&
        artifact?.editor === 'OperationsModel.swift' &&
        artifactAgrees &&
        (artifact?.restoration?.durable ?? []).length >= 3 &&
        (artifact?.excludedBrowserPatterns ?? []).length >= 3;
      add(
        'verification artifact matches the window',
        artifactOk,
        artifactOk
          ? 'state matrix and restoration match the measured window'
          : `artifact status=${String(artifact?.status)} matrix-agrees=${String(artifactAgrees)} durable=${String((artifact?.restoration?.durable ?? []).length)} excluded=${String((artifact?.excludedBrowserPatterns ?? []).length)}`,
      );

      return finishChecks(checks);
    },
  },
];

function correctStatuses(report: CaptureReport | null): boolean {
  const states = report?.states ?? {};
  return Object.keys(states).length === NATIVE_INTERFACE_REQUIRED_STATES.length;
}

/** Bounded helper kept for callers that want the same runner semantics as the
 * other real-runtime fixtures. */
export const runNativeInterfaceBounded = runBounded;
