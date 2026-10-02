import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard for the deployment badge in SettingsDrawer.
//
// `ProviderDeployment` (backend/src/providers/provider-display.ts) and the wire
// contract in shared/src/websocket/WSPayloads.ts both include 'hybrid', but
// neither is exported from @koryphaios/shared, so the helpers below are read as
// source text rather than imported. The bug this locks down: 'hybrid' sat in the
// union with no branch anywhere in SettingsDrawer, so a hybrid provider (Hoplite
// — cloud sandboxes *or* a local Codex/Claude agent, chosen per thread) silently
// rendered no badge and no description at all.
const SOURCE = readFileSync(
  join(process.cwd(), 'src/lib/components/SettingsDrawer.svelte'),
  'utf8',
);

describe('provider deployment badge', () => {
  it('labels hybrid as cloud + local rather than as a cloud-only agent', () => {
    expect(SOURCE).toMatch(/deployment === 'hybrid'\) return 'Cloud \+ local'/);
    // 'cloud' is matched first, so a hybrid provider must not be reachable by it.
    expect(SOURCE).toMatch(/deployment === 'cloud'\) return 'Cloud agent'/);
  });

  it('describes hybrid as a per-thread choice between a sandbox and a local agent', () => {
    expect(SOURCE).toMatch(
      /if \(deployment === 'hybrid'\) \{\s*return 'Cloud sandboxes or a local agent · chosen per thread'/,
    );
  });

  it('gives the hybrid badge its own class branch instead of falling through', () => {
    // Without this branch hybrid would inherit the neutral fallback styling and
    // be indistinguishable from an unclassified provider.
    expect(SOURCE).toMatch(/status\?\.deployment === 'hybrid'[\s\S]{0,160}?color-warning/);
  });

  it('keeps api unlabelled by design, not by omission', () => {
    // Plain API-key providers intentionally show no badge; every value that is
    // meant to render must appear as a comparison, and 'api' must not.
    for (const deployment of ['cloud', 'local', 'hybrid']) {
      expect(SOURCE, `${deployment} needs a deploymentLabel branch`).toMatch(
        new RegExp(`deployment === '${deployment}'\\)`),
      );
    }
    expect(SOURCE).not.toMatch(/deployment === 'api'\) return/);
  });
});
