const root = process.cwd();
const evals = await import(`${root}/backend/src/kory/skill-evaluations.ts`);
const pkgs = await import(`${root}/backend/src/kory/skill-packages.ts`);
const fSkills = new Set(['application-security','security-review','security-verification','web-security','infrastructure-security','cloud-security','language-runtime-security','supply-chain-security','secrets-key-management','secure-authentication','authorization-security','oauth-oidc','privacy-engineering','applied-cryptography','threat-modeling-practice','ai-safety-evaluation']);
const loaded = pkgs.loadV5SkillPackages(root);
for (const p of loaded.packages) {
  if (!fSkills.has(p.name)) continue;
  try {
    const gate = evals.evaluateSkillPromotion(root, p.name, p.hash);
    const open = evals.listOpenSkillRegressionSources(root, p.name, p.hash);
    console.log(JSON.stringify({skill:p.name, hash:p.hash.slice(0,12), ready:gate.ready, status:gate.status, reasons:gate.reasons, openRegressionSources:open.length}));
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log(JSON.stringify({skill:p.name, error:msg.split('\n')[0]}));
  }
}
