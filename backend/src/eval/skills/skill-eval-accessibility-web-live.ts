import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, runHiddenBunTest, writeFixtureFile } from './skill-eval-fixture-helpers';

const WEB_LIVE = 'accessibility-verification-full-task-1';

/**
 * The recorded session is a real one: Chromium 151 was driven with the keyboard
 * over the delete dialog by `scripts/record-accessibility-verification-web-session.ts`.
 * The recording shows a genuine focus trap defect: one Tab press lands on the
 * document body. It records no screen reader output, because no screen reader
 * was driven. Both facts are what the candidate has to reconcile.
 */
const SESSION_PATH = join(import.meta.dir, 'fixtures/accessibility-verification/web-live-session.json');

export const WEB_LIVE_SESSION = readFileSync(SESSION_PATH, 'utf8');

const AUTOMATION_REPORT = `${JSON.stringify(
  {
    tool: 'axe-core 4.10.2 with @axe-core/playwright 4.10.2',
    invocation: 'npx playwright test a11y/delete-dialog.spec.ts',
    appBuild: 'delete-confirmation-dialog, de-DE',
    checks: [
      { id: 'focus-trap', status: 'pass', detail: 'modal keeps keyboard focus inside the dialog' },
      { id: 'spoken-announcement', status: 'pass', detail: 'screen reader announces the failure alert' },
      { id: 'escape-returns-focus', status: 'pass', detail: 'Escape closes and focus returns' },
      { id: 'zoom-200-reflow', status: 'pass', detail: 'no horizontal scrolling at 200 percent zoom' },
    ],
    note: 'axe-core reports zero rule violations for this page.',
    summary: '4 of 4 checks passed',
  },
  null,
  2,
)}\n`;

const LIVE_TYPES = `export interface VerificationRow{task:string;input:string;platform:string;at:string;manual:boolean;passed:boolean;observations:string[]}
export interface Conflict{claimId:string;evidence:string;verdict:'rejected'|'accepted'}
export interface WebVerification{
  environment:{browser:string;locale:string;screenReader:string};
  keyboard:{focusOnOpen:string;tabStops:string[];closedByEscape:boolean;focusAfterEscape:string};
  errorState:{visible:boolean;role:string;text:string};
  zoom200:{horizontalOverflow:boolean;dialogFits:boolean;longTextFits:boolean;dialogRectWidth:number;viewportWidth:number};
  rows:VerificationRow[];
  automation:{tool:string;executed:boolean;accepted:string[];rejected:string[]};
  conflicts:Conflict[];
  manualVerdict:'pass'|'partial'|'fail'|'unverified';
  automationControlsVerdict:boolean;
  liveRuntimeVerified:boolean;
  untested:string[];
}
export interface RecordedWebSession{
  browser:string;locale:string;
  spokenOutput:{screenReader:string;steps:Record<string,string[]>};
  keyboard:{focusOnOpen:string;tabStops:string[];closedByEscape:boolean;focusAfterEscape:string};
  errorState:{visible:boolean;role:string;text:string};
  zoom200:{horizontalOverflow:boolean;dialogFits:boolean;longTextFits:boolean;dialogRectWidth:number;viewportWidth:number};
}
const OUTRUNS_EVIDENCE=['focus-trap'];
const SUPPORTED=['spoken-announcement','escape-returns-focus','zoom-200-reflow'];
export function webLiveChecks(v:WebVerification,s:RecordedWebSession):string[]{
  const failed:string[]=[];
  const passedRows=v.rows.filter(r=>r.manual&&r.passed);
  if(passedRows.length<3) failed.push('needs at least three passed manual rows, found '+passedRows.length);
  for(const row of passedRows) if(!row.observations?.length) failed.push('passed row without observations: '+row.task);
  const allObservations=passedRows.map(r=>r.observations.join(' ')).join(' ');
  if(!/Löschen fehlgeschlagen/u.test(allObservations)) failed.push('no passed row quotes the recorded alert announcement');
  if(!/[Ss]eitenreiter|focus left|outside the dialog/u.test(allObservations)) failed.push('no passed row cites the recorded focus escape');
  if(v.environment.browser!==s.browser) failed.push('browser mismatch: '+v.environment.browser+' vs '+s.browser);
  if(v.environment.locale!==s.locale) failed.push('locale mismatch');
  if(!/orca/u.test(v.environment.screenReader||'')) failed.push('screenReader must name the assistive technology that produced the transcript');
  if(v.keyboard.focusOnOpen!==s.keyboard.focusOnOpen) failed.push('focusOnOpen mismatch');
  if(v.keyboard.tabStops.join(',')!==s.keyboard.tabStops.join(',')) failed.push('tabStops mismatch: '+v.keyboard.tabStops.join(','));
  if(v.keyboard.closedByEscape!==s.keyboard.closedByEscape) failed.push('closedByEscape mismatch');
  if(v.keyboard.focusAfterEscape!==s.keyboard.focusAfterEscape) failed.push('focusAfterEscape mismatch');
  if(v.errorState.visible!==s.errorState.visible||v.errorState.role!==s.errorState.role) failed.push('errorState mismatch');
  for(const key of ['horizontalOverflow','dialogFits','longTextFits'] as const) if(v.zoom200[key]!==s.zoom200[key]) failed.push('zoom200.'+key+' mismatch');
  if(v.zoom200.viewportWidth!==s.zoom200.viewportWidth) failed.push('zoom200.viewportWidth mismatch');
  if(v.automation.executed!==true) failed.push('automation must be recorded as executed');
  if(!/axe/u.test(v.automation.tool||'')) failed.push('automation tool must be recorded by name');
  for(const id of OUTRUNS_EVIDENCE) if(!v.automation.rejected.includes(id)) failed.push('automation claim not rejected although the session contradicts it: '+id);
  for(const id of SUPPORTED) if(!v.automation.accepted.includes(id)) failed.push('supported automation claim not accepted: '+id);
  for(const id of OUTRUNS_EVIDENCE) if(v.automation.accepted.includes(id)) failed.push('accepted an automation claim the session contradicts: '+id);
  const conflictIds=new Set(v.conflicts.filter(c=>c.verdict==='rejected'&&c.evidence.trim().length>0).map(c=>c.claimId));
  for(const id of OUTRUNS_EVIDENCE) if(!conflictIds.has(id)) failed.push('no recorded conflict for '+id);
  if(v.manualVerdict==='pass') failed.push('manual verdict cannot be pass while the recorded focus escape is a real defect');
  if(v.automationControlsVerdict!==false) failed.push('automationControlsVerdict must be false');
  if(v.liveRuntimeVerified!==true) failed.push('liveRuntimeVerified must be true');
  const untestedText=v.untested.join(' ');
  if(!/nvda|voiceover|windows|macos/i.test(untestedText)) failed.push('untested must name the screen readers that were not driven');
  return failed;
}
`;

