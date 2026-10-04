import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  fixtureTextEquals,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const CONSUMER_AUTH = 'secure-authentication-full-task-1';
const ADMIN_AUTH = 'secure-authentication-full-task-2';
const NATIVE_OAUTH = 'oauth-oidc-full-task-1';
const ENTERPRISE_OIDC = 'oauth-oidc-full-task-2';
const KEY_HIERARCHY = 'secrets-key-management-full-task-1';
const CREDENTIAL_ROTATION = 'secrets-key-management-full-task-2';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

const AUTH_POLICY = `export type AuthMethod='password'|'webauthn'|'otp'|'recovery-code'|'recovery-email'|'helpdesk';
export interface ConsumerAuthSpec {
  password:{verifier:string;verifierParameters:string;salted:boolean;memoryHard:boolean;compromisedScreening:boolean;rejectCompromisedOrCommon:boolean;antiEnumeration:boolean;throttleDimensions:string[];progressiveBackoff:boolean;throttlePolicy:string;globalAttackerLockout:boolean};
  webauthn:{challengeFreshnessSeconds:number;rpId:string;origins:string[];requireUserVerification:boolean;verifyCredentialIdentity:boolean;verifySignature:boolean;duplicateEnrollmentRejected:boolean;enrollmentRequiresCurrentAssurance:boolean};
  recovery:{codesSingleUse:boolean;codesProtectedLikeAuthenticator:boolean;lostDeviceRequiresDeliberateRecovery:boolean;recoveryEmailAloneResetsAll:boolean;deliberateRecoveryAssurance:string[];authenticatorReplacementRequiresCurrentOrRecoveryAssurance:boolean;strongPolicyBypassAllowed:boolean};
  freshAuth:{maxAgeSeconds:number;primaryEmail:boolean;removeAuthenticator:boolean;resetAllAuthenticators:boolean;exportRecoveryMaterial:boolean};
  recoveryResponse:{revokeExistingSessions:boolean;rotateRefreshCredentials:boolean;securityEventRecorded:boolean};
  compromise:{revokeExistingSessions:boolean;rotateRefreshCredentials:boolean;securityEventRecorded:boolean};
  phishingResistantMethods:AuthMethod[];
  nonPhishingResistantMethods:AuthMethod[];
  oauthOidcInScope:boolean;
}
export interface WebAuthnAttempt{challengeAgeSeconds:number;rpId:string;origin:string;credentialKnown:boolean;signatureValid:boolean;userVerified:boolean}
export function acceptWebAuthn(spec:ConsumerAuthSpec,a:WebAuthnAttempt):boolean{return a.challengeAgeSeconds>=0&&a.challengeAgeSeconds<=spec.webauthn.challengeFreshnessSeconds&&a.rpId===spec.webauthn.rpId&&spec.webauthn.origins.includes(a.origin)&&(!spec.webauthn.verifyCredentialIdentity||a.credentialKnown)&&(!spec.webauthn.verifySignature||a.signatureValid)&&(!spec.webauthn.requireUserVerification||a.userVerified)}

export interface AdminAuthSpec {
  assurance:Record<AuthMethod,{phishingResistant:boolean;adminQualifying:boolean}>;
  adminFreshnessSeconds:number;
  factorChangesRequireStrongOrRecovery:boolean;
  factorChangeSecurityEvent:boolean;
  recoveryCodeSingleUse:boolean;
  recoveryCodePostUseRestriction:boolean;
  helpdesk:{knowledgeQuestionsSufficient:boolean;identityAuthorityChecks:boolean;audited:boolean;canDisableStrongPolicy:boolean};
  oauthOidcInScope:boolean;
  authorizationInScope:boolean;
}
export function canAdmin(spec:AdminAuthSpec,method:AuthMethod,ageSeconds:number):boolean{const a=spec.assurance[method];return !!a?.adminQualifying&&a.phishingResistant&&ageSeconds>=0&&ageSeconds<=spec.adminFreshnessSeconds}
`;

