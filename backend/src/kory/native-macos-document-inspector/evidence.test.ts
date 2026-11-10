import { describe, expect, test } from 'bun:test';
import { describeNativeObservationChange } from './qualification';
import {
  METADATA_IDS,
  assessNativeRedGreen,
  checkCrossStateEvidence,
  inspectNativeEvidence,
  nativeInspectorMatrix,
  nativeInspectorResizeMatrix,
  stateId,
  type AccessibleElement,
  type InspectorState,
  type NativeCapture,
  type NativeImageObservation,
  type NativeObservation,
} from './evidence';

function state(overrides: Partial<InspectorState> = {}): InspectorState {
  return {
    revision: 1,
    width: 900,
    height: 700,
    appearance: 'light',
    language: 'en',
    content: 'normal',
    textSize: 'standard',
    ...overrides,
  };
}

function element(
  identifier: string,
  x: number,
  y: number,
  width: number,
  height = 20,
  value = '',
): AccessibleElement {
  return {
    identifier,
    role: 'AXStaticText',
    title: '',
    value,
    geometry: { x, y, width, height },
  };
}

function observation(config: InspectorState): NativeObservation {
  const x = 40;
  const y = 80;
  const sidebar = config.width === 620 ? 190 : config.width === 900 ? 230 : 260;
  const labelWidth = config.width === 620 ? 120 : config.width === 900 ? 170 : 205;
  const metaX = x + sidebar + 24;
  const german = config.language === 'de';
  const toolbar = [
    element(
      'toolbar.title',
      x + 17,
      y + 42,
      170,
      25,
      german
        ? config.width === 620
          ? 'Dokumente'
          : 'Dokumenteneigenschaften'
        : 'Document Inspector',
    ),
    element(
      'toolbar.import',
      x + config.width - 165,
      y + 42,
      65,
      20,
      german ? 'Importieren' : 'Import',
    ),
    element('toolbar.share', x + config.width - 82, y + 42, 62, 20, german ? 'Teilen' : 'Share'),
  ];
  const documentNames = german
    ? [
        'Jahresabschluss und Geschäftsbericht',
        'Strategische Produktentwicklungsplanung',
        'Dokument mit ausführlicher Gestaltungsspezifikation',
      ]
    : ['Annual report', 'Roadmap', 'Design brief'];
  const document = [
    element('sidebar.heading', x + 14, y + 115, 90, 18, german ? 'DOKUMENTE' : 'DOCUMENTS'),
    ...[0, 1, 2].map((n) =>
      element(
        `sidebar.document.${n}`,
        x + 14,
        y + 150 + n * 30,
        sidebar - 28,
        20,
        documentNames[n],
      ),
    ),
    element(
      'inspector.heading',
      metaX,
      y + 120,
      180,
      config.textSize === 'large' ? 30 : 25,
      german ? 'Dokumentdetails und Eigenschaften' : 'Document details',
    ),
    element(
      'inspector.context',
      metaX,
      y + 164,
      260,
      18,
      `${config.language}-${config.appearance} · ${config.content} · ${config.textSize}`,
    ),
  ];
  if (config.content === 'empty') {
    document.push(
      element(
        'inspector.empty',
        metaX,
        y + 210,
        190,
        20,
        german ? 'Kein Dokument ausgewählt' : 'No document selected',
      ),
    );
  } else {
    const keys = config.content === 'max' ? METADATA_IDS : METADATA_IDS.slice(0, 6);
    document.push(
      ...keys.flatMap((key, i) => [
        element(
          `metadata.${key}.label`,
          metaX,
          y + 210 + i * 52,
          labelWidth,
          config.language === 'de' && config.width === 620 ? 42 : 20,
        ),
        element(`metadata.${key}.value`, metaX + labelWidth + 12, y + 210 + i * 52, 80),
      ]),
    );
  }
  return {
    pid: 200,
    windowNumber: 300,
    window: { x, y, width: config.width, height: config.height },
    accessibilityTrusted: true,
    accessibilityWindowFound: true,
    errors: [],
    elements: [...toolbar, ...document],
  };
}

function pixels(config: InspectorState): NativeImageObservation {
  return {
    pixelsWide: config.width * 2,
    pixelsHigh: config.height * 2,
    sampledPoints: 6000,
    distinctColors: 120,
    luminanceRange: 0.83,
    meanLuminance: config.appearance === 'light' ? 0.78 : 0.25,
    meanReferenceDifference: null,
  };
}

