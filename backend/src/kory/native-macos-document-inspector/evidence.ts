/**
 * Native document-inspector measurement contract. Observations originate from a
 * separate macOS Accessibility/WindowServer process and an actual window PNG.
 * No source-level DOM simulation or model-authored measurement is accepted.
 */
export interface InspectorState {
  revision: number;
  width: 620 | 900 | 1400;
  height: 520 | 700 | 900;
  appearance: 'light' | 'dark';
  language: 'en' | 'de';
  content: 'normal' | 'empty' | 'max';
  textSize: 'standard' | 'large';
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccessibleElement {
  identifier: string;
  role: string;
  title: string;
  value: string;
  geometry: Rectangle | null;
}

export interface NativeObservation {
  pid: number;
  windowNumber: number;
  window: Rectangle | null;
  accessibilityTrusted: boolean;
  accessibilityWindowFound: boolean;
  elements: AccessibleElement[];
  errors: string[];
}

export interface NativeImageObservation {
  pixelsWide: number;
  pixelsHigh: number;
  sampledPoints: number;
  distinctColors: number;
  luminanceRange: number;
  meanLuminance: number;
  meanReferenceDifference: number | null;
}

export interface NativeCapture {
  state: InspectorState;
  captureId: string;
  screenshot: string;
  sha256: string;
  /** Count of independent native AX/WindowServer observations before capture. */
  stabilizationSamples?: number;
  observation: NativeObservation;
  image: NativeImageObservation;
  failures: string[];
}

export const NATIVE_INSPECTOR_SIZES = [
  { width: 620, height: 520 },
  { width: 900, height: 700 },
  { width: 1400, height: 900 },
] as const;

export const METADATA_IDS = [
  'name', 'owner', 'created', 'modified', 'type', 'access', 'location',
  'revision', 'review', 'retention', 'identifier', 'distribution', 'notes',
] as const;

export function stateId(state: InspectorState): string {
  return `${state.width}x${state.height}-${state.appearance}-${state.language}-${state.content}-${state.textSize}`;
}

/** Complete 3 x 2 x 2 x 3 x 2 native state matrix, plus resize samples. */
export function nativeInspectorMatrix(): InspectorState[] {
  const states: InspectorState[] = [];
  for (const size of NATIVE_INSPECTOR_SIZES) {
    for (const appearance of ['light', 'dark'] as const) {
      for (const language of ['en', 'de'] as const) {
        for (const content of ['normal', 'empty', 'max'] as const) {
          for (const textSize of ['standard', 'large'] as const) {
            states.push({ revision: states.length + 1, ...size, appearance, language, content, textSize });
          }
        }
      }
    }
  }
  return states;
}

export function nativeInspectorResizeMatrix(initialRevision = 72): InspectorState[] {
  const sizes = [
    { width: 1400, height: 900 },
    { width: 620, height: 520 },
    { width: 900, height: 700 },
  ] as const;
  return sizes.map((size, index): InspectorState => ({
    revision: initialRevision + index + 1, ...size,
    appearance: 'dark', language: 'de', content: 'max', textSize: 'large',
  }));
}

const geometryValid = (rect: Rectangle | null | undefined): rect is Rectangle =>
  !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
  rect.width > 0 && rect.height > 0;

/** An evaluator's measurements. Do not classify unobserved regions as clean. */
export function inspectNativeEvidence(
  state: InspectorState,
  observation: NativeObservation,
  image: NativeImageObservation | null,
): string[] {
  const issues: string[] = [];
  const fault = (key: string): void => { issues.push(`${stateId(state)}:${key}`); };
  const win = observation.window;
  if (!geometryValid(win) || observation.windowNumber < 1 || observation.pid < 1) {
    fault('windowserver-window-missing');
  } else if (Math.abs(win.width - state.width) > 3 || Math.abs(win.height - state.height) > 3) {
    fault(`native-window-size-${Math.round(win.width)}x${Math.round(win.height)}`);
  }
  if (!observation.accessibilityTrusted || !observation.accessibilityWindowFound || observation.errors.length) {
    fault('independent-accessibility-unavailable');
  }
  if (!image || image.sampledPoints < 100 || image.distinctColors < 10 || image.luminanceRange < 0.12) {
    fault('blank-or-unverified-native-screenshot');
  }
  if (geometryValid(win) && image) {
    const scaleX = image.pixelsWide / win.width;
    const scaleY = image.pixelsHigh / win.height;
    if (scaleX < 0.85 || scaleX > 3.2 || Math.abs(scaleX - scaleY) > 0.13) {
      fault('screenshot-window-dimension-mismatch');
    }
  }

  const elements = new Map(observation.elements.map((row) => [row.identifier, row]));
  if (elements.size !== observation.elements.length) fault('duplicate-native-accessibility-identifiers');
  const accessibleText = (element: AccessibleElement | null): string =>
    element?.value || element?.title || '';
  function required(id: string): AccessibleElement | null {
    const element = elements.get(id);
    if (!element || !geometryValid(element.geometry)) {
      fault(`missing-native-accessibility-${id}`);
      return null;
    }
    return element;
  }
  const toolbarTitle = required('toolbar.title');
  const importButton = required('toolbar.import');
  const shareButton = required('toolbar.share');
  const sidebarHeading = required('sidebar.heading');
  const documentButtons = [0, 1, 2].map((index) => required(`sidebar.document.${index}`));
  const heading = required('inspector.heading');
  const context = required('inspector.context');
  if (accessibleText(context) !== `${state.language}-${state.appearance} · ${state.content} · ${state.textSize}`) {
    fault('accessibility-does-not-match-requested-state');
  }
  if (accessibleText(sidebarHeading) !== (state.language === 'de' ? 'DOKUMENTE' : 'DOCUMENTS')) {
    fault('german-localization-not-rendered');
  }
  const translated = state.language === 'de';
  const expectedTitle = translated ? (state.width === 620 ? 'Dokumente' : 'Dokumenteneigenschaften') : 'Document Inspector';
  if (accessibleText(toolbarTitle) !== expectedTitle ||
      accessibleText(importButton) !== (translated ? 'Importieren' : 'Import') ||
      accessibleText(shareButton) !== (translated ? 'Teilen' : 'Share')) {
    fault('toolbar-localization-not-rendered');
  }
  if (accessibleText(heading) !== (translated ? 'Dokumentdetails und Eigenschaften' : 'Document details')) {
    fault('inspector-localization-not-rendered');
  }
  const expectedDocuments = translated ? [
    'Jahresabschluss und Geschäftsbericht',
    'Strategische Produktentwicklungsplanung',
    'Dokument mit ausführlicher Gestaltungsspezifikation',
  ] : ['Annual report', 'Roadmap', 'Design brief'];
  for (const [index, document] of documentButtons.entries()) {
    // Native visual ellipsis is allowed only when the full accessible name is preserved.
    if (accessibleText(document) !== expectedDocuments[index]) fault(`sidebar-document-${index}-name-truncated`);
  }
  if (state.content === 'empty') {
    const empty = required('inspector.empty');
    if (accessibleText(empty) !== (translated ? 'Kein Dokument ausgewählt' : 'No document selected')) {
      fault('empty-selection-localization-not-rendered');
    }
    if (observation.elements.some((item) => item.identifier.startsWith('metadata.'))) {
      fault('empty-selection-exposes-metadata');
    }
  } else {
    if (elements.has('inspector.empty')) fault('nonempty-selection-shows-empty-state');
    const keys = state.content === 'max' ? METADATA_IDS : METADATA_IDS.slice(0, 6);
    let previousRowBottom = -Infinity;
    for (const key of keys) {
      const label = required(`metadata.${key}.label`);
      const value = required(`metadata.${key}.value`);
      if (!label?.geometry || !value?.geometry) continue;
      const rowTop = Math.min(label.geometry.y, value.geometry.y);
      const rowBottom = Math.max(
        label.geometry.y + label.geometry.height, value.geometry.y + value.geometry.height,
      );
      if (rowTop < previousRowBottom - 2) fault(`metadata-${key}-vertical-overlap`);
      previousRowBottom = rowBottom;
      if (label.geometry.x + label.geometry.width + 5 > value.geometry.x) {
        fault(`metadata-${key}-horizontal-overlap`);
      }
      if (Math.abs(label.geometry.y - value.geometry.y) > 28) {
        fault(`metadata-${key}-row-alignment`);
      }
    }
    if (state.language === 'de' && state.width === 620) {
      const name = elements.get('metadata.name.label');
      if (name?.geometry && name.geometry.height < 28) fault('long-german-label-not-wrapped');
    }
  }

  if (geometryValid(win)) {
    const right = win.x + win.width;
    const left = win.x;
    const bottom = win.y + win.height;
    const sidebarRight = left + (state.width === 620 ? 190 : state.width === 900 ? 230 : 260);
    const inside = (rect: Rectangle, minX: number, maxX: number): boolean =>
      rect.x >= minX - 4 && rect.x + rect.width <= maxX + 4;
    for (const element of observation.elements) {
      if (!geometryValid(element.geometry)) continue;
      const id = element.identifier;
      if (id.startsWith('metadata.') || id.startsWith('inspector.')) {
        if (!inside(element.geometry, sidebarRight + 2, right - 6)) {
          fault(`${id}-inspector-horizontal-clipping`);
        }
      } else if (id.startsWith('sidebar.')) {
        if (!inside(element.geometry, left + 2, sidebarRight - 2)) {
          fault(`${id}-sidebar-horizontal-clipping`);
        }
      } else if (id.startsWith('toolbar.')) {
        if (!inside(element.geometry, left + 4, right - 4)) fault(`${id}-toolbar-clipping`);
      }
      if ((id === 'inspector.heading' || id === 'inspector.context') &&
          (element.geometry.y < win.y + 50 || element.geometry.y + element.geometry.height > bottom - 4)) {
        fault(`${id}-stranded-outside-native-window`);
      }
      if ((id.startsWith('toolbar.') || id.startsWith('sidebar.')) &&
          (element.geometry.y < win.y - 4 || element.geometry.y + element.geometry.height > bottom + 4)) {
        fault(`${id}-outside-native-window`);
      }
    }
    if (toolbarTitle?.geometry && importButton?.geometry &&
        toolbarTitle.geometry.x + toolbarTitle.geometry.width + 8 > importButton.geometry.x) {
      fault('toolbar-title-overlaps-import');
    }
    if (importButton?.geometry && shareButton?.geometry &&
        importButton.geometry.x + importButton.geometry.width + 4 > shareButton.geometry.x) {
      fault('toolbar-actions-overlap');
    }
    if (heading?.geometry && heading.geometry.x <= sidebarRight) fault('sidebar-inspector-overlap');
  }
  return [...new Set(issues)];
}

export interface NativeRedGreenAssessment {
  red: boolean;
  green: boolean;
  failures: string[];
}

/**
 * Qualification requires native observations; this function only validates
 * their shape and their measured verdicts. It never synthesizes observations.
 */
export function assessNativeRedGreen(
  captures: readonly NativeCapture[],
  faultCapture: NativeCapture | null,
): NativeRedGreenAssessment {
  const failures: string[] = [];
  const expected = [...nativeInspectorMatrix(), ...nativeInspectorResizeMatrix()];
  if (captures.length !== expected.length) {
    failures.push(`native-matrix-count-${captures.length}-expected-${expected.length}`);
  }
  const identities = new Set<string>();
  for (let i = 0; i < expected.length; i++) {
    const actual = captures[i];
    const state = expected[i]!;
    const expectedId = i >= 72 ? `resize-${state.revision}-${stateId(state)}` : stateId(state);
    if (!actual || actual.captureId !== expectedId ||
        JSON.stringify(actual.state) !== JSON.stringify(state)) {
      failures.push(`native-matrix-state-${i + 1}-missing-or-mismatched`);
      continue;
    }
    if (identities.has(actual.captureId)) failures.push(`native-matrix-duplicate-${actual.captureId}`);
    identities.add(actual.captureId);
    if (!/^[a-f0-9]{64}$/u.test(actual.sha256) || !actual.screenshot.endsWith('.png')) {
      failures.push(`${actual.captureId}:missing-capture-integrity`);
    }
    if ((actual.stabilizationSamples ?? 0) < 2) {
      failures.push(`${actual.captureId}:native-layout-stabilization-not-observed`);
    }
    failures.push(...actual.failures);
  }
  failures.push(...checkCrossStateEvidence(captures));
  const fatalFault = faultCapture?.failures.some((failure) =>
    /(?:independent-accessibility-unavailable|blank-or-unverified-native-screenshot|windowserver-window-missing|screenshot-window-dimension-mismatch)/u.test(failure)) ?? true;
  const red = !!faultCapture &&
    stateId(faultCapture.state) === '620x520-dark-de-max-large' &&
    faultCapture.captureId === 'fault-620x520-dark-de-max-large' &&
    /^[a-f0-9]{64}$/u.test(faultCapture.sha256) &&
    (faultCapture.stabilizationSamples ?? 0) >= 2 &&
    !fatalFault &&
    faultCapture.failures.some((failure) =>
      /(?:metadata-.*horizontal-overlap|metadata\..*-inspector-horizontal-clipping)/u.test(failure));
  if (!red) failures.push('Native fault screenshot did not prove the expected metadata overflow');
  const green = captures.length === expected.length &&
    failures.every((failure) => failure === 'Native fault screenshot did not prove the expected metadata overflow');
  return { red, green, failures };
}

export function checkCrossStateEvidence(captures: readonly NativeCapture[]): string[] {
  const failures: string[] = [];
  const byId = new Map(captures.map((item) => [item.captureId, item]));
  for (const size of NATIVE_INSPECTOR_SIZES) {
    const base = `${size.width}x${size.height}`;
    const light = byId.get(`${base}-light-en-normal-standard`);
    const dark = byId.get(`${base}-dark-en-normal-standard`);
    const large = byId.get(`${base}-light-en-normal-large`);
    if (!light || !dark || !large) {
      failures.push(`${base}:required-comparison-captures-missing`);
      continue;
    }
    if (light.sha256 === dark.sha256 ||
        Math.abs(light.image.meanLuminance - dark.image.meanLuminance) < 0.06) {
      failures.push(`${base}:light-dark-native-render-not-distinct`);
    }
    const normalHeading = light.observation.elements.find((e) => e.identifier === 'inspector.heading');
    const largeHeading = large.observation.elements.find((e) => e.identifier === 'inspector.heading');
    if (!normalHeading?.geometry || !largeHeading?.geometry ||
        largeHeading.geometry.height <= normalHeading.geometry.height) {
      failures.push(`${base}:enlarged-text-not-observed`);
    }
  }
  return failures;
}