const AUTH_CORPUS = `${JSON.stringify(
  {
    rpId: 'accounts.example.test',
    allowedOrigins: ['https://accounts.example.test'],
    webauthn: [
      {
        id: 'valid',
        challengeAgeSeconds: 15,
        rpId: 'accounts.example.test',
        origin: 'https://accounts.example.test',
        credentialKnown: true,
        signatureValid: true,
        userVerified: true,
        expected: true,
      },
      {
        id: 'stale-challenge',
        challengeAgeSeconds: 900,
        rpId: 'accounts.example.test',
        origin: 'https://accounts.example.test',
        credentialKnown: true,
        signatureValid: true,
        userVerified: true,
        expected: false,
      },
      {
        id: 'bad-origin',
        challengeAgeSeconds: 5,
        rpId: 'accounts.example.test',
        origin: 'https://evil.example',
        credentialKnown: true,
        signatureValid: true,
        userVerified: true,
        expected: false,
      },
      {
        id: 'bad-rp',
        challengeAgeSeconds: 5,
        rpId: 'evil.example',
        origin: 'https://accounts.example.test',
        credentialKnown: true,
        signatureValid: true,
        userVerified: true,
        expected: false,
      },
      {
        id: 'unknown-credential',
        challengeAgeSeconds: 5,
        rpId: 'accounts.example.test',
        origin: 'https://accounts.example.test',
        credentialKnown: false,
        signatureValid: true,
        userVerified: true,
        expected: false,
      },
      {
        id: 'bad-signature',
        challengeAgeSeconds: 5,
        rpId: 'accounts.example.test',
        origin: 'https://accounts.example.test',
        credentialKnown: true,
        signatureValid: false,
        userVerified: true,
        expected: false,
      },
      {
        id: 'uv-missing',
        challengeAgeSeconds: 5,
        rpId: 'accounts.example.test',
        origin: 'https://accounts.example.test',
        credentialKnown: true,
        signatureValid: true,
        userVerified: false,
        expected: false,
      },
    ],
    stuffingDimensions: ['account', 'source-network', 'device-or-client', 'global-capacity'],
  },
  null,
  2,
)}\n`;

const consumerAuthMaterializer: SkillEvalFixtureMaterializer = {
  id: 'secure-authentication/consumer-passkey-recovery@2',
  matches: (scenario) => scenario.id === CONSUMER_AUTH,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-consumer-auth'));
    writeFixtureFile(destination, 'src/auth-policy.ts', AUTH_POLICY);
    writeFixtureFile(destination, 'evidence/auth-corpus.json', AUTH_CORPUS);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Consumer authentication/passkey design fixture

Preserve the evaluator/corpus. Write \`.kory-eval/consumer-auth.json\` as \`ConsumerAuthSpec\`. Password verifiers must use a salted current memory-hard password KDF with explicit verifier parameters, reject compromised/common passwords according to the screening policy, avoid existence leaks, and define concrete progressive throttling/backoff across the supplied abuse dimensions without an attacker-controlled global lockout key.

For WebAuthn, use the supplied literal RP ID/origin and validate challenge freshness, credential identity, signature, and user verification. Duplicate enrollment is rejected and enrollment requires current assurance. Recovery codes are single-use/protected like authenticators; recovery email alone may not silently reset all strong authenticators. Define the assurance factors/state transition for lost-device recovery and authenticator replacement so recovery cannot bypass the stronger policy. Primary-email change, authenticator removal/reset, and recovery-material export require fresh auth or the deliberate recovery flow. Successful recovery and suspected compromise each explicitly revoke existing sessions, rotate refresh credentials, and record a security event.

Only WebAuthn/passkey is phishing-resistant in this fixture; explicitly list password, OTP, recovery email/code and helpdesk as non-phishing-resistant. Set \`oauthOidcInScope:false\` and keep federation out of this skill. Label evidence synthetic/design-only.
`,
    );
  },
};

