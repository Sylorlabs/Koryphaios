/**
 * Image generation full-task runtime.
 *
 * The candidate does not describe an image, it produces a generation spec and
 * the harness executes that spec against a real image model. Every check is a
 * measurement on the bytes that came back: image size, background flatness,
 * accent coverage, subject placement, palette spread, and cross-asset palette
 * coherence. The image model is Logfare's, reached over HTTPS; the API key is
 * the same one the qualification executor uses.
 *
 * The service is stochastic, so nothing here asks for byte-identical output.
 * What is required is that a spec pins its model, size and seed, and that the
 * images it produces conform to the constraints every time the harness runs it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';

export const IMAGEGEN_SCENARIO_1 = 'image-generation-practice-full-task-1-individual';
export const IMAGEGEN_SCENARIO_2 = 'image-generation-practice-full-task-2-individual';

export const IMAGEGEN_MODELS = ['sdxl-lightning', 'flux-1-schnell', 'flux-2-klein-4b'] as const;
/** Only this model honours a requested canvas size, so a sized asset must use it. */
export const IMAGEGEN_SIZING_MODEL = 'sdxl-lightning';
const IMAGEGEN_ENDPOINT = 'https://logfare.ai/v1/images/generations';

export const IMAGEGEN_RUNTIME_BLOCKER =
  'Image generation runtime is unavailable (needs KORY_SKILL_EVAL_LOGFARE_API_KEY and sips for JPEG to PNG conversion)';

export function imagegenApiKey(): string | null {
  const key = process.env.KORY_SKILL_EVAL_LOGFARE_API_KEY?.trim() || process.env.KORY_LOGFARE_API_KEY?.trim();
  return key ? key : null;
}

