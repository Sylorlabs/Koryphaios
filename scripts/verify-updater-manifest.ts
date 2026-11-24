#!/usr/bin/env bun
/**
 * Validate a Tauri updater manifest (`latest.json`) before it is published.
 *
 * The in-app updater asks GitHub for `latest.json`, picks the entry for its
 * own `{os}-{arch}[-{installer}]` target, downloads that URL and checks the
 * minisign signature against the public key compiled into the installed app.
 * A manifest that breaks any of those steps does not fail loudly on the
 * client: the update is simply never offered. This script rejects such a
 * manifest on the release side instead.
 *
 * Checks:
 *   - `version` is a semver string; `pub_date` is RFC 3339
 *   - every required platform key is present (see REQUIRED_UPDATER_PLATFORMS)
 *   - each entry has an https `url` and a structurally valid minisign
 *     `signature` (the base64 text of the `.sig` file, as Tauri writes it)
 *   - each URL points at the release for `v<version>` (or `--tag`) and the
 *     file kind and architecture match the platform key
 *   - with `--assets`, each URL's file is an uploaded release asset
 *   - with `--tauri-conf` / `--pubkey`, every signature was made by the key the
 *     installed apps trust
 *   - with `--newer-than`, the manifest offers an update to that older build
 *
 * Usage:
 *   bun run scripts/verify-updater-manifest.ts latest.json \
 *     --expect-version 0.5.0 --assets assets.json \
 *     --tauri-conf desktop/src-tauri/tauri.conf.json --newer-than 0.1.0
 *
 * `assets.json` is `gh release view <tag> --json assets` output (or a bare
 * array of `{ "name": ... }`). Exit codes: 0 valid, 1 invalid, 2 usage or I/O.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Platform keys every stable release must publish. `linux-x86_64` is the
 *  generic fallback the updater uses when no installer-specific key matches. */
export const REQUIRED_UPDATER_PLATFORMS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64',
  'linux-x86_64-appimage',
  'linux-x86_64-deb',
  'linux-x86_64-rpm',
] as const;

/** What each platform key must point at. The file kind must be the updater
 *  payload (not a DMG or other manual-install image) and the architecture token
 *  must appear in the file name. */
const PLATFORM_ARTIFACT_RULES: ReadonlyArray<{
  pattern: RegExp;
  kind: RegExp;
  kindLabel: string;
  arch: RegExp;
  archLabel: string;
}> = [
  {
    pattern: /^darwin-aarch64(-app)?$/,
    kind: /\.app\.tar\.gz$/,
    kindLabel: '.app.tar.gz',
    arch: /aarch64|arm64/i,
    archLabel: 'aarch64',
  },
  {
    pattern: /^darwin-x86_64(-app)?$/,
    kind: /\.app\.tar\.gz$/,
    kindLabel: '.app.tar.gz',
    arch: /x86_64|x64/i,
    archLabel: 'x86_64',
  },
  {
    pattern: /^windows-x86_64(-nsis|-msi)?$/,
    kind: /\.(exe|msi)$/,
    kindLabel: '.exe or .msi',
    arch: /x64|x86_64/i,
    archLabel: 'x64',
  },
  {
    pattern: /^linux-x86_64(-appimage)?$/,
    kind: /\.AppImage$/,
    kindLabel: '.AppImage',
    arch: /amd64|x86_64/i,
    archLabel: 'amd64 or x86_64',
  },
  {
    pattern: /^linux-x86_64-deb$/,
    kind: /\.deb$/,
    kindLabel: '.deb',
    arch: /amd64|x86_64/i,
    archLabel: 'amd64 or x86_64',
  },
  {
    pattern: /^linux-x86_64-rpm$/,
    kind: /\.rpm$/,
    kindLabel: '.rpm',
    arch: /x86_64/i,
    archLabel: 'x86_64',
  },
];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface VerifyOptions {
  /** The version the release claims (the tag without its `v`). */
  expectVersion?: string;
  /** File names of the GitHub release assets. Enables the URL-to-asset check. */
  assetNames?: readonly string[];
  /** `owner/name` of the repository the URLs must point at. */
  repo?: string;
  /** Release tag the URLs must name. Defaults to `v<version>`. */
  tag?: string;
  /** Base64 minisign public key from tauri.conf.json `plugins.updater.pubkey`. */
  pubkey?: string;
  /** An older build that must be offered this manifest as an update. */
  newerThan?: string;
}

export interface VerifyResult {
  errors: string[];
  warnings: string[];
  version: string | null;
  platforms: string[];
}

export interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

