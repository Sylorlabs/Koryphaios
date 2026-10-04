import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  fixtureTextEquals,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const NEARBY_PRIVACY = 'privacy-engineering-full-task-1-individual';
const DELETE_PRIVACY = 'privacy-engineering-full-task-2-individual';
const DASHBOARD_WEB = 'web-security-full-task-1';
const ANALYTICS_WEB = 'web-security-full-task-2';
const SECURE_BOOT = 'embedded-device-security-full-task-1-individual';
const DEVICE_LIFECYCLE = 'embedded-device-security-full-task-2-individual';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

const PRIVACY_SOURCE = `export interface NearbyPolicy {
  adoptionFields:string[];
  nearbyFields:string[];
  retainPreciseLocationMinutes:number;
  retainStableDeviceId:boolean;
  deriveHomeWork:boolean;
  optOutSuppressesFuture:boolean;
  deletesPriorDerivedProfile:boolean;
  tombstoneQueuedEvents:boolean;
  backupRestoreReappliesSuppression:boolean;
}
export class NearbySystem {
  analytics:string[]=[];recommendations=new Set<string>();queue:Array<{user:string;kind:string}>=[];preciseHistory=new Map<string,string[]>();
  constructor(readonly policy:NearbyPolicy){}
  adoption(user:string,email:string,deviceId:string){const values={user,email,deviceId};for(const f of this.policy.adoptionFields)this.analytics.push('adopt:'+f+':'+(values as any)[f]);}
  nearby(user:string,precise:string){if(this.policy.nearbyFields.includes('preciseLocation'))this.preciseHistory.set(user,[...(this.preciseHistory.get(user)??[]),precise]);this.recommendations.add(user);this.queue.push({user,kind:'derive-profile'});}
  optOut(user:string){if(this.policy.deletesPriorDerivedProfile)this.recommendations.delete(user);if(this.policy.tombstoneQueuedEvents)this.queue=this.queue.filter(e=>e.user!==user);}
  drainQueue(){for(const e of this.queue)if(e.kind==='derive-profile')this.recommendations.add(e.user);this.queue=[];}
}

export interface DeletionPolicy { stores:string[]; durableTombstone:boolean; cdcChecksTombstone:boolean; backupImmutableDays:number; restoreReplaysTombstonesBeforeServing:boolean; externalOrModelWeightsClaimedDeleted:boolean; statutoryClaim:boolean }
export class DeletionSystem {
  primary=new Set(['u1']);objects=new Set(['u1']);warehouse=new Set(['u1']);search=new Set(['u1']);support=new Set(['u1']);personalization=new Set(['u1']);cdc=['u1','u1'];tombstones=new Set<string>();
  deleteUser(user:string,policy:DeletionPolicy){this.primary.delete(user); // BUG: other copies and stale CDC remain.
    if(policy.durableTombstone)this.tombstones.add(user);}
  drainCdc(policy:DeletionPolicy){for(const user of this.cdc){if(policy.cdcChecksTombstone&&this.tombstones.has(user))continue;this.search.add(user);this.personalization.add(user);}this.cdc=[];}
  restoreBackup(user:string,policy:DeletionPolicy){this.primary.add(user);this.objects.add(user);this.warehouse.add(user);this.search.add(user);this.support.add(user);this.personalization.add(user);if(policy.restoreReplaysTombstonesBeforeServing&&this.tombstones.has(user)){this.primary.delete(user);this.objects.delete(user);this.warehouse.delete(user);this.search.delete(user);this.support.delete(user);this.personalization.delete(user);}}
  live(user:string){return{primary:this.primary.has(user),object:this.objects.has(user),warehouse:this.warehouse.has(user),search:this.search.has(user),support:this.support.has(user),personalization:this.personalization.has(user)}}
}
`;

