import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const EDITOR = 'accessibility-practice-full-task-cross-platform-editor';
const GAME = 'accessibility-practice-full-task-game-system';
const WEB_VERIFY = 'accessibility-verification-full-task-1';
const ANDROID_VERIFY = 'accessibility-verification-full-task-2';
const WEB_VERIFY_RUNTIME_BLOCKER =
  'Requires a real supported browser plus representative screen-reader runtime for keyboard focus, visible-focus, announcement, and zoom/reflow evidence; the synthetic harness is component evidence only.';
const ANDROID_VERIFY_RUNTIME_BLOCKER =
  'Requires a real Android device or emulator plus representative TalkBack and switch-access runtime for semantics, focus, alternate-input, and text-scaling evidence; the synthetic harness is component evidence only.';

const CONTRACT_CORPUS = `${JSON.stringify(
  {
    editorTasks: [
      'open-project',
      'navigate-project',
      'edit',
      'search',
      'diagnostics',
      'command-discovery',
      'conflict-resolution',
      'interruption-recovery',
    ],
    editorPlatforms: ['macOS', 'Windows'],
    editorCustomControls: ['tree', 'grid', 'diagnostics'],
    gameTasks: ['menu', 'tutorial', 'combat', 'coop-communication', 'pause-settings', 'recovery'],
    gameChannels: [
      'dialogue',
      'non-speech-audio',
      'visual-events',
      'combat-status',
      'communication',
    ],
  },
  null,
  2,
)}\n`;

const VERIFY_SIM = `export interface VerificationRow{task:string;input:string;platform:string;at:string;manual:boolean;simulated:boolean;passed:boolean;observations:string[]}
export interface AccessibilityVerification{environment:{platformVersion:string;appBuild:string;assistiveTechnology:string;browser?:string};rows:VerificationRow[];automation:{tool:string;passed:boolean;findings:string[]};manualVerdict:'pass'|'fail';automationControlsVerdict:boolean;liveRuntimeVerified:boolean;untested:string[]}
export function webDialogVerified(v:AccessibilityVerification):boolean{const required=['focus-entry','focus-trap','cancel','confirm','escape','focus-return','semantic-title','busy-state','server-error-announcement','zoom-200-long-name'];const tasks=new Set(v.rows.filter(r=>r.manual&&r.simulated&&r.passed).map(r=>r.task));return required.every(x=>tasks.has(x))&&v.rows.some(r=>r.input==='keyboard-only')&&v.rows.some(r=>r.at===v.environment.assistiveTechnology)&&v.manualVerdict==='pass'&&!v.automationControlsVerdict&&!v.liveRuntimeVerified&&v.untested.length>0}
export function androidVerified(v:AccessibilityVerification):boolean{const required=['row-label-role-state','disabled-reason','switch-spoken-state','no-duplicate-label','detail-focus-return','alternate-switch-input','max-text-scale-long-name'];const tasks=new Set(v.rows.filter(r=>r.manual&&r.simulated&&r.passed).map(r=>r.task));return required.every(x=>tasks.has(x))&&v.rows.some(r=>/talkback/i.test(r.at))&&v.rows.some(r=>/switch/i.test(r.input))&&v.manualVerdict==='pass'&&!v.automationControlsVerdict&&!v.liveRuntimeVerified&&v.untested.length>0}
`;

const WEB_CORPUS = `${JSON.stringify(
  {
    browser: 'Chromium 140',
    screenReader: 'NVDA 2026.2',
    requiredTasks: [
      'focus-entry',
      'focus-trap',
      'cancel',
      'confirm',
      'escape',
      'focus-return',
      'semantic-title',
      'busy-state',
      'server-error-announcement',
      'zoom-200-long-name',
    ],
  },
  null,
  2,
)}\n`;
const ANDROID_CORPUS = `${JSON.stringify(
  {
    platformVersion: 'Android API 37',
    talkBack: 'TalkBack 17.0',
    requiredTasks: [
      'row-label-role-state',
      'disabled-reason',
      'switch-spoken-state',
      'no-duplicate-label',
      'detail-focus-return',
      'alternate-switch-input',
      'max-text-scale-long-name',
    ],
  },
  null,
  2,
)}\n`;

function artifact(root: string, path: string): { value: unknown | null; text: string } {
  const value = readJsonArtifact<unknown>(root, path);
  return { value, text: JSON.stringify(value ?? '').toLowerCase() };
}

function contractGood(text: string, required: string[]): boolean {
  return (
    required.every((x) => text.includes(x)) &&
    /keyboard|controller|alternate input/u.test(text) &&
    /role|name|state|relationship/u.test(text) &&
    /contrast|theme|readab/u.test(text) &&
    /motion/u.test(text) &&
    /untested|unverified/u.test(text) &&
    /not.*(?:tested|verified|conform)|no.*conformance/u.test(text)
  );
}