export function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Semver precedence: negative when a < b, positive when a > b, 0 when equal.
 *  Build metadata is ignored, as the spec requires. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`not a semantic version: ${left ? b : a}`);
  for (let i = 0; i < 3; i++) {
    const delta = left.core[i] - right.core[i];
    if (delta !== 0) return delta;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  // A release outranks any prerelease of the same core version.
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      const delta = Number(l) - Number(r);
      if (delta !== 0) return delta;
    } else if (lNumeric !== rNumeric) {
      return lNumeric ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export interface MinisignatureShape {
  algorithm: 'Ed' | 'ED';
  keyId: string;
}

function decodeBase64Text(value: string): string | null {
  const trimmed = value.trim();
  if (!BASE64.test(trimmed) || trimmed.length % 4 !== 0) return null;
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

/** Parse the base64 text of a Tauri `.sig` file (or a configured public key) as
 *  a minisign object. Returns the key id as hex so the two can be compared. */
export function inspectMinisignature(encoded: string): MinisignatureShape | string {
  const text = decodeBase64Text(encoded);
  if (text === null) return 'signature is not base64 text';
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('untrusted comment:')) return 'signature is not a minisign file';
  const signatureLine = Buffer.from(lines[1] ?? '', 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(lines[1] ?? '') || signatureLine.length !== 74) {
    return 'minisign signature line is malformed';
  }
  const algorithm = signatureLine.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed' && algorithm !== 'ED') return 'minisign algorithm is not Ed25519';
  if (!lines[2]?.startsWith('trusted comment:')) return 'minisign trusted comment is missing';
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64');
  if (globalSignature.length !== 64) return 'minisign global signature is malformed';
  return { algorithm, keyId: signatureLine.subarray(2, 10).toString('hex') };
}

export function publicKeyId(pubkey: string): string | null {
  const text = decodeBase64Text(pubkey);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('untrusted comment:')) return null;
  const key = Buffer.from(lines[1] ?? '', 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString('latin1') !== 'Ed') return null;
  return key.subarray(2, 10).toString('hex');
}

/** Verify a minisign signature over file bytes with the configured public key.
 *  Tauri signs with the prehashed (`ED`) variant, which signs BLAKE2b-512 of the
 *  file; the plain (`Ed`) variant signs the bytes directly. */
export function verifyMinisignature(data: Buffer, encodedSignature: string, encodedPubkey: string): boolean {
  const sigText = decodeBase64Text(encodedSignature);
  const pkText = decodeBase64Text(encodedPubkey);
  if (sigText === null || pkText === null) return false;
  const sigBytes = Buffer.from((sigText.split(/\r?\n/)[1] ?? '').trim(), 'base64');
  const keyBytes = Buffer.from((pkText.split(/\r?\n/)[1] ?? '').trim(), 'base64');
  if (sigBytes.length !== 74 || keyBytes.length !== 42) return false;
  if (!sigBytes.subarray(2, 10).equals(keyBytes.subarray(2, 10))) return false;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyBytes.subarray(10, 42)]);
  const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const algorithm = sigBytes.subarray(0, 2).toString('latin1');
  const message =
    algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  return cryptoVerify(null, message, publicKey, sigBytes.subarray(10, 74));
}

function isAssetNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Accepts `gh release view --json assets` output, a bare `[{name}]` array, or a
 *  bare array of names. */