const consumerAuthScorer: SkillEvalDeterministicScorer = {
  id: 'secure-authentication/consumer-passkey-recovery-scorer@3',
  scenarioIds: [CONSUMER_AUTH],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{acceptWebAuthn,type ConsumerAuthSpec,type WebAuthnAttempt}from'../src/auth-policy';
const spec=JSON.parse(readFileSync('.kory-eval/consumer-auth.json','utf8')) as ConsumerAuthSpec;const corpus=JSON.parse(readFileSync('evidence/auth-corpus.json','utf8')) as any;
test('hidden: WebAuthn corpus is enforced by RP/origin/challenge/credential/signature/UV',()=>{expect(spec.webauthn.rpId).toBe(corpus.rpId);expect(spec.webauthn.origins).toEqual(corpus.allowedOrigins);expect(spec.webauthn.challengeFreshnessSeconds).toBeGreaterThan(0);expect(spec.webauthn.challengeFreshnessSeconds).toBeLessThan(900);for(const row of corpus.webauthn)expect(acceptWebAuthn(spec,row as WebAuthnAttempt),row.id).toBe(row.expected);expect(spec.webauthn.duplicateEnrollmentRejected).toBe(true);expect(spec.webauthn.enrollmentRequiresCurrentAssurance).toBe(true);});
test('hidden: password abuse controls are concrete rather than boolean completion claims',()=>{expect(spec.password.verifier.length).toBeGreaterThan(0);expect(spec.password.verifierParameters.length).toBeGreaterThan(8);expect(spec.password.salted).toBe(true);expect(spec.password.memoryHard).toBe(true);expect(spec.password.compromisedScreening).toBe(true);expect(spec.password.rejectCompromisedOrCommon).toBe(true);expect(spec.password.antiEnumeration).toBe(true);for(const d of corpus.stuffingDimensions)expect(spec.password.throttleDimensions).toContain(d);expect(spec.password.progressiveBackoff).toBe(true);expect(spec.password.throttlePolicy.length).toBeGreaterThan(8);expect(spec.password.globalAttackerLockout).toBe(false);});
test('hidden: recovery/replacement/session contracts cannot weaken passkeys',()=>{expect(spec.recovery.codesSingleUse).toBe(true);expect(spec.recovery.codesProtectedLikeAuthenticator).toBe(true);expect(spec.recovery.lostDeviceRequiresDeliberateRecovery).toBe(true);expect(spec.recovery.recoveryEmailAloneResetsAll).toBe(false);expect(spec.recovery.deliberateRecoveryAssurance.length).toBeGreaterThanOrEqual(2);expect(spec.recovery.authenticatorReplacementRequiresCurrentOrRecoveryAssurance).toBe(true);expect(spec.recovery.strongPolicyBypassAllowed).toBe(false);expect(spec.freshAuth.maxAgeSeconds).toBeGreaterThan(0);expect(spec.freshAuth.maxAgeSeconds).toBeLessThanOrEqual(900);for(const k of ['primaryEmail','removeAuthenticator','resetAllAuthenticators','exportRecoveryMaterial'] as const)expect(spec.freshAuth[k]).toBe(true);for(const response of [spec.recoveryResponse,spec.compromise]){expect(response.revokeExistingSessions).toBe(true);expect(response.rotateRefreshCredentials).toBe(true);expect(response.securityEventRecorded).toBe(true);}expect(spec.phishingResistantMethods).toEqual(['webauthn']);for(const m of ['password','otp','recovery-code','recovery-email','helpdesk'] as const)expect(spec.nonPhishingResistantMethods).toContain(m);expect(spec.nonPhishingResistantMethods).not.toContain('webauthn');expect(spec.oauthOidcInScope).toBe(false);});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/auth-policy.ts', AUTH_POLICY);
    const corpus = fixtureTextEquals(workingDirectory, 'evidence/auth-corpus.json', AUTH_CORPUS);
    const report = artifactText(workingDirectory, '.kory-eval/consumer-auth.json');
    const bounded =
      Boolean(report.artifact) &&
      /synthetic|design/u.test(report.text) &&
      !/oauth.*(?:implemented|verified)/u.test(report.text);
    const passed = hidden.passed && fixed && corpus && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `WebAuthn/recovery policy vectors: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        `scope/evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const adminAuthMaterializer: SkillEvalFixtureMaterializer = {
  id: 'secure-authentication/admin-step-up@2',
  matches: (scenario) => scenario.id === ADMIN_AUTH,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-admin-auth'));
    writeFixtureFile(destination, 'src/auth-policy.ts', AUTH_POLICY);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Enterprise admin step-up authentication fixture

Write \`.kory-eval/admin-auth.json\` as \`AdminAuthSpec\`. Password may establish ordinary access, but privileged admin actions require a sufficiently fresh WebAuthn strong-auth event bound to the current session. Map password, WebAuthn, OTP, recovery code, recovery email and helpdesk to actual phishing resistance/privilege assurance; only WebAuthn qualifies as phishing-resistant/admin-qualifying here.

Strong-factor add/remove/replace requires current strong assurance or explicit recovery and records a security event/session response. Recovery codes are single-use and trigger post-recovery restriction/re-enrollment. Helpdesk requires identity/authority checks and audit, cannot rely on knowledge questions, and cannot simply disable strong-factor policy. Set OAuth/OIDC and resource authorization as out of scope.
`,
    );
  },
};
const adminAuthScorer: SkillEvalDeterministicScorer = {
  id: 'secure-authentication/admin-step-up-scorer@2',
  scenarioIds: [ADMIN_AUTH],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{canAdmin,type AdminAuthSpec}from'../src/auth-policy';const s=JSON.parse(readFileSync('.kory-eval/admin-auth.json','utf8')) as AdminAuthSpec;
test('hidden: only fresh phishing-resistant WebAuthn can satisfy admin step-up',()=>{expect(s.assurance.webauthn.phishingResistant).toBe(true);expect(s.assurance.webauthn.adminQualifying).toBe(true);for(const m of ['password','otp','recovery-code','recovery-email','helpdesk'] as const){expect(s.assurance[m].phishingResistant).toBe(false);expect(canAdmin(s,m,1)).toBe(false);}expect(canAdmin(s,'webauthn',Math.max(0,s.adminFreshnessSeconds-1))).toBe(true);expect(canAdmin(s,'webauthn',s.adminFreshnessSeconds+1)).toBe(false);});
test('hidden: factor recovery/helpdesk lifecycle cannot silently disable policy',()=>{expect(s.factorChangesRequireStrongOrRecovery).toBe(true);expect(s.factorChangeSecurityEvent).toBe(true);expect(s.recoveryCodeSingleUse).toBe(true);expect(s.recoveryCodePostUseRestriction).toBe(true);expect(s.helpdesk.knowledgeQuestionsSufficient).toBe(false);expect(s.helpdesk.identityAuthorityChecks).toBe(true);expect(s.helpdesk.audited).toBe(true);expect(s.helpdesk.canDisableStrongPolicy).toBe(false);expect(s.oauthOidcInScope).toBe(false);expect(s.authorizationInScope).toBe(false);});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/auth-policy.ts', AUTH_POLICY);
    const passed = hidden.passed && fixed;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `admin assurance state machine: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator preserved: ${fixed ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const OAUTH_POLICY = `export interface NativeOAuthSpec {
  systemBrowser:boolean;flow:'authorization-code';pkceMethod:'S256';verifierEntropyBits:number;pkceRequired:boolean;plainPkceAccepted:boolean;
  redirect:{registered:string[];wildcardOrPrefixMatching:boolean;customSchemeRetained:boolean;customSchemeInterceptionAddressed:boolean};
  state:{oneTime:boolean;sessionBound:boolean};code:{singleUse:boolean;clientBound:boolean;redirectBound:boolean};
  resourceServer:{audience:string;requiredScope:string;rejectExpired:boolean};
  refresh:{rotated:boolean;senderConstrained:boolean;replayDetected:boolean;familyRevokedOnReplay:boolean};
  storage:{platformProtected:boolean;logs:boolean;analytics:boolean;crashArtifacts:boolean;urlOrReferrer:boolean};
  objectAuthorizationOwnedBy:string;
}
export interface NativeAttempt{pkceMethod:'S256'|'plain'|'missing';verifierMatches:boolean;redirect:string;stateMatches:boolean;stateUnused:boolean;codeUnused:boolean;audience:string;scope:string;expired:boolean}
export function nativeRedeemAndAccept(spec:NativeOAuthSpec,a:NativeAttempt):boolean{return spec.systemBrowser&&spec.pkceRequired&&a.pkceMethod==='S256'&&a.verifierMatches&&spec.redirect.registered.includes(a.redirect)&&!spec.redirect.wildcardOrPrefixMatching&&a.stateMatches&&a.stateUnused&&a.codeUnused&&a.audience===spec.resourceServer.audience&&a.scope.split(' ').includes(spec.resourceServer.requiredScope)&&(!spec.resourceServer.rejectExpired||!a.expired)}

export interface OidcSpec {
  providers:Array<{issuer:string;jwksIssuer:string;clientId:string;algorithms:string[]}>;
  expectedIssuerSessionBound:boolean;discoveryFromTrustedIssuerOnly:boolean;
  validate:{signature:boolean;algorithm:boolean;issuer:boolean;audience:boolean;azp:boolean;time:boolean;nonce:boolean};
  nonceOneTime:boolean;stateSeparateFromNonce:boolean;rejectAccessTokenAsIdToken:boolean;rejectIdTokenAsApiBearer:boolean;
  apis:Record<string,{audience:string;requiredScope:string}>;
  publicRefresh?:{rfc9700:boolean;rotatedOrSenderConstrained:boolean};
  objectAuthorizationOwnedBy:string;
}
export interface IdTokenAttempt{expectedIssuer:string;metadataIssuer:string;tokenIssuer:string;signatureValid:boolean;algorithm:string;audience:string;azp?:string;clientId:string;timeValid:boolean;nonceMatches:boolean;nonceUnused:boolean;tokenType:'id'|'access'}
export function acceptIdToken(spec:OidcSpec,a:IdTokenAttempt):boolean{const p=spec.providers.find(x=>x.issuer===a.expectedIssuer);if(!p)return false;return spec.expectedIssuerSessionBound&&spec.discoveryFromTrustedIssuerOnly&&a.metadataIssuer===p.issuer&&a.tokenIssuer===p.issuer&&a.signatureValid&&p.algorithms.includes(a.algorithm)&&a.audience===p.clientId&&(!a.azp||a.azp===p.clientId)&&a.clientId===p.clientId&&a.timeValid&&a.nonceMatches&&a.nonceUnused&&a.tokenType==='id'}
export function apiAccepts(spec:OidcSpec,api:string,audience:string,scope:string,tokenType:'id'|'access'):boolean{const p=spec.apis[api];return !!p&&tokenType==='access'&&audience===p.audience&&scope.split(' ').includes(p.requiredScope)}
`;

const OAUTH_CORPUS = `${JSON.stringify(
  {
    native: {
      redirect: 'com.example.docs:/oauth2redirect',
      maliciousRedirects: [
        'com.example.docs.evil:/oauth2redirect',
        'com.example.docs:/oauth2redirect/extra',
        'https://evil.example/callback',
      ],
      audience: 'https://api.example.test/documents',
      scope: 'documents.read',
    },
    oidc: {
      providers: [
        { issuer: 'https://idp-a.example', clientId: 'client-a', algorithm: 'RS256' },
        { issuer: 'https://idp-b.example', clientId: 'client-b', algorithm: 'ES256' },
      ],
      apiA: { audience: 'api-a', scope: 'read:a' },
      apiB: { audience: 'api-b', scope: 'read:b' },
    },
  },
  null,
  2,
)}\n`;

const nativeOauthMaterializer: SkillEvalFixtureMaterializer = {
  id: 'oauth-oidc/native-pkce@1',
  matches: (s) => s.id === NATIVE_OAUTH,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-native-oauth'));
    writeFixtureFile(d, 'src/oauth-policy.ts', OAUTH_POLICY);
    writeFixtureFile(d, 'evidence/oauth-corpus.json', OAUTH_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Native public-client OAuth fixture

Preserve evaluator/corpus and write \`.kory-eval/native-oauth.json\` as \`NativeOAuthSpec\`. Use system-browser Authorization Code with mandatory PKCE S256; fresh verifier entropy is at least 256 bits and plain/missing PKCE never redeems. Redirect matching is exact; if retaining the supplied custom scheme, explicitly model competitor-app interception and rely on PKCE as mandatory mitigation rather than treating the scheme as proof of app identity. State is one-time/session-bound and code is one-time/client/redirect-bound.

The resource server independently rejects wrong audience, expired and missing-scope tokens. Public refresh credentials rotate or are sender-constrained; this fixture requires replay detection and token-family revocation on replay. Tokens never enter logs/analytics/crash artifacts/URL/referrer and persist only in platform protected storage. Document-level permission remains \`authorization-security\`.
`,
    );
  },
};
const nativeOauthScorer: SkillEvalDeterministicScorer = {
  id: 'oauth-oidc/native-pkce-scorer@2',
  scenarioIds: [NATIVE_OAUTH],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{nativeRedeemAndAccept,type NativeOAuthSpec,type NativeAttempt}from'../src/oauth-policy';const s=JSON.parse(readFileSync('.kory-eval/native-oauth.json','utf8')) as NativeOAuthSpec;const c=JSON.parse(readFileSync('evidence/oauth-corpus.json','utf8')) as any;const base:NativeAttempt={pkceMethod:'S256',verifierMatches:true,redirect:c.native.redirect,stateMatches:true,stateUnused:true,codeUnused:true,audience:c.native.audience,scope:c.native.scope,expired:false};
test('hidden: exact redirect/state/code/PKCE/resource boundary',()=>{expect(s.flow).toBe('authorization-code');expect(s.pkceMethod).toBe('S256');expect(s.verifierEntropyBits).toBeGreaterThanOrEqual(256);expect(s.plainPkceAccepted).toBe(false);expect(nativeRedeemAndAccept(s,base)).toBe(true);for(const method of ['plain','missing'] as const)expect(nativeRedeemAndAccept(s,{...base,pkceMethod:method})).toBe(false);for(const redirect of c.native.maliciousRedirects)expect(nativeRedeemAndAccept(s,{...base,redirect})).toBe(false);expect(nativeRedeemAndAccept(s,{...base,stateMatches:false})).toBe(false);expect(nativeRedeemAndAccept(s,{...base,codeUnused:false})).toBe(false);expect(nativeRedeemAndAccept(s,{...base,audience:'wrong'})).toBe(false);expect(nativeRedeemAndAccept(s,{...base,scope:'other'})).toBe(false);expect(nativeRedeemAndAccept(s,{...base,expired:true})).toBe(false);});
test('hidden: replay/storage/custom-scheme boundaries are explicit',()=>{expect(s.refresh.replayDetected).toBe(true);expect(s.refresh.familyRevokedOnReplay).toBe(true);expect(s.refresh.rotated||s.refresh.senderConstrained).toBe(true);expect(s.storage.platformProtected).toBe(true);for(const k of ['logs','analytics','crashArtifacts','urlOrReferrer'] as const)expect(s.storage[k]).toBe(false);if(s.redirect.customSchemeRetained)expect(s.redirect.customSchemeInterceptionAddressed).toBe(true);expect(s.objectAuthorizationOwnedBy).toBe('authorization-security');});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/oauth-policy.ts', OAUTH_POLICY);
    const corpus = fixtureTextEquals(workingDirectory, 'evidence/oauth-corpus.json', OAUTH_CORPUS);
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `native OAuth attack corpus: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const oidcMaterializer: SkillEvalFixtureMaterializer = {
  id: 'oauth-oidc/enterprise-rp-mixup@1',
  matches: (s) => s.id === ENTERPRISE_OIDC,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-enterprise-oidc'));
    writeFixtureFile(d, 'src/oauth-policy.ts', OAUTH_POLICY);
    writeFixtureFile(d, 'evidence/oauth-corpus.json', OAUTH_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Two-provider OIDC RP fixture

Write \`.kory-eval/oidc-rp.json\` as \`OidcSpec\` using the two supplied issuers/client IDs/algs. Each login session binds its expected issuer; discovery/JWKS comes only from that trusted issuer. ID token acceptance requires permitted signature/algorithm, exact issuer, audience/azp, time and one-time nonce. State and nonce remain separate lifecycles.

Reject access-token-as-ID-token and ID-token-as-API-bearer. API A/B independently enforce their own access-token audience/scope. If the public tier receives refresh tokens, set RFC 9700 rotation/sender-constraint behavior. Object-level authorization remains \`authorization-security\`.
`,
    );
  },
};
const oidcScorer: SkillEvalDeterministicScorer = {
  id: 'oauth-oidc/enterprise-rp-mixup-scorer@2',
  scenarioIds: [ENTERPRISE_OIDC],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{acceptIdToken,apiAccepts,type OidcSpec,type IdTokenAttempt}from'../src/oauth-policy';const s=JSON.parse(readFileSync('.kory-eval/oidc-rp.json','utf8')) as OidcSpec;const c=JSON.parse(readFileSync('evidence/oauth-corpus.json','utf8')) as any;const pa=c.oidc.providers[0],pb=c.oidc.providers[1];const base:IdTokenAttempt={expectedIssuer:pa.issuer,metadataIssuer:pa.issuer,tokenIssuer:pa.issuer,signatureValid:true,algorithm:pa.algorithm,audience:pa.clientId,azp:pa.clientId,clientId:pa.clientId,timeValid:true,nonceMatches:true,nonceUnused:true,tokenType:'id'};
test('hidden: mix-up/JWKS/token validation corpus fails closed',()=>{expect(acceptIdToken(s,base)).toBe(true);expect(acceptIdToken(s,{...base,metadataIssuer:pb.issuer})).toBe(false);expect(acceptIdToken(s,{...base,tokenIssuer:pb.issuer})).toBe(false);expect(acceptIdToken(s,{...base,algorithm:pb.algorithm})).toBe(false);expect(acceptIdToken(s,{...base,audience:'wrong'})).toBe(false);expect(acceptIdToken(s,{...base,azp:'wrong'})).toBe(false);expect(acceptIdToken(s,{...base,timeValid:false})).toBe(false);expect(acceptIdToken(s,{...base,nonceMatches:false})).toBe(false);expect(acceptIdToken(s,{...base,nonceUnused:false})).toBe(false);expect(acceptIdToken(s,{...base,tokenType:'access'})).toBe(false);});
test('hidden: token role and API audiences/scopes stay separate',()=>{expect(s.rejectAccessTokenAsIdToken).toBe(true);expect(s.rejectIdTokenAsApiBearer).toBe(true);expect(s.stateSeparateFromNonce).toBe(true);expect(s.nonceOneTime).toBe(true);expect(apiAccepts(s,'A',c.oidc.apiA.audience,c.oidc.apiA.scope,'access')).toBe(true);expect(apiAccepts(s,'B',c.oidc.apiA.audience,c.oidc.apiA.scope,'access')).toBe(false);expect(apiAccepts(s,'A',c.oidc.apiA.audience,'wrong','access')).toBe(false);expect(apiAccepts(s,'A',c.oidc.apiA.audience,c.oidc.apiA.scope,'id')).toBe(false);expect(s.objectAuthorizationOwnedBy).toBe('authorization-security');if(s.publicRefresh){expect(s.publicRefresh.rfc9700).toBe(true);expect(s.publicRefresh.rotatedOrSenderConstrained).toBe(true);}});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/oauth-policy.ts', OAUTH_POLICY);
    const corpus = fixtureTextEquals(workingDirectory, 'evidence/oauth-corpus.json', OAUTH_CORPUS);
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `OIDC mix-up/token-role vectors: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const SECRET_POLICY = `export interface KeyHierarchySpec {
  ciphertextMetadata:string[];tenantScopedKek:boolean;historicalVersionImmutable:boolean;
  applicationActions:string[];keyAdminActions:string[];applicationCanAdminister:boolean;deletionSeparateApproval:boolean;
  rotation:{newWritesVersioned:boolean;rewrapDistinct:boolean;reencryptDistinct:boolean;disableOldOnlyAfterDependencyProof:boolean};
  compromise:{workloadGrantScope:string;kekCompromiseScope:string;separateResponses:boolean;revocationPropagation:boolean;auditEvidence:boolean};
  recovery:{regionalCopyUsable:boolean;historicalKeyDependenciesProtected:boolean};
  destruction:{dependencyCheck:boolean;retentionLegalHoldCheck:boolean;auditedRecoveryWindow:boolean};
  aeadNonceOwnedBy:string;
}
export function historicalDecryptable(s:KeyHierarchySpec):boolean{return ['tenantId','wrappingKeyId','wrappingKeyVersion'].every(k=>s.ciphertextMetadata.includes(k))&&s.tenantScopedKek&&s.historicalVersionImmutable&&s.recovery.historicalKeyDependenciesProtected}

export interface RotationConsumer { id:string;kind:'api'|'worker'|'batch';status:'online'|'offline';current:Record<string,string> }
export interface CredentialRotationSpec {
  inventory:RotationConsumer[];credentials:string[];delivery:'managed-secret'|'workload-identity';sourceControlExposure:boolean;ciPlaintextExposure:boolean;commandLineExposure:boolean;broadProcessInheritance:boolean;ordinaryLogExposure:boolean;
  overlapDeadlineMinutes:number;verifyEachConsumerNewVersion:boolean;revokeOldOnlyAfterVerification:boolean;offlineConsumersIncluded:boolean;
  rollback:{bounded:boolean;leavesDualAcceptedIndefinitely:boolean;reintroducesUntrackedLegacy:boolean};
  emergency:{immediateRevocation:boolean;impactInventory:boolean;safeReissue:boolean;audit:boolean};
  endUserCredentialsInScope:boolean;
}
export function rotationReady(s:CredentialRotationSpec,requiredConsumers:string[],requiredCredentials:string[]):boolean{const ids=new Set(s.inventory.map(x=>x.id));return requiredConsumers.every(x=>ids.has(x))&&requiredCredentials.every(x=>s.credentials.includes(x))&&s.offlineConsumersIncluded&&s.overlapDeadlineMinutes>0&&s.verifyEachConsumerNewVersion&&s.revokeOldOnlyAfterVerification}
`;
const SECRET_CORPUS = `${JSON.stringify(
  {
    consumers: [
      { id: 'api-1', kind: 'api', status: 'online' },
      { id: 'api-2', kind: 'api', status: 'online' },
      { id: 'worker-1', kind: 'worker', status: 'online' },
      { id: 'batch-offline', kind: 'batch', status: 'offline' },
    ],
    credentials: ['database', 'vendor-a', 'vendor-b'],
    keyVersions: { tenantA: ['kek-a-v1', 'kek-a-v2'], tenantB: ['kek-b-v4'] },
    historicalCiphertext: [
      { tenantId: 'tenantA', wrappingKeyId: 'kek-a', wrappingKeyVersion: 'v1' },
    ],
  },
  null,
  2,
)}\n`;

const keyHierarchyMaterializer: SkillEvalFixtureMaterializer = {
  id: 'secrets-key-management/tenant-kek-hierarchy@1',
  matches: (s) => s.id === KEY_HIERARCHY,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-key-hierarchy'));
    writeFixtureFile(d, 'src/secret-policy.ts', SECRET_POLICY);
    writeFixtureFile(d, 'evidence/secret-corpus.json', SECRET_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Tenant KEK hierarchy/rotation fixture

Write \`.kory-eval/key-hierarchy.json\` as \`KeyHierarchySpec\`. Every wrapped DEK/ciphertext record retains immutable tenant, wrapping-key ID and exact version—not only a mutable alias—so historical data remains decryptable. Application workload permissions are only required data-plane wrap/unwrap/decrypt operations; key policy/admin/delete powers belong to separate principals/approval.

Distinguish selecting a new KEK version for new writes from rewrapping DEKs and full data re-encryption. Old versions cannot disable/delete until dependency proof completes. Analyze compromised workload grant separately from compromised KEK, including tenant/data blast radius, revocation propagation, rewrap/re-encryption needs and audit. Regional recovery must preserve historical dependencies; destruction checks dependencies, retention/legal hold and an audited recovery window. AEAD/nonce stays owned by \`applied-cryptography\`.
`,
    );
  },
};
const keyHierarchyScorer: SkillEvalDeterministicScorer = {
  id: 'secrets-key-management/tenant-kek-hierarchy-scorer@2',
  scenarioIds: [KEY_HIERARCHY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{historicalDecryptable,type KeyHierarchySpec}from'../src/secret-policy';const s=JSON.parse(readFileSync('.kory-eval/key-hierarchy.json','utf8')) as KeyHierarchySpec;
test('hidden: historical key identity and tenant isolation survive alias rotation',()=>{expect(historicalDecryptable(s)).toBe(true);expect(s.applicationCanAdminister).toBe(false);expect(s.deletionSeparateApproval).toBe(true);expect(s.applicationActions.every(x=>!/admin|delete|policy/i.test(x))).toBe(true);expect(s.keyAdminActions.some(x=>/admin|policy|delete|disable/i.test(x))).toBe(true);});
test('hidden: rotation/compromise/recovery/destruction states are distinct and bounded',()=>{expect(s.rotation.newWritesVersioned).toBe(true);expect(s.rotation.rewrapDistinct).toBe(true);expect(s.rotation.reencryptDistinct).toBe(true);expect(s.rotation.disableOldOnlyAfterDependencyProof).toBe(true);expect(s.compromise.separateResponses).toBe(true);expect(s.compromise.revocationPropagation).toBe(true);expect(s.compromise.auditEvidence).toBe(true);expect(s.compromise.workloadGrantScope).not.toBe(s.compromise.kekCompromiseScope);expect(s.recovery.regionalCopyUsable).toBe(true);expect(s.destruction.dependencyCheck).toBe(true);expect(s.destruction.retentionLegalHoldCheck).toBe(true);expect(s.destruction.auditedRecoveryWindow).toBe(true);expect(s.aeadNonceOwnedBy).toBe('applied-cryptography');});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/secret-policy.ts', SECRET_POLICY);
    const corpus = fixtureTextEquals(
      workingDirectory,
      'evidence/secret-corpus.json',
      SECRET_CORPUS,
    );
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `historical key/rotation policy: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const rotationMaterializer: SkillEvalFixtureMaterializer = {
  id: 'secrets-key-management/fleet-credential-rotation@1',
  matches: (s) => s.id === CREDENTIAL_ROTATION,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-secret-rotation'));
    writeFixtureFile(d, 'src/secret-policy.ts', SECRET_POLICY);
    writeFixtureFile(d, 'evidence/secret-corpus.json', SECRET_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Fleet credential rotation fixture

Write \`.kory-eval/credential-rotation.json\` as \`CredentialRotationSpec\`. Inventory every supplied API replica, worker and offline batch consumer and all three credential families before rotation, including current version. Delivery moves to managed secret/workload identity and avoids source control, CI plaintext, command-line, broad environment inheritance and ordinary logs.

Use provider-supported staged overlap with an explicit deadline. Verification is per consumer/version, including stale/offline consumers; only after every required consumer proves new-version use may the old credential be revoked. Rollback is bounded and cannot leave dual credentials accepted forever or resurrect an untracked legacy secret. Emergency compromise supports immediate revoke, impact inventory, safe reissue and audit. End-user credentials are out of scope.
`,
    );
  },
};
const rotationScorer: SkillEvalDeterministicScorer = {
  id: 'secrets-key-management/fleet-credential-rotation-scorer@2',
  scenarioIds: [CREDENTIAL_ROTATION],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{rotationReady,type CredentialRotationSpec}from'../src/secret-policy';const s=JSON.parse(readFileSync('.kory-eval/credential-rotation.json','utf8')) as CredentialRotationSpec;const c=JSON.parse(readFileSync('evidence/secret-corpus.json','utf8')) as any;const ids=c.consumers.map((x:any)=>x.id);
test('hidden: inventory includes offline consumers and every credential before revoke',()=>{expect(rotationReady(s,ids,c.credentials)).toBe(true);expect(s.inventory.find(x=>x.id==='batch-offline')?.status).toBe('offline');expect(s.delivery==='managed-secret'||s.delivery==='workload-identity').toBe(true);for(const k of ['sourceControlExposure','ciPlaintextExposure','commandLineExposure','broadProcessInheritance','ordinaryLogExposure'] as const)expect(s[k]).toBe(false);});
test('hidden: rollback/emergency lifecycle stays bounded',()=>{expect(s.rollback.bounded).toBe(true);expect(s.rollback.leavesDualAcceptedIndefinitely).toBe(false);expect(s.rollback.reintroducesUntrackedLegacy).toBe(false);expect(s.emergency.immediateRevocation).toBe(true);expect(s.emergency.impactInventory).toBe(true);expect(s.emergency.safeReissue).toBe(true);expect(s.emergency.audit).toBe(true);expect(s.endUserCredentialsInScope).toBe(false);});
`,
    );
    const fixed = fixtureTextEquals(workingDirectory, 'src/secret-policy.ts', SECRET_POLICY);
    const corpus = fixtureTextEquals(
      workingDirectory,
      'evidence/secret-corpus.json',
      SECRET_CORPUS,
    );
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `consumer/version cutover policy: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

export const AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    consumerAuthMaterializer,
    adminAuthMaterializer,
    nativeOauthMaterializer,
    oidcMaterializer,
    keyHierarchyMaterializer,
    rotationMaterializer,
  ];
export const AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  consumerAuthScorer,
  adminAuthScorer,
  nativeOauthScorer,
  oidcScorer,
  keyHierarchyScorer,
  rotationScorer,
];