describe('native macOS inspector evidence contract (pure logic, not runtime qualification)', () => {
  test('stabilization diagnostics distinguish removed, added, changed, and reordered real AX elements', () => {
    const before = observation(state());
    const after = structuredClone(before);
    after.window!.y += 5;
    after.elements[0]!.geometry!.x += 3;
    after.elements.splice(1, 1);
    after.elements.push(element('inspector.new-field', 400, 200, 120));

    const difference = describeNativeObservationChange(before, after);
    expect(difference.previousWindow!.y).toBe(80);
    expect(difference.currentWindow!.y).toBe(85);
    expect(difference.changedElements).toEqual(['toolbar.title']);
    expect(difference.removedElements).toEqual(['toolbar.import']);
    expect(difference.addedElements).toEqual(['inspector.new-field']);
    expect(difference.elementOrderChanged).toBe(true);
    expect(
      describeNativeObservationChange(before, structuredClone(before)).elementOrderChanged,
    ).toBe(false);
  });

  test('enumerates all 72 required native states and three sequential resize transitions', () => {
    const states = nativeInspectorMatrix();
    expect(states).toHaveLength(72);
    expect(new Set(states.map(stateId)).size).toBe(72);
    expect(new Set(states.map((s) => `${s.width}x${s.height}`))).toEqual(
      new Set(['620x520', '900x700', '1400x900']),
    );
    const resize = nativeInspectorResizeMatrix();
    expect(resize.map((s) => `${s.width}x${s.height}`)).toEqual(['1400x900', '620x520', '900x700']);
    expect(resize.map((s) => s.revision)).toEqual([73, 74, 75]);
  });

  test('correctly shaped independent observations can pass geometry checks', () => {
    for (const config of [
      state(),
      state({ width: 620, height: 520, language: 'de', content: 'max', textSize: 'large' }),
      state({ width: 1400, height: 900, appearance: 'dark', content: 'empty' }),
    ]) {
      expect(inspectNativeEvidence(config, observation(config), pixels(config))).toEqual([]);
    }
  });

  test('collapsed window and offscreen native controls are detected even with a nonblank PNG', () => {
    const config = state();
    const measure = observation(config);
    measure.window!.height = 97;
    measure.elements.find((e) => e.identifier === 'inspector.heading')!.geometry!.y = -73;
    const failures = inspectNativeEvidence(config, measure, pixels(config));
    expect(failures.join(' ')).toContain('native-window-size-900x97');
    expect(failures.join(' ')).toContain('inspector.heading-stranded-outside-native-window');
    expect(failures.join(' ')).toContain('screenshot-window-dimension-mismatch');
  });

  test('fault controls report native horizontal overlap and clipping', () => {
    const config = state({ width: 620, height: 520, language: 'de', content: 'max' });
    const measure = observation(config);
    measure.elements.find((e) => e.identifier === 'metadata.name.label')!.geometry!.width = 280;
    measure.elements.find((e) => e.identifier === 'metadata.name.value')!.geometry = {
      x: 460,
      y: 290,
      width: 265,
      height: 20,
    };
    const failures = inspectNativeEvidence(config, measure, pixels(config));
    expect(failures.some((issue) => issue.endsWith('metadata-name-horizontal-overlap'))).toBe(true);
    expect(
      failures.some((issue) => issue.endsWith('metadata.name.value-inspector-horizontal-clipping')),
    ).toBe(true);
  });

  test('blank PNG and missing native Accessibility always fail', () => {
    const config = state();
    const image = pixels(config);
    image.distinctColors = 1;
    image.luminanceRange = 0;
    const measure = observation(config);
    measure.accessibilityWindowFound = false;
    measure.errors.push('AX window unavailable');
    expect(inspectNativeEvidence(config, measure, image).join(' ')).toContain(
      'blank-or-unverified-native-screenshot',
    );
    expect(inspectNativeEvidence(config, measure, image).join(' ')).toContain(
      'independent-accessibility-unavailable',
    );
    expect(inspectNativeEvidence(config, measure, null).join(' ')).toContain(
      'blank-or-unverified-native-screenshot',
    );
  });

  test('missing German wrap or actual selected-state elements fails', () => {
    const config = state({ width: 620, height: 520, language: 'de', content: 'max' });
    const measure = observation(config);
    measure.elements.find((e) => e.identifier === 'metadata.name.label')!.geometry!.height = 20;
    measure.elements = measure.elements.filter((e) => e.identifier !== 'metadata.notes.value');
    const failures = inspectNativeEvidence(config, measure, pixels(config));
    expect(failures.join(' ')).toContain('long-german-label-not-wrapped');
    expect(failures.join(' ')).toContain('missing-native-accessibility-metadata.notes.value');
  });

  test('native accessibility names and row layout are checked rather than trusting the requested language', () => {
    const config = state({ width: 620, height: 520, language: 'de', content: 'max' });
    const measure = observation(config);
    measure.elements.find((e) => e.identifier === 'toolbar.import')!.value = 'Import';
    measure.elements.find((e) => e.identifier === 'sidebar.document.1')!.value = '...';
    measure.elements.find((e) => e.identifier === 'inspector.heading')!.value = 'Document details';
    measure.elements.find((e) => e.identifier === 'metadata.owner.label')!.geometry!.y = 300;
    measure.elements.find((e) => e.identifier === 'metadata.owner.value')!.geometry!.y = 300;
    measure.elements.push({ ...measure.elements[0]! });
    const failures = inspectNativeEvidence(config, measure, pixels(config)).join(' ');
    expect(failures).toContain('toolbar-localization-not-rendered');
    expect(failures).toContain('sidebar-document-1-name-truncated');
    expect(failures).toContain('inspector-localization-not-rendered');
    expect(failures).toContain('metadata-owner-vertical-overlap');
    expect(failures).toContain('duplicate-native-accessibility-identifiers');
  });

  test('native red/green assessment demands the exact ordered matrix and real fault-specific clipping', () => {
    const captures = [...nativeInspectorMatrix(), ...nativeInspectorResizeMatrix()].map(
      (config): NativeCapture => ({
        state: config,
        captureId:
          config.revision > 72 ? `resize-${config.revision}-${stateId(config)}` : stateId(config),
        screenshot: '/test-fixture/example.png',
        sha256: (config.appearance === 'light' ? 'a' : 'b').repeat(64),
        stabilizationSamples: 2,
        observation: observation(config),
        image: pixels(config),
        failures: [],
      }),
    );
    const faultState = state({
      width: 620,
      height: 520,
      language: 'de',
      content: 'max',
      appearance: 'dark',
      textSize: 'large',
    });
    const brokenObservation = observation(faultState);
    const brokenValue = brokenObservation.elements.find(
      (row) => row.identifier === 'metadata.name.value',
    )!;
    brokenValue.geometry = { ...brokenValue.geometry!, x: 590, width: 265 };
    const fault: NativeCapture = {
      state: faultState,
      captureId: `fault-${stateId(faultState)}`,
      screenshot: '/test-fixture/fault.png',
      sha256: 'c'.repeat(64),
      stabilizationSamples: 2,
      observation: brokenObservation,
      image: pixels(faultState),
      failures: inspectNativeEvidence(faultState, brokenObservation, pixels(faultState)),
    };
    const nominal = assessNativeRedGreen(captures, fault);
    expect(nominal.red).toBe(true);
    expect(nominal.green).toBe(true);
    expect(nominal.failures).toEqual([]);
    expect(assessNativeRedGreen(captures, null).red).toBe(false);
    captures[0]!.stabilizationSamples = 1;
    expect(assessNativeRedGreen(captures, fault).failures.join(' ')).toContain(
      'native-layout-stabilization-not-observed',
    );
    captures[0]!.stabilizationSamples = 2;
    captures[74]!.captureId = captures[73]!.captureId;
    const mismatched = assessNativeRedGreen(captures, fault);
    expect(mismatched.green).toBe(false);
    expect(mismatched.failures.join(' ')).toContain('native-matrix-state-75-missing-or-mismatched');
    captures[74]!.captureId = `resize-75-${stateId(captures[74]!.state)}`;
    fault.failures = [
      '620x520-dark-de-max-large:blank-or-unverified-native-screenshot',
      '620x520-dark-de-max-large:metadata.name.value-inspector-horizontal-clipping',
    ];
    expect(assessNativeRedGreen(captures, fault).red).toBe(false);
  });

  test('cross-state claims require native pixels to change and text geometry to increase', () => {
    const configs = [state(), state({ appearance: 'dark' }), state({ textSize: 'large' })];
    const captures = configs.map((config): NativeCapture => ({
      state: config,
      captureId: stateId(config),
      screenshot: '/native/example.png',
      sha256: config.appearance === 'dark' ? 'dark' : 'light',
      observation: observation(config),
      image: pixels(config),
      failures: [],
    }));
    expect(checkCrossStateEvidence(captures).join(' ')).toContain(
      '620x520:required-comparison-captures-missing',
    );
    captures[1]!.sha256 = captures[0]!.sha256;
    captures[1]!.image.meanLuminance = captures[0]!.image.meanLuminance;
    expect(checkCrossStateEvidence(captures).join(' ')).toContain(
      '900x700:light-dark-native-render-not-distinct',
    );
    captures[1]!.sha256 = 'dark';
    captures[1]!.image.meanLuminance = 0.25;
    expect(checkCrossStateEvidence(captures).join(' ')).not.toContain(
      '900x700:light-dark-native-render-not-distinct',
    );
  });
});