const nearbyMaterializer: SkillEvalFixtureMaterializer = {
  id: 'privacy-engineering/nearby-data-minimization@1',
  matches: (s) => s.id === NEARBY_PRIVACY,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-nearby-privacy'));
    writeFixtureFile(d, 'src/privacy.ts', PRIVACY_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'evidence/field-inventory.json',
      `${JSON.stringify({ fields: ['preciseLocationHistory', 'coarseLocation', 'addressBookHashes', 'stableDeviceId', 'accountEmail', 'homeWorkProfile', 'analyticsAdoptionEvent', 'recommendationProfile'], purposes: ['nearby-opted-in-friends', 'aggregate-adoption'], queue: ['stale derive-profile for u1'], backup: { immutable: true, restoreCanReintroduceSuppressedState: true } }, null, 2)}\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Nearby-friends privacy lifecycle fixture

Repair \`NearbySystem\` only where code behavior is needed and write \`.kory-eval/nearby-policy.json\` as \`NearbyPolicy\`. Aggregate adoption may not include account email, precise location, contact hashes or a stable device identifier; use only a bounded/pseudonymous aggregate event identity if one remains and explain residual linkage. Nearby matching may use the minimum location/contact precision required, but do not retain long-lived precise history or derive home/work because neither is required here.

Opt-out must stop future use, remove the prior recommendation/profile state promised by policy, and neutralize the supplied stale queued event so it cannot repopulate the profile. Backups are immutable in this fixture; report that limitation and reapply suppression/tombstones on restore rather than claiming selective immediate backup deletion.

Write \`.kory-eval/nearby-privacy-evidence.json\` mapping every supplied raw/derived field to source/purpose/store/recipient/retention/deletion, before/after emitted events and durable state, stale-queue replay, backup restore behavior, residual pseudonymous linkage, and \`jurisdictionSpecificLegalClaim:false\`.
`,
    );
  },
};
const nearbyScorer: SkillEvalDeterministicScorer = {
  id: 'privacy-engineering/nearby-data-minimization-scorer@2',
  scenarioIds: [NEARBY_PRIVACY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{NearbySystem,type NearbyPolicy}from'../src/privacy';const p=JSON.parse(readFileSync('.kory-eval/nearby-policy.json','utf8')) as NearbyPolicy;
test('hidden: aggregate adoption excludes unnecessary direct/precise identifiers',()=>{for(const f of ['email','accountEmail','preciseLocation','preciseLocationHistory','addressBookHashes','stableDeviceId'])expect(p.adoptionFields).not.toContain(f);expect(p.retainStableDeviceId).toBe(false);expect(p.deriveHomeWork).toBe(false);expect(p.retainPreciseLocationMinutes).toBeGreaterThanOrEqual(0);expect(p.retainPreciseLocationMinutes).toBeLessThanOrEqual(60);});
test('hidden: aggregate adoption cannot reuse the caller account identity as its event identity',()=>{const s=new NearbySystem(p);s.adoption('u1','u1@example.test','device-stable');const first=[...s.analytics];expect(first.length).toBeGreaterThan(0);expect(first.join(' ')).not.toContain('u1');expect(first.join(' ')).not.toContain('u1@example.test');expect(first.join(' ')).not.toContain('device-stable');const before=s.analytics.length;s.adoption('u1','u1@example.test','device-stable');const second=s.analytics.slice(before);expect(second.length).toBe(first.length);expect(second.join('|')).not.toBe(first.join('|'));});
test('hidden: opt-out defeats stale queued rehydration',()=>{const s=new NearbySystem(p);s.adoption('u1','u1@example.test','device-stable');s.nearby('u1','32.1,-117.1');expect(s.recommendations.has('u1')).toBe(true);s.optOut('u1');s.drainQueue();expect(p.optOutSuppressesFuture).toBe(true);expect(p.deletesPriorDerivedProfile).toBe(true);expect(p.tombstoneQueuedEvents).toBe(true);expect(s.recommendations.has('u1')).toBe(false);expect(s.analytics.join(' ')).not.toContain('u1@example.test');expect(s.analytics.join(' ')).not.toContain('device-stable');expect(p.backupRestoreReappliesSuppression).toBe(true);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [/stale|queue|opt.?out/iu, /backup|restore/iu]);
    const ev = artifactText(workingDirectory, '.kory-eval/nearby-privacy-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /precise/u.test(ev.text) &&
      /email/u.test(ev.text) &&
      /home|work/u.test(ev.text) &&
      /retention/u.test(ev.text) &&
      /backup/u.test(ev.text) &&
      /pseudonym/u.test(ev.text) &&
      /false/u.test(ev.text);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `data minimization/opt-out behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `queue/restore regressions: ${reg ? 'present' : 'missing'}`,
        `field lifecycle evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const deletionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'privacy-engineering/account-deletion-tombstone@1',
  matches: (s) => s.id === DELETE_PRIVACY,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-account-deletion'));
    writeFixtureFile(d, 'src/privacy.ts', PRIVACY_SOURCE);
    writeFixtureFile(
      d,
      'tests/deletion.test.ts',
      `import{expect,test}from'bun:test';import{DeletionSystem}from'../src/privacy';test('starting bug leaves object',()=>{const s=new DeletionSystem();s.deleteUser('u1',{stores:[],durableTombstone:false,cdcChecksTombstone:false,backupImmutableDays:30,restoreReplaysTombstonesBeforeServing:false,externalOrModelWeightsClaimedDeleted:false,statutoryClaim:false});expect(s.live('u1').object).toBe(true);});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Account deletion propagation fixture

Repair \`DeletionSystem.deleteUser\` so the product-policy deletion/suppression outcome is applied to primary row, object, warehouse identity, search/vector, support export and personalization profile, while recording a durable tombstone. Stale at-least-once CDC must consult that tombstone before any derived rehydration. Backups remain immutable for exactly 30 days; restore must replay deletion/suppression tombstones before restored data can re-enter normal processing.

Write \`.kory-eval/deletion-policy.json\` as \`DeletionPolicy\` with all six live stores, durable tombstone, CDC guard, 30-day immutable backup, restore replay, and false claims for external/model-weight deletion/statutory conclusions. Add stale redelivery and restore regressions. Write \`.kory-eval/deletion-evidence.json\` with observable state for each live copy and direct/simulated/unavailable labels.
`,
    );
  },
};
const deletionScorer: SkillEvalDeterministicScorer = {
  id: 'privacy-engineering/account-deletion-tombstone-scorer@1',
  scenarioIds: [DELETE_PRIVACY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{DeletionSystem,type DeletionPolicy}from'../src/privacy';const p=JSON.parse(readFileSync('.kory-eval/deletion-policy.json','utf8')) as DeletionPolicy;
test('hidden: all inspectable live copies satisfy deletion policy',()=>{const required=['primary','object','warehouse','search','support','personalization'];for(const s of required)expect(p.stores).toContain(s);const sys=new DeletionSystem();sys.deleteUser('u1',p);expect(Object.values(sys.live('u1')).every(v=>!v)).toBe(true);expect(sys.tombstones.has('u1')).toBe(true);});
test('hidden: stale CDC and 30-day restore cannot rehydrate tombstoned user',()=>{const sys=new DeletionSystem();sys.deleteUser('u1',p);sys.drainCdc(p);expect(Object.values(sys.live('u1')).every(v=>!v)).toBe(true);sys.restoreBackup('u1',p);expect(Object.values(sys.live('u1')).every(v=>!v)).toBe(true);expect(p.backupImmutableDays).toBe(30);expect(p.cdcChecksTombstone).toBe(true);expect(p.restoreReplaysTombstonesBeforeServing).toBe(true);expect(p.externalOrModelWeightsClaimedDeleted).toBe(false);expect(p.statutoryClaim).toBe(false);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /cdc|redeliver|stale/iu,
      /restore|backup|tombstone/iu,
    ]);
    const ev = artifactText(workingDirectory, '.kory-eval/deletion-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /primary/u.test(ev.text) &&
      /warehouse/u.test(ev.text) &&
      /search|vector/u.test(ev.text) &&
      /support/u.test(ev.text) &&
      /personal/u.test(ev.text) &&
      /direct|simulated|unavailable/u.test(ev.text);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `deletion/CDC/restore behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `rehydration regressions: ${reg ? 'present' : 'missing'}`,
        `copy-by-copy evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const WEB_POLICY = `export interface DashboardWebSpec {
  sourceSinkInventory:Array<{source:string;transform:string;sink:string;control:string}>;
  richText:{legacyDangerousSinkRemovedOrSanitized:boolean;ordinaryTextEscaped:boolean;htmlSanitizer:boolean;attributeContextSafe:boolean;navigationUrlValidated:boolean;sanitizerPolicy:string;allowedUrlSchemes:string[];eventHandlerAttributesAllowed:boolean};
  csp:{nonceBased:boolean;unsafeInline:boolean;unsafeEval:boolean;reportOnlyRollout:boolean;frameSrc:string[];connectSrc:string[];primaryXssFix:boolean;directives:string[];noncePropagation:string;reportEndpoint:string;enforcementVerification:string[]};
  csrf:{serverValidatedToken:boolean;originComplement:boolean;fetchMetadataComplement:boolean;sameSiteComplement:boolean;tokenTransport:'header'|'form-field';sessionBound:boolean;allCookieMutationsCovered:boolean;rejectMissingOrInvalid:boolean};
  postMessage:{expectedOrigin:string;validateSchema:boolean;validateSource:boolean;outgoingTargetOrigin:string;expectedSourceContext:string;schemaFields:string[];contextCorrelation:boolean};
  returnNavigation:{sameOriginOrRelativeOnly:boolean;externalAllowlist:string[]};
  cookie:{secure:boolean;httpOnly:boolean;sameSite:'Lax'|'Strict'|'None';domain:string|null;path:string};
  tenantAuthorizationOwnedBy:string;
}
export interface MessageAttempt{origin:string;sourceMatches:boolean;schemaValid:boolean}
export function acceptPaymentMessage(s:DashboardWebSpec,a:MessageAttempt):boolean{return a.origin===s.postMessage.expectedOrigin&&a.sourceMatches&&a.schemaValid&&s.postMessage.validateSchema&&s.postMessage.validateSource}
export function returnUrlAllowed(s:DashboardWebSpec,url:string):boolean{if(url.startsWith('/')&&!url.startsWith('//'))return true;try{const u=new URL(url);return s.returnNavigation.externalAllowlist.includes(u.origin)}catch{return false}}

export interface AnalyticsWebSpec {
  cors:{origins:string[];methods:string[];headers:string[];credentials:boolean;reflectOrigin:boolean;wildcard:boolean};
  reportFetch:{allowedOrigin:string;hashIsDirectUrl:boolean;allowPathIdsOnly:boolean};
  credentials:{architecture:'bff-http-only-cookie'|'server-session'|'other-protected';localStorageAccessToken:boolean;csrfServerValidated:boolean};
  framing:{frameAncestors:string[]};
  rendering:{safeText:boolean;explicitSanitization:boolean};
  csp:{reporting:boolean;primaryXssFix:boolean};oauthOwnedBy:string;authorizationOwnedBy:string;
}
export function corsAllowed(s:AnalyticsWebSpec,origin:string,method:string,headers:string[]):boolean{return s.cors.origins.includes(origin)&&s.cors.methods.includes(method)&&headers.every(h=>s.cors.headers.map(x=>x.toLowerCase()).includes(h.toLowerCase()))&&!s.cors.reflectOrigin&&!s.cors.wildcard}
export function reportUrl(s:AnalyticsWebSpec,hash:string):string|null{if(s.reportFetch.hashIsDirectUrl)return hash.slice(1);const id=hash.replace(/^#/,'');if(!s.reportFetch.allowPathIdsOnly||!/^[A-Za-z0-9_-]+$/.test(id))return null;const base=s.reportFetch.allowedOrigin.endsWith('/')?s.reportFetch.allowedOrigin.slice(0,-1):s.reportFetch.allowedOrigin;return base+'/reports/'+id}
`;
const WEB_CORPUS = `${JSON.stringify(
  {
    dashboard: {
      paymentOrigin: 'https://payments.example.test',
      messages: [
        {
          origin: 'https://payments.example.test',
          sourceMatches: true,
          schemaValid: true,
          expected: true,
        },
        { origin: 'https://evil.example', sourceMatches: true, schemaValid: true, expected: false },
        {
          origin: 'https://payments.example.test',
          sourceMatches: false,
          schemaValid: true,
          expected: false,
        },
        {
          origin: 'https://payments.example.test',
          sourceMatches: true,
          schemaValid: false,
          expected: false,
        },
      ],
      returnUrls: ['/tickets/7', 'https://evil.example/phish', '//evil.example/x'],
    },
    analytics: {
      appOrigin: 'https://app.example.com',
      apiOrigin: 'https://api.example.com',
      reportOrigin: 'https://reports.example.net',
      evilOrigin: 'https://evil.example',
    },
  },
  null,
  2,
)}\n`;
const dashboardMaterializer: SkillEvalFixtureMaterializer = {
  id: 'web-security/dashboard-browser-boundaries@2',
  matches: (s) => s.id === DASHBOARD_WEB,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-dashboard-web-security'));
    writeFixtureFile(d, 'src/web-policy.ts', WEB_POLICY);
    writeFixtureFile(d, 'evidence/web-corpus.json', WEB_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Browser dashboard security fixture

Write \`.kory-eval/dashboard-web.json\` as \`DashboardWebSpec\`. Inventory the supplied rich-text, return-navigation, cookie-authenticated mutation, iframe, and postMessage sources through their transforms to concrete sinks/controls. The legacy HTML execution sink is removed or passes through a context-appropriate sanitizer; record the sanitizer policy, allowed URL schemes, and event-handler-attribute behavior. Ordinary text is escaped and navigation URLs are validated rather than generically filtered. CSP is strict nonce-based defense in depth with explicit default/script/style/object/base/framing directives, nonce propagation, reporting endpoint, Report-Only→enforcement checks, no broad unsafe-inline/eval, and is explicitly not the primary XSS fix.

Every cookie-authenticated mutation has a server-validated, session-bound CSRF token with explicit transport and reject behavior; SameSite, Origin and Fetch Metadata are complementary signals. Payment postMessage accepts only the exact supplied origin, expected source/context, correlated transaction context, and explicit schema; outgoing target origin is exact, never \`*\`. Return navigation is relative/same-origin unless explicitly allowlisted. Session cookie is Secure/HttpOnly, appropriately SameSite, host-only unless a domain is strictly required, and narrow Path. Tenant authorization stays \`authorization-security\`.
`,
    );
  },
};
const dashboardScorer: SkillEvalDeterministicScorer = {
  id: 'web-security/dashboard-browser-boundaries-scorer@3',
  scenarioIds: [DASHBOARD_WEB],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{acceptPaymentMessage,returnUrlAllowed,type DashboardWebSpec}from'../src/web-policy';const s=JSON.parse(readFileSync('.kory-eval/dashboard-web.json','utf8')) as DashboardWebSpec;const c=JSON.parse(readFileSync('evidence/web-corpus.json','utf8')) as any;
test('hidden: source/sink and sink-specific rendering policy are concrete',()=>{const inventory=JSON.stringify(s.sourceSinkInventory).toLowerCase();for(const term of ['rich','return','mutation','iframe','postmessage'])expect(inventory).toContain(term);expect(s.sourceSinkInventory.length).toBeGreaterThanOrEqual(5);expect(s.richText.legacyDangerousSinkRemovedOrSanitized).toBe(true);expect(s.richText.ordinaryTextEscaped).toBe(true);expect(s.richText.htmlSanitizer).toBe(true);expect(s.richText.attributeContextSafe).toBe(true);expect(s.richText.navigationUrlValidated).toBe(true);expect(s.richText.sanitizerPolicy.length).toBeGreaterThan(8);expect(s.richText.allowedUrlSchemes).toContain('https');expect(s.richText.allowedUrlSchemes).not.toContain('javascript');expect(s.richText.eventHandlerAttributesAllowed).toBe(false);});
test('hidden: CSP and CSRF protocols are explicit and fail closed',()=>{expect(s.csp.nonceBased).toBe(true);expect(s.csp.unsafeInline).toBe(false);expect(s.csp.unsafeEval).toBe(false);expect(s.csp.reportOnlyRollout).toBe(true);expect(s.csp.primaryXssFix).toBe(false);const directives=s.csp.directives.join(' ').toLowerCase();for(const d of ['default-src','script-src','object-src','base-uri','frame-ancestors'])expect(directives).toContain(d);expect(s.csp.noncePropagation.length).toBeGreaterThan(8);expect(s.csp.reportEndpoint.length).toBeGreaterThan(0);expect(s.csp.enforcementVerification.length).toBeGreaterThanOrEqual(2);expect(s.csrf.serverValidatedToken).toBe(true);expect(s.csrf.sessionBound).toBe(true);expect(s.csrf.allCookieMutationsCovered).toBe(true);expect(s.csrf.rejectMissingOrInvalid).toBe(true);expect(['header','form-field']).toContain(s.csrf.tokenTransport);});
test('hidden: postMessage/return/cookie boundaries fail closed',()=>{for(const m of c.dashboard.messages)expect(acceptPaymentMessage(s,m),m.origin).toBe(m.expected);expect(s.postMessage.expectedOrigin).toBe(c.dashboard.paymentOrigin);expect(s.postMessage.outgoingTargetOrigin).toBe(c.dashboard.paymentOrigin);expect(s.postMessage.expectedSourceContext.length).toBeGreaterThan(0);expect(s.postMessage.schemaFields.length).toBeGreaterThan(0);expect(s.postMessage.contextCorrelation).toBe(true);expect(returnUrlAllowed(s,'/tickets/7')).toBe(true);expect(returnUrlAllowed(s,'https://evil.example/phish')).toBe(false);expect(returnUrlAllowed(s,'//evil.example/x')).toBe(false);expect(s.cookie.secure).toBe(true);expect(s.cookie.httpOnly).toBe(true);expect(s.cookie.domain).toBeNull();expect(s.cookie.path.startsWith('/')).toBe(true);expect(s.tenantAuthorizationOwnedBy).toBe('authorization-security');});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/web-policy.ts', WEB_POLICY);
    const corpus = fixtureTextEquals(workingDirectory, 'evidence/web-corpus.json', WEB_CORPUS);
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `browser source/sink/postMessage vectors: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const analyticsMaterializer: SkillEvalFixtureMaterializer = {
  id: 'web-security/analytics-spa-boundaries@2',
  matches: (s) => s.id === ANALYTICS_WEB,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-analytics-web-security'));
    writeFixtureFile(d, 'src/web-policy.ts', WEB_POLICY);
    writeFixtureFile(d, 'evidence/web-corpus.json', WEB_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Analytics SPA browser-security fixture

Write \`.kory-eval/analytics-web.json\` as \`AnalyticsWebSpec\`. Credentialed CORS accepts only the exact trusted app origin and explicitly required methods/headers; never reflect arbitrary Origin or use wildcard credentials. URL hash is an identifier/path selector, not an arbitrary URL, and cannot make the trusted app attach its own credentials/CSRF material to attacker-selected API/report destinations.

Move JavaScript-readable access-token storage to a server/BFF or other protected session model; this fixture expects no localStorage access token and server-validated CSRF where cookie sessions mutate state. Set explicit \`frame-ancestors\` so arbitrary sites cannot frame the app. Customer report data reaches safe text or explicit sanitization. CSP reporting is defense in depth, not the XSS fix. OAuth stays \`oauth-oidc\`; API object authorization stays \`authorization-security\`.
`,
    );
  },
};
const analyticsScorer: SkillEvalDeterministicScorer = {
  id: 'web-security/analytics-spa-boundaries-scorer@2',
  scenarioIds: [ANALYTICS_WEB],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{corsAllowed,reportUrl,type AnalyticsWebSpec}from'../src/web-policy';const s=JSON.parse(readFileSync('.kory-eval/analytics-web.json','utf8')) as AnalyticsWebSpec;const c=JSON.parse(readFileSync('evidence/web-corpus.json','utf8')) as any;
test('hidden: credentialed CORS exact origin/method/header',()=>{expect(s.cors.credentials).toBe(true);expect(corsAllowed(s,c.analytics.appOrigin,s.cors.methods[0],s.cors.headers.slice(0,1))).toBe(true);expect(corsAllowed(s,c.analytics.evilOrigin,s.cors.methods[0],s.cors.headers.slice(0,1))).toBe(false);expect(s.cors.reflectOrigin).toBe(false);expect(s.cors.wildcard).toBe(false);});
test('hidden: hash cannot forge privileged absolute request and browser credentials/framing/rendering are bounded',()=>{expect(reportUrl(s,'#quarterly_7')).toBe(c.analytics.reportOrigin+'/reports/quarterly_7');expect(reportUrl(s,'#https://evil.example/steal')).toBeNull();expect(s.credentials.localStorageAccessToken).toBe(false);expect(['bff-http-only-cookie','server-session','other-protected']).toContain(s.credentials.architecture);expect(s.credentials.csrfServerValidated).toBe(true);expect(s.framing.frameAncestors.length).toBeGreaterThan(0);expect(s.framing.frameAncestors).not.toContain('*');expect(s.rendering.safeText||s.rendering.explicitSanitization).toBe(true);expect(s.csp.primaryXssFix).toBe(false);expect(s.oauthOwnedBy).toBe('oauth-oidc');expect(s.authorizationOwnedBy).toBe('authorization-security');});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/web-policy.ts', WEB_POLICY);
    const corpus = fixtureTextEquals(workingDirectory, 'evidence/web-corpus.json', WEB_CORPUS);
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `CORS/hash/session/framing vectors: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const DEVICE_SIM = `export interface Image{id:string;version:number;product:string;signed:boolean;signatureValid:boolean;corrupt:boolean;authorizedRecovery?:boolean}
export interface BootConfig{productionKeyHash:string;product:string;minimumVersion:number;bootloaderVerifiesSignature:boolean;bootloaderVerifiesProduct:boolean;rollbackStateProtected:boolean;recoveryRequiresAuthorization:boolean;debugFuseObserved:boolean}
export function bootDecision(c:BootConfig,i:Image):'boot'|'recovery'|'reject-signature'|'reject-product'|'reject-rollback'|'reject-corrupt'{if(i.corrupt)return'reject-corrupt';if(c.bootloaderVerifiesSignature&&(!i.signed||!i.signatureValid))return'reject-signature';if(c.bootloaderVerifiesProduct&&i.product!==c.product)return'reject-product';if(i.version<c.minimumVersion&&!i.authorizedRecovery)return'reject-rollback';if(i.authorizedRecovery)return c.recoveryRequiresAuthorization?'recovery':'boot';return'boot'}
export type UpdateStep='write-inactive'|'verify-inactive'|'mark-pending'|'boot-pending'|'commit-version';
export function powerCutRecovery(c:BootConfig,current:Image,candidate:Image,step:UpdateStep):string{const decision=bootDecision(c,candidate);if(['write-inactive','verify-inactive'].includes(step)||decision!=='boot')return current.id;if(step==='mark-pending'||step==='boot-pending')return candidate.id;return candidate.id}

export interface DeviceConfig{interfaces:Record<'swd'|'uart'|'romUsb',string[]>;swdReadoutLocked:boolean;observedProductionLockState:boolean;authorizedRecoveryOnly:boolean;credentialHardwareBacked:boolean;credentialExportable:boolean;resetDestroysOrInvalidatesCredential:boolean;decommissionDestroysCredential:boolean;fleetRevocationCheckedOnRecovery:boolean;algorithmOwnedBy:string;invasiveResistanceClaimed:boolean;faultInjectionResistanceClaimed:boolean}
export function interfaceCan(c:DeviceConfig,name:'swd'|'uart'|'romUsb',privilege:string):boolean{return c.interfaces[name].includes(privilege)}
`;
const DEVICE_CORPUS = `${JSON.stringify(
  {
    board: 'mcu-rev-c',
    keyHash: 'prod-key-hash-2026',
    product: 'device-x',
    images: [
      {
        id: 'current',
        version: 7,
        product: 'device-x',
        signed: true,
        signatureValid: true,
        corrupt: false,
      },
      {
        id: 'older',
        version: 5,
        product: 'device-x',
        signed: true,
        signatureValid: true,
        corrupt: false,
      },
      {
        id: 'wrong-product',
        version: 8,
        product: 'device-y',
        signed: true,
        signatureValid: true,
        corrupt: false,
      },
      {
        id: 'unsigned',
        version: 8,
        product: 'device-x',
        signed: false,
        signatureValid: false,
        corrupt: false,
      },
      {
        id: 'corrupt',
        version: 8,
        product: 'device-x',
        signed: true,
        signatureValid: true,
        corrupt: true,
      },
      {
        id: 'recovery',
        version: 3,
        product: 'device-x',
        signed: true,
        signatureValid: true,
        corrupt: false,
        authorizedRecovery: true,
      },
    ],
    steps: ['write-inactive', 'verify-inactive', 'mark-pending', 'boot-pending', 'commit-version'],
    observed: { serialBootLog: true, keyHashFuseRecord: true, productionLockRegister: true },
    emulator: { physicalFuseProof: false, debugLockProof: false },
  },
  null,
  2,
)}\n`;
const secureBootMaterializer: SkillEvalFixtureMaterializer = {
  id: 'embedded-device-security/secure-boot-ota@1',
  matches: (s) => s.id === SECURE_BOOT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-secure-boot'));
    writeFixtureFile(d, 'src/device-sim.ts', DEVICE_SIM);
    writeFixtureFile(d, 'evidence/device-corpus.json', DEVICE_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Representative MCU secure-boot/OTA fixture

Write \`.kory-eval/boot-config.json\` as \`BootConfig\` using the supplied production key hash/product. Immutable Boot ROM trusts the production key-hash/fuse record and authenticates the mutable bootloader; bootloader authenticates application/recovery image signature and product. Protected rollback state rejects the signed older image. Recovery is separately authorized rather than a signature-only rollback bypass.

The board-observed current image boots; unsigned, corrupt and wrong-product fixtures reject before execution. Exercise every supplied power-cut transition and show it recovers to authenticated current/candidate/authorized recovery without executing an unverified slot. Write \`.kory-eval/boot-evidence.json\` keyed by image digest/version and cut step with serial decision evidence, board-observed vs emulator-only labels. Do not infer debug-lock/fuse/physical-extraction resistance from emulator behavior; only the supplied key-hash fuse record is board-observed here.
`,
    );
  },
};
const secureBootScorer: SkillEvalDeterministicScorer = {
  id: 'embedded-device-security/secure-boot-ota-scorer@3',
  scenarioIds: [SECURE_BOOT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{bootDecision,powerCutRecovery,type BootConfig,type Image,type UpdateStep}from'../src/device-sim';const c=JSON.parse(readFileSync('.kory-eval/boot-config.json','utf8')) as BootConfig;const x=JSON.parse(readFileSync('evidence/device-corpus.json','utf8')) as any;const by=(id:string)=>x.images.find((i:any)=>i.id===id) as Image;
test('hidden: chain rejects invalid/wrong/rollback and accepts current/recovery',()=>{expect(c.productionKeyHash).toBe(x.keyHash);expect(c.product).toBe(x.product);expect(c.bootloaderVerifiesSignature).toBe(true);expect(c.bootloaderVerifiesProduct).toBe(true);expect(c.rollbackStateProtected).toBe(true);expect(bootDecision(c,by('current'))).toBe('boot');expect(bootDecision(c,by('unsigned'))).toBe('reject-signature');expect(bootDecision(c,by('corrupt'))).toBe('reject-corrupt');expect(bootDecision(c,by('wrong-product'))).toBe('reject-product');expect(bootDecision(c,by('older'))).toBe('reject-rollback');expect(bootDecision(c,by('recovery'))).toBe('recovery');});
test('hidden: every power-cut state recovers to authenticated candidate/current',()=>{for(const step of x.steps as UpdateStep[]){const id=powerCutRecovery(c,by('current'),{...by('current'),id:'new',version:8},step);expect(['current','new','recovery']).toContain(id);}});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/device-sim.ts', DEVICE_SIM);
    const corpus = fixtureTextEquals(
      workingDirectory,
      'evidence/device-corpus.json',
      DEVICE_CORPUS,
    );
    const ev = artifactText(workingDirectory, '.kory-eval/boot-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /serial|boot.?log/u.test(ev.text) &&
      /board/u.test(ev.text) &&
      /emulat|simulat/u.test(ev.text) &&
      /unsigned/u.test(ev.text) &&
      /wrong-product|wrong product/u.test(ev.text) &&
      /power|cut/u.test(ev.text) &&
      !/physical.*(?:proved|verified)|debug.*(?:proved|verified)/u.test(ev.text);
    const passed = hidden.passed && fixed && corpus && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `secure-boot/rollback/cut state machine: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed board corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `board/emulator claim boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const deviceLifecycleMaterializer: SkillEvalFixtureMaterializer = {
  id: 'embedded-device-security/debug-credential-lifecycle@1',
  matches: (s) => s.id === DEVICE_LIFECYCLE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-device-lifecycle'));
    writeFixtureFile(d, 'src/device-sim.ts', DEVICE_SIM);
    writeFixtureFile(d, 'evidence/device-corpus.json', DEVICE_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Production device debug/credential lifecycle fixture

Write \`.kory-eval/device-config.json\` as \`DeviceConfig\`. Enumerate SWD, UART and ROM USB authority under normal and temporary-physical-possession states. The supplied production lock register is observed on the representative board: SWD cannot perform unrestricted firmware/secret readout, while only the explicitly authenticated recovery path remains. UART/ROM download authority must be bounded similarly.

The per-device credential is provisioned into a hardware-backed slot, is non-exportable, remains protected through update/recovery/RMA, and has explicit rotate/revoke semantics. Factory reset must destroy/invalidate local credential authority; decommission destroys it and fleet revocation prevents a reset/recovered device silently regaining authorization. Algorithm design stays \`applied-cryptography\`. Set invasive-extraction and fault-injection resistance claims false because they were not exercised.

Write \`.kory-eval/device-lifecycle-evidence.json\` with observed production lock state, interface attempts, credential lifecycle, reset/decommission + fleet record and hardware-observed vs documentation/simulation labels.
`,
    );
  },
};
const deviceLifecycleScorer: SkillEvalDeterministicScorer = {
  id: 'embedded-device-security/debug-credential-lifecycle-scorer@2',
  scenarioIds: [DEVICE_LIFECYCLE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{interfaceCan,type DeviceConfig}from'../src/device-sim';const c=JSON.parse(readFileSync('.kory-eval/device-config.json','utf8')) as DeviceConfig;
test('hidden: production debug cannot read firmware/secrets while recovery remains explicit',()=>{expect(c.observedProductionLockState).toBe(true);expect(c.swdReadoutLocked).toBe(true);expect(interfaceCan(c,'swd','firmware-readout')).toBe(false);expect(interfaceCan(c,'swd','secret-export')).toBe(false);expect(c.authorizedRecoveryOnly).toBe(true);});
test('hidden: per-device credential/reset/decommission lifecycle is bounded',()=>{expect(c.credentialHardwareBacked).toBe(true);expect(c.credentialExportable).toBe(false);expect(c.resetDestroysOrInvalidatesCredential).toBe(true);expect(c.decommissionDestroysCredential).toBe(true);expect(c.fleetRevocationCheckedOnRecovery).toBe(true);expect(c.algorithmOwnedBy).toBe('applied-cryptography');expect(c.invasiveResistanceClaimed).toBe(false);expect(c.faultInjectionResistanceClaimed).toBe(false);});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/device-sim.ts', DEVICE_SIM);
    const ev = artifactText(workingDirectory, '.kory-eval/device-lifecycle-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /swd/u.test(ev.text) &&
      /uart/u.test(ev.text) &&
      /rom/u.test(ev.text) &&
      /reset/u.test(ev.text) &&
      /decommission/u.test(ev.text) &&
      /revoke/u.test(ev.text) &&
      /observed/u.test(ev.text) &&
      /simulat|document/u.test(ev.text);
    const passed = hidden.passed && fixed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `debug/credential lifecycle policy: ${hidden.passed ? 'pass' : 'fail'}`,
        `interface/lifecycle evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    nearbyMaterializer,
    deletionMaterializer,
    dashboardMaterializer,
    analyticsMaterializer,
    secureBootMaterializer,
    deviceLifecycleMaterializer,
  ];
export const PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  nearbyScorer,
  deletionScorer,
  dashboardScorer,
  analyticsScorer,
  secureBootScorer,
  deviceLifecycleScorer,
];