const editorMaterializer: SkillEvalFixtureMaterializer = {
  id: 'accessibility-practice/cross-platform-editor-contract@1',
  matches: (s) => s.id === EDITOR,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-accessibility-editor'));
    writeFixtureFile(d, 'evidence/accessibility-scope.json', CONTRACT_CORPUS);
    writeFixtureFile(
      d,
      'README.md',
      `# Cross-platform editor accessibility contract\n\nWrite \`.kory-eval/editor-contract.json\`. Cover every supplied critical task, macOS and Windows, custom tree/grid/diagnostics role-name-state-relationship semantics, focus/keyboard/state announcements, text scaling, contrast/theme, motion, and non-single-channel information. Include a verification matrix naming platform, assistive technology/input, task/state, manual-versus-automatable status, and untested combinations. This is design work: do not claim runtime tests or conformance were performed.\n`,
    );
  },
};

const editorScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-practice/cross-platform-editor-contract-scorer@1',
  scenarioIds: [EDITOR],
  score: ({ workingDirectory }) => {
    const fixed =
      readFileSync(join(workingDirectory, 'evidence/accessibility-scope.json'), 'utf8') ===
      CONTRACT_CORPUS;
    const r = artifact(workingDirectory, '.kory-eval/editor-contract.json');
    const good =
      Boolean(r.value) &&
      contractGood(r.text, [
        'open-project',
        'navigate-project',
        'edit',
        'search',
        'diagnostics',
        'command-discovery',
        'conflict-resolution',
        'interruption-recovery',
        'macos',
        'windows',
        'tree',
        'grid',
      ]);
    return {
      passed: fixed && good,
      quality: fixed && good ? 1 : Boolean(r.value) ? 0.55 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `editor equivalent-access contract: ${good ? 'complete' : 'missing'}`,
        `fixed scope preserved: ${fixed ? 'yes' : 'no'}`,
      ],
    };
  },
};

const gameMaterializer: SkillEvalFixtureMaterializer = {
  id: 'accessibility-practice/action-game-system@1',
  matches: (s) => s.id === GAME,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-accessibility-game'));
    writeFixtureFile(d, 'evidence/accessibility-scope.json', CONTRACT_CORPUS);
    writeFixtureFile(
      d,
      'README.md',
      `# Controller-first game accessibility system\n\nWrite \`.kory-eval/game-accessibility.json\`. Preserve controller-first gameplay while keeping required actions remappable/reachable, avoiding input traps, and giving dialogue, non-speech audio, fast visual/combat/status cues and communication redundant/configurable channels. Cover camera/motion intensity, text/HUD readability, timing prompts and dense upgrade navigation. Include representative menu/tutorial/combat/co-op/pause/recovery validation across named input/accessibility configurations and unverified hardware/runtime combinations. Use game/platform guidance rather than DOM/CSS mechanics and do not claim compliance.\n`,
    );
  },
};

const gameScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-practice/action-game-system-scorer@4',
  scenarioIds: [GAME],
  score: ({ workingDirectory }) => {
    const fixed =
      readFileSync(join(workingDirectory, 'evidence/accessibility-scope.json'), 'utf8') ===
      CONTRACT_CORPUS;
    const r = artifact(workingDirectory, '.kory-eval/game-accessibility.json');
    const required = ['menu', 'tutorial', 'combat', 'recovery'];
    const normalized = r.text.replace(/[^a-z0-9]+/gu, '');
    const combatStatusCoverage = /status|health|cooldown|stamina|ammunition|ammo/u.test(r.text);
    const cooperativeCommunicationCoverage =
      /coop|co-op|multiplayer/u.test(r.text) && /communication|ping|chat/u.test(r.text);
    const pauseSettingsCoverage = /pause/u.test(r.text) && /setting|configur/u.test(r.text);
    const dialogueCoverage = /dialogue|subtitle|caption/u.test(r.text);
    const nonSpeechAudioCoverage =
      /non.?speech|sound|audio cue|effects/u.test(r.text) && /audio|caption|cue/u.test(r.text);
    const visualEventCoverage =
      /visual|icon|indicator|telegraph/u.test(r.text) && /event|cue|state|threat/u.test(r.text);
    const good =
      Boolean(r.value) &&
      required.every((x) => normalized.includes(x.replace(/[^a-z0-9]+/gu, ''))) &&
      combatStatusCoverage &&
      cooperativeCommunicationCoverage &&
      pauseSettingsCoverage &&
      dialogueCoverage &&
      nonSpeechAudioCoverage &&
      visualEventCoverage &&
      /remap|controller/u.test(r.text) &&
      /redundan|configur/u.test(r.text) &&
      /motion|camera/u.test(r.text) &&
      /long|text|readab/u.test(r.text) &&
      /unverified|untested/u.test(r.text) &&
      !/\bdom\b|\bcss\b/u.test(r.text) &&
      /not.*(?:compliance|conformance)|no.*(?:compliance|conformance)/u.test(r.text);
    return {
      passed: fixed && good,
      quality: fixed && good ? 1 : Boolean(r.value) ? 0.55 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `game-specific equivalent-access design: ${good ? 'complete' : 'missing'}`,
        `fixed task/channel scope preserved: ${fixed ? 'yes' : 'no'}`,
      ],
    };
  },
};