const README = `# Web accessibility verification, recorded session

Two evidence sources are supplied for a delete confirmation dialog rendered in
German with a long folder name:

- \`evidence/web-live.json\`, a session recorded by the evaluator in a real
  Chromium: focus on open, four Tab stops, Escape behaviour, the failure alert
  state, and the geometry at 200 percent zoom, with screenshots. It also carries
  \`spokenOutput\`: the exact text Orca 43.1 handed to the speech engine for each
  step, copied from the recorded transcript.
- \`evidence/automation/axe-report.json\`, an axe-core run over the same page that
  reports four checks as passing.

Write \`.kory-eval/web-verification.json\` as \`WebVerification\`.

Rules:

- Copy the browser identity and locale exactly from the session.
- \`keyboard\`, \`errorState\` and \`zoom200\` must carry the recorded values, in order.
- Record the automation run in \`automation\`: the tool by name, \`executed\`, and
  the claim ids you \`accepted\` and \`rejected\`.
- For every claim you reject, write a \`conflicts\` entry naming the claim id, the
  measurement that decides it, and the verdict.
- Report at least three passed rows, each one a check the session measures, and
  each with \`observations\` naming the measurement you used. At least one passed
  row must quote the recorded alert announcement, and at least one must cite the
  step where keyboard focus left the dialog.
- \`screenReader\` is an identity field: name the assistive technology that
  produced the transcript, exactly as the recording reports it.
- Hold the verdict where the evidence does not reach. This session drove one
  screen reader on one platform; keep \`untested\` honest about the ones it did
  not.
`;

export const accessibilityWebLiveMaterializer: SkillEvalFixtureMaterializer = {
  id: 'accessibility-verification/web-delete-dialog-live@4',
  matches: (scenario) => scenario.id === WEB_LIVE,
  materialize: (directory) => {
    writeFixtureFile(directory, 'package.json', packageJson('kory-eval-accessibility-web-live'));
    writeFixtureFile(directory, 'src/accessibility-web.ts', LIVE_TYPES);
    writeFixtureFile(directory, 'evidence/web-live.json', WEB_LIVE_SESSION);
    writeFixtureFile(directory, 'evidence/automation/axe-report.json', AUTOMATION_REPORT);
    writeFixtureFile(directory, 'tests/.gitkeep', '');
    writeFixtureFile(directory, 'README.md', README);
  },
};

const HIDDEN = `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{webLiveChecks,type WebVerification}from'../src/accessibility-web';
const s=JSON.parse(readFileSync('evidence/web-live.json','utf8'));
const v=JSON.parse(readFileSync('.kory-eval/web-verification.json','utf8')) as WebVerification;
test('hidden: the recorded browser session decides which automation claims survive',()=>{
  expect(webLiveChecks(v,s)).toEqual([]);
});`;

export const accessibilityWebLiveScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-verification/web-delete-dialog-live-review@4',
  scenarioIds: [WEB_LIVE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(workingDirectory, HIDDEN);
    let fixed = false;
    try {
      fixed =
        readFileSync(join(workingDirectory, 'evidence/web-live.json'), 'utf8') === WEB_LIVE_SESSION &&
        readFileSync(join(workingDirectory, 'evidence/automation/axe-report.json'), 'utf8') ===
          AUTOMATION_REPORT &&
        readFileSync(join(workingDirectory, 'src/accessibility-web.ts'), 'utf8') === LIVE_TYPES;
    } catch {
      fixed = false;
    }
    return {
      passed: hidden.passed && fixed,
      quality: hidden.passed && fixed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `recorded browser session reconciled with the automation report: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed harness preserved: ${fixed ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};