export function imagegenRuntimeReadiness(): readonly string[] {
  const blockers: string[] = [];
  if (!imagegenApiKey()) blockers.push(`${IMAGEGEN_RUNTIME_BLOCKER}: no API key in the environment`);
  if (!existsSync('/usr/bin/sips')) blockers.push(`${IMAGEGEN_RUNTIME_BLOCKER}: /usr/bin/sips is missing`);
  return blockers;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHexColor(value: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/iu.exec(value.trim());
  if (!match) throw new Error(`not a hex colour: ${value}`);
  const int = Number.parseInt(match[1], 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

export interface DecodedImage {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}

/** Minimal PNG reader: 8-bit RGB or RGBA, non-interlaced. That is what sips
 * writes when it converts the JPEG the image service returns. */
export function decodePng(buffer: Buffer): DecodedImage {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colourType ${colorType}, interlace ${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? current[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      const value = line[index];
      let result: number;
      switch (filter) {
        case 0: result = value; break;
        case 1: result = value + left; break;
        case 2: result = value + up; break;
        case 3: result = value + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      current[index] = result & 0xff;
    }
    pixels.set(current, row * stride);
    previous = current;
  }
  return { width, height, channels, pixels };
}

export function pixelAt(image: DecodedImage, x: number, y: number): Rgb {
  const index = (y * image.width + x) * image.channels;
  return { r: image.pixels[index], g: image.pixels[index + 1], b: image.pixels[index + 2] };
}

export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

export interface ImageMeasurements {
  width: number;
  height: number;
  /** Mean colour and the spread of each corner patch. */
  cornerMean: Rgb;
  cornerMaxSpread: number;
  backgroundShare: number;
  accentShare: number;
  forbiddenShare: number;
  subjectCenterShare: number;
  subjectBorderShare: number;
  /** Mean position of non-background pixels, 0 to 1 on each axis. */
  subjectCentroidX: number;
  subjectCentroidY: number;
  paletteColors95: number;
}

const PATCH = 24;

export function measureImage(
  image: DecodedImage,
  background: Rgb,
  accent: Rgb,
  forbidden: Rgb,
): ImageMeasurements {
  const { width, height } = image;
  const total = width * height;
  const corners = [
    [0, 0],
    [width - PATCH, 0],
    [0, height - PATCH],
    [width - PATCH, height - PATCH],
  ] as const;
  let cornerR = 0;
  let cornerG = 0;
  let cornerB = 0;
  let cornerCount = 0;
  let cornerMaxSpread = 0;
  for (const [cornerX, cornerY] of corners) {
    let minL = 255;
    let maxL = 0;
    for (let y = cornerY; y < cornerY + PATCH; y++) {
      for (let x = cornerX; x < cornerX + PATCH; x++) {
        const pixel = pixelAt(image, x, y);
        cornerR += pixel.r;
        cornerG += pixel.g;
        cornerB += pixel.b;
        cornerCount++;
        const luma = 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b;
        if (luma < minL) minL = luma;
        if (luma > maxL) maxL = luma;
      }
    }
    cornerMaxSpread = Math.max(cornerMaxSpread, maxL - minL);
  }
  const cornerMean = {
    r: Math.round(cornerR / cornerCount),
    g: Math.round(cornerG / cornerCount),
    b: Math.round(cornerB / cornerCount),
  };

  const centerSide = 0.5;
  const border = 0.1;
  const centerX0 = width * ((1 - centerSide) / 2);
  const centerX1 = width - centerX0;
  const centerY0 = height * ((1 - centerSide) / 2);
  const centerY1 = height - centerY0;
  const borderX0 = width * border;
  const borderX1 = width - borderX0;
  const borderY0 = height * border;
  const borderY1 = height - borderY0;

  let backgroundPixels = 0;
  let accentPixels = 0;
  let forbiddenPixels = 0;
  let subjectCount = 0;
  let subjectX = 0;
  let subjectY = 0;
  let centerNonBackground = 0;
  let centerTotal = 0;
  let borderNonBackground = 0;
  let borderTotal = 0;
  const buckets = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = pixelAt(image, x, y);
      const isBackground = colorDistance(pixel, background) <= 40;
      if (isBackground) backgroundPixels++;
      else {
        subjectCount++;
        subjectX += x;
        subjectY += y;
      }
      if (colorDistance(pixel, accent) <= 48) accentPixels++;
      if (colorDistance(pixel, forbidden) <= 40) forbiddenPixels++;
      const inCenter = x >= centerX0 && x < centerX1 && y >= centerY0 && y < centerY1;
      const inBorder = x < borderX0 || x >= borderX1 || y < borderY0 || y >= borderY1;
      if (inCenter) {
        centerTotal++;
        if (!isBackground) centerNonBackground++;
      }
      if (inBorder) {
        borderTotal++;
        if (!isBackground) borderNonBackground++;
      }
      const quantized = ((pixel.r >> 3) << 10) | ((pixel.g >> 3) << 5) | (pixel.b >> 3);
      buckets.set(quantized, (buckets.get(quantized) ?? 0) + 1);
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => b - a);
  let running = 0;
  let paletteColors95 = 0;
  for (const count of sorted) {
    running += count;
    paletteColors95++;
    if (running / total >= 0.95) break;
  }

  return {
    width,
    height,
    cornerMean,
    cornerMaxSpread,
    backgroundShare: backgroundPixels / total,
    accentShare: accentPixels / total,
    forbiddenShare: forbiddenPixels / total,
    subjectCenterShare: centerTotal ? centerNonBackground / centerTotal : 0,
    subjectBorderShare: borderTotal ? borderNonBackground / borderTotal : 0,
    subjectCentroidX: subjectCount ? subjectX / subjectCount / width : 0.5,
    subjectCentroidY: subjectCount ? subjectY / subjectCount / height : 0.5,
    paletteColors95,
  };
}

export interface GeneratedImage {
  image: DecodedImage;
  bytes: Buffer;
  rawBase64: string;
}

/** Ask the image service for one image and decode it. */
export async function generateImage(request: {
  model: string;
  prompt: string;
  size: string;
  seed: number;
}): Promise<GeneratedImage> {
  const key = imagegenApiKey();
  if (!key) throw new Error(IMAGEGEN_RUNTIME_BLOCKER);
  let lastError: Error = new Error('image service was not called');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    try {
      const response = await fetch(IMAGEGEN_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          size: request.size,
          seed: request.seed,
          n: 1,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await response.json()) as {
        data?: { b64_json?: string }[];
        error?: { message?: string } | string;
      };
      const encoded = body.data?.[0]?.b64_json;
      if (!response.ok || !encoded) {
        const detail =
          typeof body.error === 'string' ? body.error : body.error?.message ?? 'no image data';
        lastError = new Error(`image service returned ${response.status}: ${detail}`);
        // 4xx other than rate limiting is a prompt or parameter problem, not a
        // transient one, so it is reported instead of retried.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw lastError;
        continue;
      }
      const bytes = Buffer.from(encoded, 'base64');
      return { image: decodePng(convertToPng(bytes)), bytes, rawBase64: encoded };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (/^image service returned 4(0[0-9]|[1-9][0-9])/u.test(lastError.message) && !/429/u.test(lastError.message)) {
        throw lastError;
      }
    }
  }
  throw lastError;
}

function convertToPng(jpeg: Buffer): Buffer {
  const work = join(process.env.TMPDIR ?? '/tmp', `kory-imagegen-${process.pid}-${Date.now()}.jpg`);
  const out = work.replace(/\.jpg$/u, '.png');
  try {
    writeFileSync(work, jpeg);
    const result = spawnSync('/usr/bin/sips', ['-s', 'format', 'png', '--out', out, work], {
      timeout: 60_000,
      maxBuffer: 1_000_000,
    });
    if (result.status !== 0 || !existsSync(out)) {
      throw new Error(`sips could not convert the image: ${String(result.stderr ?? '').slice(0, 200)}`);
    }
    return readFileSync(out);
  } finally {
    spawnSync('rm', ['-f', work, out], { timeout: 10_000 });
  }
}
/** The constraints both scenarios bind a candidate to. They live in the
 * materialized brief as well, so a candidate is never guessing at a hidden bar. */
export interface ImageConstraints {
  paletteColors95: number;
  backgroundShare: number;
  accentShare: number;
  cornerSpread: number;
  borderShare: number;
  forbiddenShare: number;
}

export const IMAGEGEN_CONSTRAINTS: ImageConstraints = {
  paletteColors95: 12,
  backgroundShare: 0.6,
  accentShare: 0.03,
  cornerSpread: 20,
  borderShare: 0.1,
  forbiddenShare: 0.01,
};

export interface ImageVariant {
  seed: number;
  prompt: string;
  size?: string;
  model?: string;
}

export interface ImageAsset {
  id: string;
  description: string;
  variants: ImageVariant[];
}

export interface ImageSpec {
  model?: string;
  identity?: string;
  variants?: ImageVariant[];
  assets?: ImageAsset[];
}

export const IMAGEGEN_BRAND = {
  background: '#F2EFE9',
  accent: '#E8552D',
  forbidden: '#1F7A3D',
  identity: 'Kory mark: a single solid circle with a flat notch at the top right',
} as const;

const SCENARIO_1_STARTER: ImageSpec = {
  model: IMAGEGEN_SIZING_MODEL,
  variants: [{ seed: 1, prompt: 'Apply image generation expertise to this task' }],
};

const SCENARIO_2_STARTER: ImageSpec = {
  model: IMAGEGEN_SIZING_MODEL,
  identity: 'kory mark',
  assets: [
    { id: 'avatar', description: 'round avatar of the mark', variants: [{ seed: 1, prompt: 'kory mark avatar', size: '512x512' }] },
    { id: 'hero', description: 'wide hero image of the mark', variants: [{ seed: 1, prompt: 'kory mark hero', size: '1536x512' }] },
    { id: 'footer-card', description: 'small footer card', variants: [{ seed: 1, prompt: 'kory mark footer card', size: '512x256' }] },
  ],
};


/** Measurements observed by the fixture author on the live service. They are
 * shipped so a candidate can see the shape of a passing and a failing result
 * without being able to call the API from the workspace. */
const IMAGEGEN_EXAMPLES = {
  note: 'Measured at 1024x1024 by the fixture author on the live service. Values are what the author observed, not synthetic numbers. Compare the model column before choosing a model.',
  examples: [
    {
      label: 'passing',
      model: 'flux-2-klein-4b',
      prompt: 'flat vector illustration, solid warm off-white #F2EFE9 background, one solid orange #E8552D geometric mark centred, generous empty margins all around, no text, no gradient, no shadow, no texture, no green',
      seed: 101,
      measurements: { paletteColors95: 3, backgroundShare: 0.95, accentShare: 0.047, cornerSpread: 8, subjectBorderShare: 0.0, forbiddenShare: 0.0 },
    },
    {
      label: 'fails-palette-and-layout',
      model: 'flux-2-klein-4b',
      prompt: 'a product hero image',
      seed: 72,
      measurements: { paletteColors95: 245, backgroundShare: 0.07, accentShare: 0.0, cornerSpread: 7, subjectBorderShare: 0.98, forbiddenShare: 0.0 },
    },
    {
      label: 'fails-accent',
      model: 'flux-2-klein-4b',
      prompt: 'a product hero image',
      seed: 73,
      measurements: { paletteColors95: 24, backgroundShare: 0.69, accentShare: 0.0, cornerSpread: 3, subjectBorderShare: 0.01, forbiddenShare: 0.0 },
    },
    {
      label: 'fails-on-a-latency-tuned-model',
      model: 'sdxl-lightning',
      prompt: 'flat vector illustration, solid warm off-white #F2EFE9 background, one solid orange #E8552D circle centred, generous empty margins, no text, no gradient, no shadow, no texture, no green',
      seed: 501,
      measurements: { paletteColors95: 802, backgroundShare: 0.21, accentShare: 0.309, cornerSpread: 6, subjectBorderShare: 0.79, forbiddenShare: 0.0 },
      note: 'The same prompt, seed and canvas on flux-2-klein-4b measured palette=5, background=0.90, border=0.00. A model that follows colour words is not a model that follows flatness.',
    },
  ],
};

const IMAGEGEN_README = `# Brand asset generation

\`brief/brand.json\` is the brief: the palette, the identity descriptor, the
constraint thresholds, and the models you may use. Your deliverable is
\`generation/spec.json\`, which the harness replays against the real image model.

## What the harness does with your spec

It calls the image service once per variant, decodes what comes back, and measures
it. Your spec is not graded on a description of an intended image; it is graded
on what the model produced from your prompt with your seed.

Measured on every image:

- \`paletteColors95\`: number of distinct 5-bit colour buckets that cover 95% of
  the frame. A flat design is a handful; a photographic image is hundreds.
- \`backgroundShare\`: share of pixels within 40 levels of the brief background.
- \`accentShare\`: share of pixels within 48 levels of the brief accent.
- \`cornerSpread\`: largest luma range inside any 24x24 corner patch.
- \`borderShare\`: share of non-background pixels inside the outer 10% border.
- \`forbiddenShare\`: share of pixels within 40 levels of the forbidden colour.
- \`subjectCentroidX\` / \`subjectCentroidY\`: where the non-background pixels sit.

## Spec shape

\`\`\`json
{
  "model": "flux-2-klein-4b",
  "identity": "<the brief's identity descriptor, verbatim>",
  "variants": [
    { "seed": 101, "prompt": "...", "size": "1024x1024" }
  ]
}
\`\`\`

Scenario 2 nests the same variant list under each asset:

\`\`\`json
{
  "model": "flux-2-klein-4b",
  "identity": "<verbatim>",
  "assets": [
    { "id": "hero", "description": "...", "variants": [ { "seed": 101, "prompt": "...", "size": "1024x1024" } ] }
  ]
}
\`\`\`

Every variant must declare \`size\`. Two variants per target is the intended shape: the harness renders the first, and
only renders the second if the first misses a constraint. Distinct seeds give you
a real second attempt.

## Models

\`flux-2-klein-4b\` honours a flat, few-colour brief and renders at 1024x1024.
\`flux-1-schnell\` and \`flux-2-klein-9b\` render at 1024x1024 as well.
\`sdxl-lightning\` is the only model that honours a requested canvas size, so a
non-square canvas needs it, and it follows colour and flatness instructions far
less reliably.

\`brief/examples.json\` records measurements this fixture author actually observed
from three example specs on \`flux-2-klein-4b\`, including one that fails. Read it
before writing prompts: the difference between a passing and a failing prompt is
mostly whether the palette instruction is stated explicitly.

\`bun run tools/check-spec.mjs generation/spec.json\` validates the spec's shape
before you hand it in. It cannot render; only the harness can.
`;

const CHECK_SPEC_MJS = `#!/usr/bin/env node
// Shape validation only. Rendering and measurement happen in the harness.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/check-spec.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(path, 'utf8'));
const problems = [];
const allowed = ['flux-2-klein-4b', 'flux-2-klein-9b', 'flux-1-schnell', 'sdxl-lightning'];
const variants = spec.variants ?? (spec.assets ?? []).flatMap((asset) => asset.variants ?? []);
if (!spec.identity) problems.push('identity is missing');
if (!spec.model) problems.push('model is missing');
else if (!allowed.includes(spec.model)) problems.push('model ' + spec.model + ' is not allowed');
if (!variants.length) problems.push('no variants found');
for (const variant of variants) {
  if (typeof variant.seed !== 'number') problems.push('a variant has no numeric seed');
  if (!variant.prompt || variant.prompt.length < 20) problems.push('a variant prompt is missing or too short');
}
if (Array.isArray(spec.assets)) {
  const ids = spec.assets.map((asset) => asset.id);
  for (const required of ['hero', 'avatar', 'footer-card']) {
    if (!ids.includes(required)) problems.push('asset ' + required + ' is missing');
  }
  for (const asset of spec.assets) {
    if (!(asset.variants ?? []).length) problems.push('asset ' + asset.id + ' has no variants');
  }
}
if (problems.length) {
  for (const problem of problems) console.error('spec problem: ' + problem);
  process.exit(1);
}
console.log('spec shape is valid: ' + variants.length + ' variant(s)');
`;

function writeSpec(destination: string, scenario: 1 | 2): void {
  mkdirSync(join(destination, 'brief'), { recursive: true });
  mkdirSync(join(destination, 'generation'), { recursive: true });
  mkdirSync(join(destination, 'tools'), { recursive: true });
  writeFileSync(
    join(destination, 'brief', 'brand.json'),
    `${JSON.stringify(
      {
        palette: { background: IMAGEGEN_BRAND.background, accent: IMAGEGEN_BRAND.accent, forbidden: IMAGEGEN_BRAND.forbidden },
        identity: IMAGEGEN_BRAND.identity,
        canvas: '1024x1024',
        allowedModels: [...IMAGEGEN_MODELS],
        constraints: IMAGEGEN_CONSTRAINTS,
        variantBudget: { perTarget: 2 },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(destination, 'generation', 'spec.json'), `${JSON.stringify(scenario === 1 ? SCENARIO_1_STARTER : SCENARIO_2_STARTER, null, 2)}\n`);
  writeFileSync(join(destination, 'brief', 'examples.json'), `${JSON.stringify(IMAGEGEN_EXAMPLES, null, 2)}\n`);
  writeFileSync(join(destination, 'tools', 'check-spec.mjs'), CHECK_SPEC_MJS, { mode: 0o755 });
  writeFileSync(join(destination, 'README.md'), IMAGEGEN_README);
}

export function imagegenMaterialize(destination: string, scenario: 1 | 2): void {
  writeSpec(destination, scenario);
}

export function imageConstraintsFor(scenario: 1 | 2): ImageConstraints {
  return IMAGEGEN_CONSTRAINTS;
}

export interface ImagegenCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ImagegenResult {
  passed: boolean;
  checks: ImagegenCheck[];
  evidence: string;
}

function readSpec(root: string): ImageSpec | null {
  const path = join(root, 'generation', 'spec.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ImageSpec;
  } catch {
    return null;
  }
}

interface RenderedVariant {
  measurements: ImageMeasurements;
  seed: number;
  size: string;
  error?: string;
}

const CANVAS = '1024x1024';

function declaredSize(variant: ImageVariant): string {
  return variant.size ?? CANVAS;
}

function canvasDeclared(variant: ImageVariant): boolean {
  return typeof variant.size === 'string' && /^\d{2,5}x\d{2,5}$/u.test(variant.size);
}

function sizeHonoured(model: string, size: string): boolean {
  if (model === IMAGEGEN_SIZING_MODEL) return true;
  return size === CANVAS;
}

async function renderVariants(
  model: string,
  variants: readonly ImageVariant[],
): Promise<RenderedVariant[]> {
  const background = parseHexColor(IMAGEGEN_BRAND.background);
  const accent = parseHexColor(IMAGEGEN_BRAND.accent);
  const forbidden = parseHexColor(IMAGEGEN_BRAND.forbidden);
  const rendered: RenderedVariant[] = [];
  for (const variant of variants.slice(0, 2)) {
    const size = declaredSize(variant);
    try {
      const generated = await generateImage({
        model,
        prompt: variant.prompt,
        size,
        seed: variant.seed,
      });
      rendered.push({
        measurements: measureImage(generated.image, background, accent, forbidden),
        seed: variant.seed,
        size,
      });
    } catch (error) {
      rendered.push({
        measurements: {
          width: 0,
          height: 0,
          cornerMean: { r: 0, g: 0, b: 0 },
          cornerMaxSpread: 999,
          backgroundShare: 0,
          accentShare: 0,
          forbiddenShare: 1,
          subjectCenterShare: 0,
          subjectBorderShare: 1,
          subjectCentroidX: 0.5,
          subjectCentroidY: 0.5,
          paletteColors95: 9999,
        },
        seed: variant.seed,
        size,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rendered;
}

function layoutConforms(measurements: ImageMeasurements): boolean {
  return (
    measurements.paletteColors95 <= IMAGEGEN_CONSTRAINTS.paletteColors95 &&
    measurements.backgroundShare >= IMAGEGEN_CONSTRAINTS.backgroundShare &&
    measurements.accentShare >= IMAGEGEN_CONSTRAINTS.accentShare &&
    measurements.cornerMaxSpread <= IMAGEGEN_CONSTRAINTS.cornerSpread &&
    measurements.subjectBorderShare <= IMAGEGEN_CONSTRAINTS.borderShare &&
    measurements.forbiddenShare <= IMAGEGEN_CONSTRAINTS.forbiddenShare
  );
}

function summarise(rendered: readonly RenderedVariant[]): string {
  return rendered
    .map((entry) =>
      entry.error
        ? `seed ${entry.seed}: ${entry.error.slice(0, 120)}`
        : `seed ${entry.seed}: palette=${entry.measurements.paletteColors95} bg=${entry.measurements.backgroundShare.toFixed(2)} accent=${entry.measurements.accentShare.toFixed(3)} spread=${Math.round(entry.measurements.cornerMaxSpread)} border=${entry.measurements.subjectBorderShare.toFixed(2)} forbidden=${entry.measurements.forbiddenShare.toFixed(3)} centroid=(${entry.measurements.subjectCentroidX.toFixed(2)},${entry.measurements.subjectCentroidY.toFixed(2)})`,
    )
    .join('; ');
}

/** Render the candidate's spec and grade what the model actually produced. */
export async function runImagegenScenario(root: string, scenario: 1 | 2): Promise<ImagegenResult> {
  const blockers = imagegenRuntimeReadiness();
  if (blockers.length) return { passed: false, checks: [], evidence: blockers.join('\n') };
  const spec = readSpec(root);
  const checks: ImagegenCheck[] = [];
  const evidence: string[] = [];

  if (!spec) {
    return {
      passed: false,
      checks: [{ id: 'contract', passed: false, detail: 'generation/spec.json is missing or is not valid JSON' }],
      evidence: 'no spec',
    };
  }

  const model = spec.model ?? '';
  const modelAllowed = (IMAGEGEN_MODELS as readonly string[]).includes(model);
  const variants = spec.variants ?? [];
  const assets = spec.assets ?? [];

  if (scenario === 1) {
    const seeds = variants.map((variant) => variant.seed);
    const shapeOk =
      modelAllowed &&
      variants.length >= 1 &&
      variants.length <= 2 &&
      new Set(seeds).size === seeds.length &&
      variants.every((variant) => typeof variant.seed === 'number' && variant.prompt.length >= 20) &&
      variants.every((variant) => canvasDeclared(variant) && sizeHonoured(model, declaredSize(variant)));
    checks.push({
      id: 'contract',
      passed: shapeOk,
      detail: `model=${model || '(none)'} allowed=${modelAllowed} variants=${variants.length} distinctSeeds=${new Set(seeds).size === seeds.length} canvasDeclared=${variants.every(canvasDeclared)}`,
    });
    if (variants.length) {
      const rendered = await renderVariants(model, variants);
      const renderedOk = rendered.some((entry) => !entry.error);
      checks.push({
        id: 'render',
        passed: renderedOk,
        detail: summarise(rendered),
      });
      const best = rendered.find((entry) => !entry.error && layoutConforms(entry.measurements)) ?? rendered[0];
      checks.push({
        id: 'palette',
        passed: best.measurements.paletteColors95 <= IMAGEGEN_CONSTRAINTS.paletteColors95,
        detail: `palette colours covering 95% (limit ${IMAGEGEN_CONSTRAINTS.paletteColors95}): ${best.measurements.paletteColors95}`,
      });
      checks.push({
        id: 'layout',
        passed:
          best.measurements.backgroundShare >= IMAGEGEN_CONSTRAINTS.backgroundShare &&
          best.measurements.cornerMaxSpread <= IMAGEGEN_CONSTRAINTS.cornerSpread &&
          best.measurements.subjectBorderShare <= IMAGEGEN_CONSTRAINTS.borderShare,
        detail: `background=${best.measurements.backgroundShare.toFixed(2)} (min ${IMAGEGEN_CONSTRAINTS.backgroundShare}) spread=${Math.round(best.measurements.cornerMaxSpread)} (max ${IMAGEGEN_CONSTRAINTS.cornerSpread}) border=${best.measurements.subjectBorderShare.toFixed(2)} (max ${IMAGEGEN_CONSTRAINTS.borderShare})`,
      });
      checks.push({
        id: 'accent',
        passed:
          best.measurements.accentShare >= IMAGEGEN_CONSTRAINTS.accentShare &&
          best.measurements.forbiddenShare <= IMAGEGEN_CONSTRAINTS.forbiddenShare,
        detail: `accent=${best.measurements.accentShare.toFixed(3)} (min ${IMAGEGEN_CONSTRAINTS.accentShare}) forbidden=${best.measurements.forbiddenShare.toFixed(3)} (max ${IMAGEGEN_CONSTRAINTS.forbiddenShare})`,
      });
      checks.push({
        id: 'variant-budget',
        passed: variants.length <= 2,
        detail: `${variants.length} variant(s) requested, at most 2 are rendered`,
      });
      evidence.push(summarise(rendered));
    }
  } else {
    const requiredIds = ['hero', 'avatar', 'footer-card'];
    const ids = assets.map((asset) => asset.id);
    const identityOk = typeof spec.identity === 'string' && spec.identity.trim() === IMAGEGEN_BRAND.identity;
    const shapeOk =
      modelAllowed &&
      requiredIds.every((id) => ids.includes(id)) &&
      assets.every((asset) => (asset.variants ?? []).length >= 1 && (asset.variants ?? []).length <= 2) &&
      assets.every((asset) => new Set((asset.variants ?? []).map((variant) => variant.seed)).size === (asset.variants ?? []).length) &&
      assets.every((asset) => (asset.variants ?? []).every((variant) => variant.prompt.length >= 20 && canvasDeclared(variant) && sizeHonoured(model, declaredSize(variant))));
    checks.push({
      id: 'contract',
      passed: shapeOk && identityOk,
      detail: `model=${model || '(none)'} assets=${ids.join(',') || '(none)'} identityMatchesBrief=${identityOk}`,
    });

    const identityInEveryPrompt =
      assets.length > 0 &&
      assets.every((asset) => (asset.variants ?? []).every((variant) => variant.prompt.includes(IMAGEGEN_BRAND.identity)));
    checks.push({
      id: 'identity-reuse',
      passed: identityInEveryPrompt,
      detail: identityInEveryPrompt
        ? 'the brief identity descriptor appears verbatim in every prompt'
        : 'the brief identity descriptor is not repeated verbatim in every prompt',
    });

    const renderedByAsset = new Map<string, RenderedVariant[]>();
    for (const asset of assets) {
      renderedByAsset.set(asset.id, await renderVariants(model, asset.variants ?? []));
      evidence.push(`${asset.id}: ${summarise(renderedByAsset.get(asset.id) ?? [])}`);
    }
    const allRendered = requiredIds.every((id) => (renderedByAsset.get(id) ?? []).some((entry) => !entry.error));
    checks.push({
      id: 'render-all',
      passed: allRendered,
      detail: requiredIds.map((id) => `${id}:${(renderedByAsset.get(id) ?? []).some((entry) => !entry.error) ? 'rendered' : 'failed'}`).join(' '),
    });

    const bestOf = (id: string): RenderedVariant | undefined => {
      const rows = renderedByAsset.get(id) ?? [];
      return rows.find((entry) => !entry.error && layoutConforms(entry.measurements)) ?? rows.find((entry) => !entry.error) ?? rows[0];
    };
    const hero = bestOf('hero');
    const avatar = bestOf('avatar');
    const card = bestOf('footer-card');

    checks.push({
      id: 'palette',
      passed: requiredIds.every((id) => (bestOf(id)?.measurements.paletteColors95 ?? 9999) <= IMAGEGEN_CONSTRAINTS.paletteColors95),
      detail: requiredIds.map((id) => `${id}=${bestOf(id)?.measurements.paletteColors95 ?? 'n/a'}`).join(' ') + ` (limit ${IMAGEGEN_CONSTRAINTS.paletteColors95})`,
    });
    checks.push({
      id: 'accent',
      passed: requiredIds.every((id) => {
        const measurements = bestOf(id)?.measurements;
        return Boolean(measurements) && measurements!.accentShare >= IMAGEGEN_CONSTRAINTS.accentShare && measurements!.forbiddenShare <= IMAGEGEN_CONSTRAINTS.forbiddenShare;
      }),
      detail: requiredIds.map((id) => `${id}=${(bestOf(id)?.measurements.accentShare ?? 0).toFixed(3)}`).join(' ') + ` (min ${IMAGEGEN_CONSTRAINTS.accentShare})`,
    });
    checks.push({
      id: 'composition-hero',
      passed: Boolean(hero) && !hero!.error && layoutConforms(hero!.measurements),
      detail: hero ? summarise([hero]) : 'hero was not rendered',
    });
    checks.push({
      id: 'composition-avatar',
      passed: Boolean(avatar) && !avatar!.error &&
        avatar!.measurements.backgroundShare >= 0.25 &&
        avatar!.measurements.backgroundShare <= 0.85 &&
        Math.abs(avatar!.measurements.subjectCentroidX - 0.5) <= 0.2 &&
        Math.abs(avatar!.measurements.subjectCentroidY - 0.5) <= 0.2,
      detail: avatar
        ? `background=${avatar.measurements.backgroundShare.toFixed(2)} (0.25..0.85) centroid=(${avatar.measurements.subjectCentroidX.toFixed(2)},${avatar.measurements.subjectCentroidY.toFixed(2)}) within 0.20 of centre`
        : 'avatar was not rendered',
    });
    checks.push({
      id: 'composition-card',
      passed: Boolean(card) && !card!.error && card!.measurements.subjectCentroidY >= 0.55 && card!.measurements.subjectBorderShare <= IMAGEGEN_CONSTRAINTS.borderShare,
      detail: card
        ? `centroidY=${card.measurements.subjectCentroidY.toFixed(2)} (min 0.55) border=${card.measurements.subjectBorderShare.toFixed(2)}`
        : 'footer-card was not rendered',
    });
  }

  const passed = checks.length > 0 && checks.every((check) => check.passed);
  return { passed, checks, evidence: evidence.join('\n').slice(-4000) };
}

function imagegenScore(result: ImagegenResult): {
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
} {
  const evidence = result.checks.map(
    (check) => `${check.id}: ${check.passed ? 'pass' : 'fail'} (${check.detail})`,
  );
  if (!result.checks.length) evidence.push(result.evidence);
  const passing = result.checks.filter((check) => check.passed).length;
  return {
    passed: result.passed,
    quality: result.checks.length ? passing / result.checks.length : 0,
    verification: result.checks.length ? 1 : 0,
    integrityFailure: false,
    evidence,
  };
}

export const IMAGEGEN_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'image-generation-practice/brand-hero-variants@1',
    realRuntime: true,
    readinessBlockers: imagegenRuntimeReadiness(),
    matches: (scenario) => scenario.id === IMAGEGEN_SCENARIO_1,
    materialize: (destination) => imagegenMaterialize(destination, 1),
  },
  {
    id: 'image-generation-practice/brand-asset-set@1',
    realRuntime: true,
    readinessBlockers: imagegenRuntimeReadiness(),
    matches: (scenario) => scenario.id === IMAGEGEN_SCENARIO_2,
    materialize: (destination) => imagegenMaterialize(destination, 2),
  },
];

export const IMAGEGEN_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'image-generation-practice/brand-hero-variants-scorer@1',
    scenarioIds: [IMAGEGEN_SCENARIO_1],
    score: async ({ workingDirectory }) => imagegenScore(await runImagegenScenario(workingDirectory, 1)),
  },
  {
    id: 'image-generation-practice/brand-asset-set-scorer@1',
    scenarioIds: [IMAGEGEN_SCENARIO_2],
    score: async ({ workingDirectory }) => imagegenScore(await runImagegenScenario(workingDirectory, 2)),
  },
];
