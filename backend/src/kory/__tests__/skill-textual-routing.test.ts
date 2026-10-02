import { describe, expect, test } from 'bun:test';
import { loadV5SkillPackages } from '../skill-packages';
import { auditV5SkillLibraryQuality, explicitSkillReferences } from '../skill-v5-quality';

describe('authored skill routing references', () => {
  test('detects nonexistent ownership and delegation targets beyond the metadata graph', () => {
    const catalog = loadV5SkillPackages();
    const broken = {
      ...catalog,
      packages: catalog.packages.map((skill) =>
        skill.sidecar.name === 'applied-cryptography'
          ? {
              ...skill,
              instructions: `${skill.instructions}\n- \`transport-security\` owns TLS configuration.\nRoute lexical search to \`full-text-search-systems\`.`,
            }
          : skill,
      ),
    };
    expect(broken.errors).toEqual([]);
    expect(auditV5SkillLibraryQuality(broken).missingRoutingReferences).toEqual([
      {
        skill: 'applied-cryptography',
        targets: ['full-text-search-systems', 'transport-security'],
      },
    ]);
    expect(auditV5SkillLibraryQuality(catalog).missingRoutingReferences).toEqual([]);
  });

  test('does not confuse flags, ordinary prose, quoted input, or fenced code with skill ownership', () => {
    const body = [
      'Use `no-cache` for conditional HTTP validation.',
      'Preserve the `Cache-Control` response header.',
      'Do not turn regression-testing into a new skill.',
      '> `quoted-example` owns a fictional boundary.',
      '````markdown',
      '- `example-owner` owns a fictional responsibility.',
      '```',
      'Route the example to `fictional-child`.',
      '````',
      '- `networking-systems` owns network diagnostics.',
      'Delegate visual synthesis to `image-generation-practice`.',
    ].join('\n');
    expect(explicitSkillReferences(body)).toEqual([
      'image-generation-practice',
      'networking-systems',
    ]);
  });
});
