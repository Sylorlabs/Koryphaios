import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const ANDROID_LIVE = 'accessibility-verification-full-task-2';

/**
 * The recorded session is a real one: TalkBack 17.0 on an Android 17 (API 37)
 * emulator, driven by `scripts/record-accessibility-verification-android-session.ts`.
 * It is shipped to the candidate as evidence, together with an automation report
 * whose claims must be reconciled against it. Three of those claims outrun the
 * evidence: no utterance was captured, Switch Access is not bound, and the two
 * switch controls expose resource identifiers instead of human labels.
 */
const SESSION_PATH = join(
  import.meta.dir,
  'fixtures/accessibility-verification/android-live-session.json',
);

export const ANDROID_LIVE_SESSION = readFileSync(SESSION_PATH, 'utf8');

const AUTOMATION_REPORT = `${JSON.stringify(
  {
    tool: 'androidx.test.espresso:espresso-core:3.6.1',
    invocation: './gradlew :app:connectedDebugAndroidTest --tests NotificationSettingsTest',
    appBuild: 'com.android.settings 17 (API 37)',
    device: 'sdk_gphone64_arm64',
    checks: [
      {
        id: 'spoken-state-change',
        status: 'pass',
        detail: 'asserted state change through Compose semantics merge',
      },
      {
        id: 'switch-traversal',
        status: 'pass',
        detail: 'asserted reachability by walking accessibility nodes',
      },
      {
        id: 'duplicate-label',
        status: 'pass',
        detail: 'asserted every node exposes a distinct label',
      },
      {
        id: 'max-text-scale',
        status: 'pass',
        detail: 'asserted no clipping at 1.5 text scale',
      },
    ],
    summary: '4 of 4 checks passed',
  },
  null,
  2,
)}\n`;

const LIVE_TYPES = `export interface VerificationRow{task:string;input:string;platform:string;at:string;manual:boolean;passed:boolean;observations:string[]}
export interface Conflict{claimId:string;evidence:string;verdict:'rejected'|'accepted'}
export interface LiveVerification{
  environment:{platformVersion:string;device:string;assistiveTechnology:string;switchAccess:string};
  focusOrder:string[];
  toggles:{label:string;checked:boolean}[];
  textScale:{largeScale:string;defaultRowHeight:number;largeRowHeight:number;grew:boolean};
  rows:VerificationRow[];
  automation:{tool:string;executed:boolean;accepted:string[];rejected:string[]};
  conflicts:Conflict[];
  manualVerdict:'pass'|'partial'|'fail'|'unverified';
  automationControlsVerdict:boolean;
  liveRuntimeVerified:boolean;
  untested:string[];
}
export interface RecordedSession{
  device:{model:string;sdk:number};
  assistiveTechnology:{talkBack:string;switchAccess:string;switchAccessBound:boolean};
  focusTraversal:{label:string}[];
  toggles:{label:string;checked:boolean}[];
  textScale:{defaultRowHeight:number;largeRowHeight:number};
}
const OUTRUNS_EVIDENCE=['spoken-state-change','switch-traversal','duplicate-label'];
export function androidLiveChecks(v:LiveVerification,s:RecordedSession):string[]{
  const failed:string[]=[];
  const passedRows=v.rows.filter(r=>r.manual&&r.passed);
  if(passedRows.length<3) failed.push('needs at least three passed manual rows, found '+passedRows.length);
  for(const row of passedRows) if(!row.observations?.length) failed.push('passed row without observations: '+row.task);
  const spokenClaim=passedRows.find(r=>/spoken|speech|announcement/i.test(r.task));
  if(spokenClaim) failed.push('claimed spoken output the recording cannot show: '+spokenClaim.task);
  if(v.environment.device!==s.device.model) failed.push('device mismatch: '+v.environment.device+' vs '+s.device.model);
  if(v.environment.assistiveTechnology!==s.assistiveTechnology.talkBack) failed.push('assistiveTechnology mismatch');
  if(v.environment.switchAccess!==s.assistiveTechnology.switchAccess) failed.push('switchAccess mismatch');
  if(v.focusOrder.length!==s.focusTraversal.length) failed.push('focusOrder length '+v.focusOrder.length+' vs '+s.focusTraversal.length);
  else for(let index=0;index<v.focusOrder.length;index+=1) if(v.focusOrder[index]!==s.focusTraversal[index]?.label) failed.push('focusOrder['+index+'] mismatch');
  if(v.toggles.length!==s.toggles.length) failed.push('toggles length mismatch');
  else for(let index=0;index<v.toggles.length;index+=1){const a=v.toggles[index]!,b=s.toggles[index]!;if(a.label!==b.label||a.checked!==b.checked) failed.push('toggle['+index+'] mismatch');}
  if(v.textScale.largeScale!=='1.5') failed.push('largeScale not 1.5');
  if(v.textScale.defaultRowHeight!==s.textScale.defaultRowHeight) failed.push('defaultRowHeight mismatch');
  if(v.textScale.largeRowHeight!==s.textScale.largeRowHeight) failed.push('largeRowHeight mismatch');
  if(v.textScale.grew!==true) failed.push('grew not true');
  if(v.automation.executed!==true) failed.push('automation must be recorded as executed');
  if(!/espresso/i.test(v.automation.tool||'')) failed.push('automation tool must be recorded by name');
  for(const id of OUTRUNS_EVIDENCE) if(!v.automation.rejected.includes(id)) failed.push('automation claim not rejected although the evidence does not support it: '+id);
  if(v.automation.accepted.includes('spoken-state-change')||v.automation.accepted.includes('switch-traversal')||v.automation.accepted.includes('duplicate-label')) failed.push('accepted an automation claim the recording contradicts');
  const conflictIds=new Set(v.conflicts.filter(c=>c.verdict==='rejected'&&c.evidence.trim().length>0).map(c=>c.claimId));
  for(const id of OUTRUNS_EVIDENCE) if(!conflictIds.has(id)) failed.push('no recorded conflict for '+id);
  if(v.manualVerdict==='pass') failed.push('manual verdict cannot be pass while spoken and switch boundaries are unobserved');
  if(v.automationControlsVerdict!==false) failed.push('automationControlsVerdict must be false');
  if(v.liveRuntimeVerified!==true) failed.push('liveRuntimeVerified must be true');
  const untestedText=v.untested.join(' ');
  if(!/switch/i.test(untestedText)) failed.push('untested must name switch input');
  if(!/spoken|speech|announcement/i.test(untestedText)) failed.push('untested must name spoken output');
  return failed;
}
`;

