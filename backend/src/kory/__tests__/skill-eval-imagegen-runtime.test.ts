import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  IMAGEGEN_BRAND,
  IMAGEGEN_CONSTRAINTS,
  IMAGEGEN_SCORERS,
  decodePng,
  imagegenMaterialize,
  imagegenRuntimeReadiness,
  measureImage,
  parseHexColor,
  runImagegenScenario,
} from '../../eval/skills/skill-eval-imagegen-runtime';

/**
 * The measurable half of this fixture must be exact without any network, and the
 * rendering half must be graded on bytes that came back from the live service.
 * Both are covered here: a hand-built PNG pins the decoder and the measurements,
 * and the reference specs pin the behaviour of the real renders.
 */

const BACKGROUND = parseHexColor(IMAGEGEN_BRAND.background);
const ACCENT = parseHexColor(IMAGEGEN_BRAND.accent);
const FORBIDDEN = parseHexColor(IMAGEGEN_BRAND.forbidden);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Build a flat background with one centred square, as a real PNG. */
function syntheticPng(options: { width: number; height: number; markShare: number; markColor: ReturnType<typeof parseHexColor> }): Buffer {
  const { width, height, markShare, markColor } = options;
  const side = Math.max(2, Math.round(Math.sqrt(width * height * markShare)));
  const startX = Math.round((width - side) / 2);
  const startY = Math.round((height - side) / 2);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const inside = x >= startX && x < startX + side && y >= startY && y < startY + side;
      const color = inside ? markColor : BACKGROUND;
      raw[offset++] = color.r;
      raw[offset++] = color.g;
      raw[offset++] = color.b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function workspace(scenario: 1 | 2): string {
  const root = mkdtempSync(join(tmpdir(), `kory-imagegen-${scenario}-`));
  roots.push(root);
  imagegenMaterialize(root, scenario);
  return root;
}

const FLAT = (extra: string) =>
  `flat vector illustration, solid warm off-white #F2EFE9 background, one solid orange #E8552D geometric mark centred, ${extra}, no text, no gradient, no shadow, no texture, no green`;

const IDENTITY = IMAGEGEN_BRAND.identity;

const SCENARIO_1_SPEC = {
  model: 'flux-2-klein-4b',
  identity: IDENTITY,
  variants: [
    { seed: 901, prompt: FLAT('generous empty margins all around'), size: '1024x1024' },
    { seed: 902, prompt: FLAT('very wide clean margins'), size: '1024x1024' },
  ],
};

const SCENARIO_2_SPEC = {
  model: 'flux-2-klein-4b',
  identity: IDENTITY,
  assets: [
    {
      id: 'hero',
      description: 'hero render',
      variants: [
        { seed: 911, prompt: `${IDENTITY}; flat vector hero image, solid #F2EFE9 background, one orange #E8552D mark centred with wide empty margins, no text, no green, no gradient`, size: '1024x1024' },
        { seed: 912, prompt: `${IDENTITY}; flat vector hero image, solid #F2EFE9 background, single orange #E8552D mark centred, generous clean margins, no text, no green`, size: '1024x1024' },
      ],
    },
    {
      id: 'avatar',
      description: 'avatar render',
      variants: [
        { seed: 913, prompt: `${IDENTITY}; flat vector avatar, solid #F2EFE9 background, orange #E8552D mark filling most of the frame, close crop, no text, no green`, size: '1024x1024' },
        { seed: 914, prompt: `${IDENTITY}; flat vector avatar close-up, solid #F2EFE9 background, large orange #E8552D mark centred and prominent, no text, no green`, size: '1024x1024' },
      ],
    },
    {
      id: 'footer-card',
      description: 'footer card render',
      variants: [
        { seed: 915, prompt: `${IDENTITY}; bottom-anchored composition: large orange #E8552D mark in the lower part of a solid #F2EFE9 canvas, 60 percent empty background above it, flat vector, no text, no green`, size: '1024x1024' },
        { seed: 916, prompt: `${IDENTITY}; flat vector layout, solid #F2EFE9 background, one big orange #E8552D circle positioned at the bottom centre of the canvas, empty space above, no text, no green`, size: '1024x1024' },
      ],
    },
  ],
};

describe('image generation measurement', () => {
  test('a flat frame decodes to the palette and coverage the brief asks for', () => {
    const image = decodePng(syntheticPng({ width: 128, height: 128, markShare: 0.1, markColor: ACCENT }));
    const measurements = measureImage(image, BACKGROUND, ACCENT, FORBIDDEN);
    expect(measurements.width).toBe(128);
    expect(measurements.height).toBe(128);
    expect(measurements.paletteColors95).toBe(2);
    expect(measurements.backgroundShare).toBeCloseTo(0.9, 2);
    expect(measurements.accentShare).toBeCloseTo(0.1, 2);
    expect(measurements.cornerMaxSpread).toBe(0);
    expect(measurements.subjectBorderShare).toBe(0);
    expect(measurements.forbiddenShare).toBe(0);
    expect(measurements.subjectCentroidX).toBeCloseTo(0.5, 2);
  }, 30_000);

  test('a textured frame fails the palette and border limits that a flat frame meets', () => {
    const width = 128;
    const height = 128;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    let offset = 0;
    for (let y = 0; y < height; y++) {
      raw[offset++] = 0;
      for (let x = 0; x < width; x++) {
        raw[offset++] = (x * 7 + y * 13) & 0xff;
        raw[offset++] = (x * 3 + y * 29) & 0xff;
        raw[offset++] = (x * 17 + y * 5) & 0xff;
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const measurements = measureImage(decodePng(png), BACKGROUND, ACCENT, FORBIDDEN);
    expect(measurements.paletteColors95).toBeGreaterThan(IMAGEGEN_CONSTRAINTS.paletteColors95);
    expect(measurements.backgroundShare).toBeLessThan(IMAGEGEN_CONSTRAINTS.backgroundShare);
    expect(measurements.subjectBorderShare).toBeGreaterThan(IMAGEGEN_CONSTRAINTS.borderShare);
  }, 30_000);

  test('the scorers are registered for exactly the two image-generation scenarios', () => {
    expect(IMAGEGEN_SCORERS.map((scorer) => scorer.scenarioIds).flat()).toEqual([
      'image-generation-practice-full-task-1-individual',
      'image-generation-practice-full-task-2-individual',
    ]);
  });
});

describe('image generation against the live model', () => {
  const skip = imagegenRuntimeReadiness().length > 0;

  test.skipIf(skip)(
    'the starter spec fails and a spec that states the palette passes every check',
    async () => {
      const root = workspace(1);
      const starter = await runImagegenScenario(root, 1);
      expect(starter.passed).toBe(false);
      expect(starter.checks.find((check) => check.id === 'contract')?.passed).toBe(false);

      writeFileSync(join(root, 'generation', 'spec.json'), JSON.stringify(SCENARIO_1_SPEC, null, 2));
      const result = await runImagegenScenario(root, 1);
      expect(result.checks.map((check) => check.id)).toEqual([
        'contract',
        'render',
        'palette',
        'layout',
        'accent',
        'variant-budget',
      ]);
      expect(result.passed).toBe(true);
    },
    600_000,
  );

  test.skipIf(skip)(
    'the asset set passes only when every prompt repeats the identity and each asset is composed for its slot',
    async () => {
      const root = workspace(2);
      const starter = await runImagegenScenario(root, 2);
      expect(starter.passed).toBe(false);
      expect(starter.checks.find((check) => check.id === 'identity-reuse')?.passed).toBe(false);

      writeFileSync(join(root, 'generation', 'spec.json'), JSON.stringify(SCENARIO_2_SPEC, null, 2));
      const result = await runImagegenScenario(root, 2);
      expect(result.checks.map((check) => check.id)).toEqual([
        'contract',
        'identity-reuse',
        'render-all',
        'palette',
        'accent',
        'composition-hero',
        'composition-avatar',
        'composition-card',
      ]);
      expect(result.passed).toBe(true);
    },
    900_000,
  );
});