export function assetNamesFromJson(value: unknown): string[] {
  if (isAssetNameList(value)) return value;
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { assets?: unknown }).assets)
      ? (value as { assets: unknown[] }).assets
      : null;
  if (!list) throw new Error('assets JSON must be an array or an object with an "assets" array');
  return list.map((asset) => {
    const name = asset && typeof asset === 'object' ? (asset as { name?: unknown }).name : undefined;
    if (typeof name !== 'string') throw new Error('every asset entry needs a string "name"');
    return name;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function urlFileName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const last = segments[segments.length - 1];
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/** Check a parsed latest.json against the release contract. Pure: no I/O. */
export function verifyUpdaterManifest(manifest: unknown, options: VerifyOptions = {}): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: VerifyResult = { errors, warnings, version: null, platforms: [] };

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('manifest must be a JSON object');
    return result;
  }
  const body = manifest as Record<string, unknown>;

  const version = body.version;
  if (typeof version !== 'string' || !parseSemver(version)) {
    errors.push(`version must be a semantic version, got ${JSON.stringify(version)}`);
  } else {
    result.version = version;
    if (options.expectVersion !== undefined && version !== options.expectVersion) {
      errors.push(`version is ${version}, expected ${options.expectVersion}`);
    }
    if (options.newerThan !== undefined) {
      if (!parseSemver(options.newerThan)) {
        errors.push(`--newer-than ${options.newerThan} is not a semantic version`);
      } else if (compareSemver(version, options.newerThan) <= 0) {
        errors.push(
          `version ${version} does not offer an update to builds at ${options.newerThan}`,
        );
      }
    }
  }

  if (typeof body.pub_date !== 'string' || !RFC3339.test(body.pub_date) || Number.isNaN(Date.parse(body.pub_date))) {
    errors.push(`pub_date must be an RFC 3339 timestamp, got ${JSON.stringify(body.pub_date)}`);
  }
  if (body.notes !== undefined && typeof body.notes !== 'string') {
    errors.push('notes must be a string when present');
  }

  const platforms = body.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    errors.push('platforms must be an object keyed by target');
    return result;
  }
  const entries = platforms as Record<string, unknown>;
  result.platforms = Object.keys(entries).sort();

  for (const required of REQUIRED_UPDATER_PLATFORMS) {
    if (!(required in entries)) errors.push(`missing required platform ${required}`);
  }

  const expectedTag = options.tag ?? (typeof version === 'string' ? `v${version}` : null);
  const urlPrefix = options.repo
    ? new RegExp(`^https://github\\.com/${escapeRegExp(options.repo)}/releases/download/`, 'i')
    : /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//;

  let publicKeyIdHex: string | null = null;
  if (options.pubkey !== undefined) {
    publicKeyIdHex = publicKeyId(options.pubkey);
    if (publicKeyIdHex === null) errors.push('configured updater pubkey is not a minisign public key');
  }

  for (const [platform, entry] of Object.entries(entries)) {
    const rule = PLATFORM_ARTIFACT_RULES.find((candidate) => candidate.pattern.test(platform));
    if (!rule) {
      warnings.push(`platform ${platform} is not a known updater target`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${platform}: entry must be an object with url and signature`);
      continue;
    }
    const { url, signature } = entry as { url?: unknown; signature?: unknown };

    if (typeof url !== 'string' || !urlPrefix.test(url)) {
      errors.push(`${platform}: url must be a GitHub release download URL`);
    } else {
      const tagSegment = url.split('/releases/download/')[1]?.split('/')[0];
      if (expectedTag && tagSegment !== expectedTag) {
        errors.push(`${platform}: url names release ${tagSegment ?? '(none)'}, expected ${expectedTag}`);
      }
      const fileName = urlFileName(url);
      if (!fileName) {
        errors.push(`${platform}: url has no file name`);
      } else {
        if (rule) {
          if (!rule.kind.test(fileName)) {
            errors.push(`${platform}: ${fileName} is not an updater payload (expected ${rule.kindLabel})`);
          }
          if (!rule.arch.test(fileName)) {
            errors.push(`${platform}: ${fileName} does not name the ${rule.archLabel} architecture`);
          }
        }
        if (options.assetNames && !options.assetNames.includes(fileName)) {
          errors.push(`${platform}: ${fileName} is not an uploaded release asset`);
        }
      }
    }

    if (typeof signature !== 'string' || signature.trim().length === 0) {
      errors.push(`${platform}: signature is missing`);
      continue;
    }
    const shape = inspectMinisignature(signature);
    if (typeof shape === 'string') {
      errors.push(`${platform}: ${shape}`);
    } else if (publicKeyIdHex !== null && shape.keyId !== publicKeyIdHex) {
      errors.push(
        `${platform}: signed with key ${shape.keyId}, but the app trusts key ${publicKeyIdHex}`,
      );
    }
  }

  return result;
}

interface CliArguments {
  manifestPath: string;
  options: VerifyOptions;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const positional: string[] = [];
  const options: VerifyOptions = {};
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--expect-version':
        options.expectVersion = valueOf(arg, index);
        index++;
        break;
      case '--assets':
        options.assetNames = assetNamesFromJson(readJson(resolve(valueOf(arg, index))));
        index++;
        break;
      case '--repo':
        options.repo = valueOf(arg, index);
        index++;
        break;
      case '--tag':
        options.tag = valueOf(arg, index);
        index++;
        break;
      case '--pubkey':
        options.pubkey = valueOf(arg, index);
        index++;
        break;
      case '--tauri-conf': {
        const conf = readJson(resolve(valueOf(arg, index))) as {
          plugins?: { updater?: { pubkey?: unknown } };
        };
        const pubkey = conf.plugins?.updater?.pubkey;
        if (typeof pubkey !== 'string') throw new Error('tauri.conf.json has no plugins.updater.pubkey');
        options.pubkey = pubkey;
        index++;
        break;
      }
      case '--newer-than':
        options.newerThan = valueOf(arg, index);
        index++;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('usage: verify-updater-manifest.ts <latest.json> [options]');
  }
  return { manifestPath: positional[0], options };
}

function main(argv: readonly string[]): number {
  let parsed: CliArguments;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    console.error(`verify-updater-manifest: ${(error as Error).message}`);
    return 2;
  }
  const path = resolve(parsed.manifestPath);
  if (!existsSync(path)) {
    console.error(`verify-updater-manifest: ${path} does not exist`);
    return 2;
  }
  let manifest: unknown;
  try {
    manifest = readJson(path);
  } catch (error) {
    console.error(`verify-updater-manifest: ${path} is not valid JSON: ${(error as Error).message}`);
    return 1;
  }
  const result = verifyUpdaterManifest(manifest, parsed.options);
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error(`latest.json is not publishable (${result.errors.length} problem(s))`);
    return 1;
  }
  console.log(
    `latest.json ok: v${result.version} with ${result.platforms.length} platform(s): ${result.platforms.join(', ')}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