const webMaterializer: SkillEvalFixtureMaterializer = {
  id: 'accessibility-verification/web-delete-dialog@3',
  readinessBlockers: [WEB_VERIFY_RUNTIME_BLOCKER],
  matches: (s) => s.id === WEB_VERIFY,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-accessibility-web'));
    writeFixtureFile(d, 'src/accessibility-sim.ts', VERIFY_SIM);
    writeFixtureFile(d, 'evidence/web.json', WEB_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Web dialog accessibility verification fixture\n\nUse the supplied synthetic browser/screen-reader harness and write \`.kory-eval/web-verification.json\` as \`AccessibilityVerification\`. Copy the browser and assistive-technology identity strings exactly from \`evidence/web.json\`; keep capability/context notes in observations rather than appending them to identity fields. Record keyboard-only focus entry/trap/order/Escape/focus-return, dialog semantics, busy state and injected-error announcement, plus 200% zoom with the long localized name. Rows performed in this fixture must be labeled \`simulated:true\`; set \`liveRuntimeVerified:false\`. Run/record automation separately and keep \`automationControlsVerdict:false\`: scanner output never replaces the manual interaction verdict. Preserve untested real AT/browser combinations.\n`,
    );
  },
};

const webScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-verification/web-delete-dialog-scorer@2',
  scenarioIds: [WEB_VERIFY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{webDialogVerified,type AccessibilityVerification}from'../src/accessibility-sim';const c=JSON.parse(readFileSync('evidence/web.json','utf8'));const v=JSON.parse(readFileSync('.kory-eval/web-verification.json','utf8')) as AccessibilityVerification;test('hidden: simulated manual task evidence controls verdict, not scanner',()=>{expect(v.environment.browser).toBe(c.browser);expect(v.environment.assistiveTechnology).toBe(c.screenReader);expect(webDialogVerified(v)).toBe(true);});\n`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/accessibility-sim.ts'), 'utf8') === VERIFY_SIM &&
      readFileSync(join(workingDirectory, 'evidence/web.json'), 'utf8') === WEB_CORPUS;
    return {
      passed: hidden.passed && fixed,
      quality: hidden.passed && fixed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `web AT/keyboard/reflow simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed harness preserved: ${fixed ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const androidMaterializer: SkillEvalFixtureMaterializer = {
  id: 'accessibility-verification/android-notification-settings@2',
  readinessBlockers: [ANDROID_VERIFY_RUNTIME_BLOCKER],
  matches: (s) => s.id === ANDROID_VERIFY,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-accessibility-android'));
    writeFixtureFile(d, 'src/accessibility-sim.ts', VERIFY_SIM);
    writeFixtureFile(d, 'evidence/android.json', ANDROID_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Android Compose accessibility verification fixture\n\nUse the supplied synthetic Android/TalkBack/switch-input harness and write \`.kory-eval/android-verification.json\` as \`AccessibilityVerification\`. Copy the platform and assistive-technology identity strings exactly from \`evidence/android.json\`; keep switch/capability notes in row evidence rather than appending them to identity fields. Verify row label/role/checked state, disabled reason, spoken state change without duplicate labels, detail-return focus context, alternate switch traversal, and maximum text scale with long localization. Label fixture interaction rows \`simulated:true\`, set \`liveRuntimeVerified:false\`, preserve untested real device/AT combinations, and reconcile Compose automation without allowing it to control the manual verdict.\n`,
    );
  },
};

const androidScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-verification/android-notification-settings-scorer@1',
  scenarioIds: [ANDROID_VERIFY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{androidVerified,type AccessibilityVerification}from'../src/accessibility-sim';const c=JSON.parse(readFileSync('evidence/android.json','utf8'));const v=JSON.parse(readFileSync('.kory-eval/android-verification.json','utf8')) as AccessibilityVerification;test('hidden: native AT/switch/scaling evidence controls verdict, not automation',()=>{expect(v.environment.platformVersion).toBe(c.platformVersion);expect(v.environment.assistiveTechnology).toBe(c.talkBack);expect(androidVerified(v)).toBe(true);});\n`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/accessibility-sim.ts'), 'utf8') === VERIFY_SIM &&
      readFileSync(join(workingDirectory, 'evidence/android.json'), 'utf8') === ANDROID_CORPUS;
    return {
      passed: hidden.passed && fixed,
      quality: hidden.passed && fixed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `Android TalkBack/switch/scaling simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed harness preserved: ${fixed ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

export const ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  editorMaterializer,
  gameMaterializer,
  webMaterializer,
  androidMaterializer,
];
export const ACCESSIBILITY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  editorScorer,
  gameScorer,
  webScorer,
  androidScorer,
];