const README = `# Android accessibility verification, recorded session

Two evidence sources are supplied for the notification settings screen of
\`com.android.settings\` on Android 17 (API 37), device \`sdk_gphone64_arm64\`:

- \`evidence/android-live.json\`, a session recorded by the evaluator on the real
  device: service builds and binding, the accessibility node tree, six keyboard
  focus stops, two switch controls with checked state, and row heights measured
  at text scale 1.0 and 1.5, with screenshots of both scales.
- \`evidence/automation/espresso-report.json\`, an Espresso run over the same
  screen that reports four checks as passing.

Write \`.kory-eval/android-verification.json\` as \`LiveVerification\`.

Rules:

- Copy identity strings exactly, and format \`platformVersion\` as
  \`Android <release> (API <sdk>)\`, so \`Android 17 (API 37)\` for this recording.
- \`focusOrder\` must be the recorded stops in order. \`toggles\` must be the
  recorded controls in order with their recorded state. \`textScale\` must carry
  the measured heights.
- Record the automation run in \`automation\`: the tool by name, \`executed\`, and
  the claim ids you \`accepted\` and \`rejected\`.
- For every claim you reject, write a \`conflicts\` entry naming the claim id, the
  measurement that decides it, and the verdict.
- Report at least three passed rows, each one a check the recording measures, and
  each with \`observations\` naming the measurement you used.
- Hold the verdict where the evidence does not reach. A claim the recording
  cannot support belongs in \`untested\`, not in a passed row.
`;

export const accessibilityAndroidLiveMaterializer: SkillEvalFixtureMaterializer = {
  id: 'accessibility-verification/android-live-session@4',
  matches: (scenario) => scenario.id === ANDROID_LIVE,
  materialize: (directory) => {
    writeFixtureFile(
      directory,
      'package.json',
      packageJson('kory-eval-accessibility-android-live'),
    );
    writeFixtureFile(directory, 'src/accessibility-live.ts', LIVE_TYPES);
    writeFixtureFile(directory, 'evidence/android-live.json', ANDROID_LIVE_SESSION);
    writeFixtureFile(directory, 'evidence/automation/espresso-report.json', AUTOMATION_REPORT);
    writeFixtureFile(directory, 'tests/.gitkeep', '');
    writeFixtureFile(directory, 'README.md', README);
  },
};

const HIDDEN = `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{androidLiveChecks,type LiveVerification}from'../src/accessibility-live';
const s=JSON.parse(readFileSync('evidence/android-live.json','utf8'));
const v=JSON.parse(readFileSync('.kory-eval/android-verification.json','utf8')) as LiveVerification;
test('hidden: recorded Android session decides which automation claims survive',()=>{
  expect(androidLiveChecks(v,s)).toEqual([]);
  expect(/Android 17/u.test(v.environment.platformVersion)).toBe(true);
  expect(/37/u.test(v.environment.platformVersion)).toBe(true);
});`;

export const accessibilityAndroidLiveScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-verification/android-live-review@4',
  scenarioIds: [ANDROID_LIVE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(workingDirectory, HIDDEN);
    let fixed = false;
    try {
      fixed =
        readFileSync(join(workingDirectory, 'evidence/android-live.json'), 'utf8') ===
          ANDROID_LIVE_SESSION &&
        readFileSync(join(workingDirectory, 'evidence/automation/espresso-report.json'), 'utf8') ===
          AUTOMATION_REPORT &&
        readFileSync(join(workingDirectory, 'src/accessibility-live.ts'), 'utf8') === LIVE_TYPES;
    } catch {
      fixed = false;
    }
    return {
      passed: hidden.passed && fixed,
      quality: hidden.passed && fixed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `recorded Android session reconciled with the automation report: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed harness preserved: ${fixed ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};
