import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  loadV5SkillPackages,
  resolveSkillsPackageRoot,
  type V5SkillPackageCatalog,
} from '../skill-packages';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function packageBytes(catalog: V5SkillPackageCatalog): string[] {
  return catalog.packages.map((skillPackage) => {
    const files = [
      skillPackage.sourcePath,
      skillPackage.sidecarPath,
      ...skillPackage.supportingResources.map((resource) => join(skillPackage.directory, resource)),
    ].sort();
    return files
      .map(
        (path) =>
          `${relative(skillPackage.directory, path)}\0${readFileSync(path).toString('base64')}`,
      )
      .join('\0');
  });
}

function packageFingerprints(catalog: V5SkillPackageCatalog): string[] {
  return packageBytes(catalog).map(digest);
}

describe('Skills package-root terminology aliases', () => {
  test('loads all Kory bundled aliases through the unchanged skills-v5 bytes', () => {
    const canonical = loadV5SkillPackages('skills-v5');
    const skills = loadV5SkillPackages('skills');
    const skillsV1 = loadV5SkillPackages('skills-v1');
    const skillsV5 = loadV5SkillPackages('skills-v5');

    expect(canonical.errors).toEqual([]);
    expect(skills.errors).toEqual([]);
    expect(skillsV1.errors).toEqual([]);
    expect(skillsV5.errors).toEqual([]);
    expect(canonical.packages).toHaveLength(182);
    expect(skills.packages).toHaveLength(182);
    expect(skillsV1.packages).toHaveLength(182);
    expect(skillsV5.packages).toHaveLength(182);
    expect(resolveSkillsPackageRoot('skills')).toBe(canonical.root);
    expect(resolveSkillsPackageRoot('skills-v1')).toBe(canonical.root);
    expect(resolveSkillsPackageRoot('skills-v5')).toBe(canonical.root);

    expect(packageBytes(skills)).toEqual(packageBytes(canonical));
    expect(packageBytes(skillsV1)).toEqual(packageBytes(canonical));
    expect(packageBytes(skillsV5)).toEqual(packageBytes(canonical));
    expect(packageFingerprints(skills)).toEqual(packageFingerprints(canonical));
    expect(packageFingerprints(skillsV1)).toEqual(packageFingerprints(canonical));
    expect(packageFingerprints(skillsV5)).toEqual(packageFingerprints(canonical));
  });

  test('does not treat inherited names as aliases or hijack custom roots', () => {
    for (const customRoot of ['__proto__', 'constructor', 'toString', 'custom-skills']) {
      expect(resolveSkillsPackageRoot(customRoot)).toBe(resolve(customRoot));
    }

    const absoluteCustomRoot = resolve('custom-skills');
    expect(resolveSkillsPackageRoot(absoluteCustomRoot)).toBe(absoluteCustomRoot);
  });
});
