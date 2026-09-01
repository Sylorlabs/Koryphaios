// AWS credential source scan.
//
// Answers one question: "does this machine have a usable AWS credential
// SOURCE for Bedrock?" It never returns secret material — only where the
// credential lives (env vars, shared credentials file, or config file) so
// the UI can show "Credentials detected on system" without leaking keys.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AwsCredentialSourceKind =
  | 'env'
  | 'shared_credentials_file'
  | 'config_file';

export interface AwsCredentialSource {
  kind: AwsCredentialSourceKind;
  /** Named profile when the source is a file or AWS_PROFILE is set. */
  profile?: string;
  region?: string;
  /** True when the profile resolves through AWS SSO and may need `aws sso login`. */
  sso?: boolean;
}

export interface AwsCredentialScan {
  detected: boolean;
  sources: AwsCredentialSource[];
  /** Human-readable summary safe to show in the UI. */
  description: string;
}

const MAX_PROFILES_REPORTED = 5;

function parseIniSections(content: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let current: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      if (!sections.has(current)) sections.set(current, {});
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq > 0) {
      sections.get(current)![line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

/**
 * Profiles in ~/.aws/config use a `[profile <name>]` prefix; `[default]` is
 * unprefixed. ~/.aws/credentials uses bare `[<name>]` sections.
 */
function profileNameFromSection(section: string, requiresPrefix: boolean): string | null {
  if (!requiresPrefix) return section;
  if (section === 'default') return 'default';
  const match = /^profile\s+(.+)$/.exec(section);
  return match ? match[1].trim() : null;
}

function fileProfiles(path: string, requiresPrefix: boolean): AwsCredentialSource[] {
  const kind: AwsCredentialSourceKind = requiresPrefix
    ? 'config_file'
    : 'shared_credentials_file';
  try {
    if (!existsSync(path)) return [];
    const sections = parseIniSections(readFileSync(path, 'utf8'));
    const sources: AwsCredentialSource[] = [];
    for (const [section, values] of sections) {
      const profile = profileNameFromSection(section, requiresPrefix);
      if (!profile) continue;
      // A config-file entry is a credential source only when it points at a
      // concrete authentication method: a profile with explicit access keys,
      // or an SSO setup (sso_session / sso_start_url). A bare `login_session`
      // reference is not a usable credential — the user must complete the
      // `aws login` flow first.
      if (kind === 'config_file') {
        const hasExplicitAuth = !!(values.aws_access_key_id || values.sso_session || values.sso_start_url);
        if (!hasExplicitAuth) continue;
      }
      // A credentials-file entry without access keys is not a usable source.
      if (kind === 'shared_credentials_file' && !values.aws_access_key_id) continue;
      const sso = !!(values.sso_session || values.sso_start_url);
      sources.push({
        kind,
        profile,
        ...(values.region && { region: values.region }),
        ...(sso && { sso: true }),
      });
    }
    return sources;
  } catch {
    return [];
  }
}

/** Scan env vars, AWS shared credentials/config files for credential sources. */
export function scanAwsCredentialSources(): AwsCredentialScan {
  const sources: AwsCredentialSource[] = [];

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    sources.push({
      kind: 'env',
      ...(process.env.AWS_PROFILE && { profile: process.env.AWS_PROFILE }),
      ...(awsEnvRegion() && { region: awsEnvRegion()! }),
    });
  } else if (process.env.AWS_PROFILE) {
    // A bare AWS_PROFILE is only meaningful when a matching profile exists on
    // disk; the file scans below confirm that.
    sources.push({ kind: 'env', profile: process.env.AWS_PROFILE });
  }

  // Honor the same path overrides the AWS SDK understands.
  const home = homedir();
  const credentialsFile =
    process.env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials');
  const configFile = process.env.AWS_CONFIG_FILE || join(home, '.aws', 'config');
  sources.push(...fileProfiles(credentialsFile, false));
  sources.push(...fileProfiles(configFile, true));

  // Dedupe identical sources (same kind + profile).
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = sourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const detected = unique.length > 0;
  return {
    detected,
    sources: unique.slice(0, MAX_PROFILES_REPORTED),
    description: describeAwsCredentialSources(unique),
  };
}

function sourceKey(source: AwsCredentialSource): string {
  return `${source.kind}:${source.profile ?? ''}`;
}

function awsEnvRegion(): string | undefined {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

function describeAwsCredentialSources(sources: AwsCredentialSource[]): string {
  if (sources.length === 0) return '';
  const parts = sources.map((source) => {
    const profile = source.profile ? ` (profile: ${source.profile})` : '';
    const sso = source.sso ? ' — SSO' : '';
    switch (source.kind) {
      case 'env':
        return `environment variables${profile}`;
      case 'shared_credentials_file':
        return `~/.aws/credentials · ${source.profile}${sso}`;
      case 'config_file':
        return `~/.aws/config · ${source.profile}${sso}`;
    }
  });
  return parts.join(', ');
}

/** True when at least one usable AWS credential source exists on this system. */
export function hasAwsCredentialSource(): boolean {
  return scanAwsCredentialSources().detected;
}