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
  'Requires a real supported browser (pinned Chromium 140 on Windows 11) with NVDA 2026.2, independently recorded screen-reader announcements, keyboard focus/order and visible focus, and actual 200% browser zoom/reflow with the long localized name. Playwright accessibility trees and synthetic checks cannot attest screen-reader output.';
const ANDROID_VERIFY_RUNTIME_BLOCKER =
  'Requires a real Android device or emulator (API 37) with TalkBack 17.0 and Switch Access enabled, and independently recorded announcements, focus return, switch traversal, and maximum text-scale/reflow evidence. Compose semantics and synthetic checks cannot attest spoken or alternate-input behavior.';

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

type EvidenceObject = Record<string, unknown>;

function isEvidenceObject(value: unknown): value is EvidenceObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Find actual structured rows, rather than accepting keywords in a JSON note. */
function rowsUnder(value: unknown, keyPattern: RegExp): EvidenceObject[] {
  const results: EvidenceObject[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 7 || !isEvidenceObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (keyPattern.test(key) && Array.isArray(child)) {
        results.push(...child.filter(isEvidenceObject));
      }
      if (isEvidenceObject(child)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return results;
}

function evidenceText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(evidenceText).join(' ');
  if (isEvidenceObject(value)) return Object.values(value).map(evidenceText).join(' ');
  return '';
}

function fieldWithDetail(row: EvidenceObject, pattern: RegExp, minLength = 18): boolean {
  return Object.entries(row).some(
    ([key, value]) => pattern.test(key) && evidenceText(value).length >= minLength,
  );
}

function rowName(row: EvidenceObject): string {
  const named = Object.entries(row).find(
    ([key, value]) => /^(?:task(?:id|name)?|channel(?:id|name)?|id|name|scope)$/iu.test(key)
      && typeof value === 'string',
  );
  return typeof named?.[1] === 'string' ? named[1].toLowerCase().trim() : '';
}

function coversNamedRows(
  rows: EvidenceObject[],
  requiredIds: readonly string[],
  complete: (row: EvidenceObject) => boolean,
): boolean {
  return requiredIds.every((id) => rows.some((row) => rowName(row) === id && complete(row)));
}

function completeTaskContract(row: EvidenceObject): boolean {
  return (
    fieldWithDetail(row, /goal|success|outcome|objective/iu) &&
    fieldWithDetail(row, /barrier|obstacle|problem/iu) &&
    fieldWithDetail(row, /alternate|alternative|equivalent|fallback|accessible.?path/iu) &&
    fieldWithDetail(row, /negative|fail|error.?state/iu) &&
    fieldWithDetail(row, /recover|restore|rollback|invariant|undo/iu) &&
    fieldWithDetail(row, /owner|responsib|component/iu, 3)
  );
}

function plannedMatrixRow(row: EvidenceObject): boolean {
  const status = evidenceText(row.status ?? row.executionStatus).toLowerCase();
  const result = 'observedResult' in row
    ? row.observedResult
    : 'actualResult' in row
      ? row.actualResult
      : row.result;
  const declaredResult = ['observedResult', 'actualResult', 'result'].some((key) => key in row);
  return (
    /^(planned|untested|unverified|blocked|not[ -]?run)$/u.test(status) &&
    declaredResult &&
    (result === null || /^(none|pending|not[ -]?(?:run|observed|executed)|unverified|untested|n\/a)$/iu.test(evidenceText(result))) &&
    fieldWithDetail(row, /platform|operating.?system|device|game.?build/iu, 3) &&
    fieldWithDetail(row, /input|assistive|screen.?reader|controller|configuration/iu, 3) &&
    fieldWithDetail(row, /expected|observable|assertion/iu) &&
    fieldWithDetail(row, /method|procedure|steps|verification/iu, 8) &&
    fieldWithDetail(row, /risk|limitation|gap/iu, 8) &&
    ['evidenceRef', 'provenance', 'evidence', 'captureRef'].some((key) => key in row)
  );
}

function fullTaskMatrix(value: unknown, requiredTasks: readonly string[]): EvidenceObject[] | null {
  const rows = rowsUnder(value, /matrix|verification|validation.?plan|test.?plan/iu)
    .filter(plannedMatrixRow);
  return coversNamedRows(rows, requiredTasks, () => true) ? rows : null;
}

function regressionOracles(value: unknown, signatures: readonly RegExp[]): boolean {
  const rows = rowsUnder(value, /oracle|regression|failure.?probe/iu)
    .filter((row) =>
      fieldWithDetail(row, /trigger|setup|reproduc|scenario/iu) &&
      fieldWithDetail(row, /fail|regression|broken|negative/iu) &&
      fieldWithDetail(row, /recover|invariant|restore|rollback|correct/iu),
    );
  return signatures.every((signature) => rows.some((row) => signature.test(evidenceText(row))));
}

const EDITOR_TASKS = [
  'open-project', 'navigate-project', 'edit', 'search', 'diagnostics',
  'command-discovery', 'conflict-resolution', 'interruption-recovery',
] as const;
const GAME_TASKS = [
  'menu', 'tutorial', 'combat', 'coop-communication', 'pause-settings', 'recovery',
] as const;
const GAME_CHANNELS = [
  'dialogue', 'non-speech-audio', 'visual-events', 'combat-status', 'communication',
] as const;

function editorContractGood(value: unknown): boolean {
  if (!isEvidenceObject(value)) return false;
  const rows = rowsUnder(value, /task.?contract|task.?access|task.?barrier|^tasks$/iu);
  const matrix = fullTaskMatrix(value, EDITOR_TASKS);
  if (!coversNamedRows(rows, EDITOR_TASKS, completeTaskContract) || !matrix) return false;
  const text = evidenceText(value).toLowerCase();
  const matrixText = evidenceText(matrix).toLowerCase();
  return (
    /macos|mac os/u.test(matrixText) && /voiceover/u.test(matrixText) &&
    /windows/u.test(matrixText) && /nvda|narrator/u.test(matrixText) &&
    /keyboard/u.test(matrixText) && /switch|voice.?control|speech.?input|alternate.?input/u.test(matrixText) &&
    /focus/u.test(text) && /select/u.test(text) && /recycl|virtualiz/u.test(text) &&
    /diagnos/u.test(text) && /async|live.?update/u.test(text) &&
    /conflict/u.test(text) && /unsaved|dirty/u.test(text) && /sync|restart/u.test(text) &&
    /tree/u.test(text) && /grid/u.test(text) && /role/u.test(text) && /name/u.test(text) &&
    /state/u.test(text) && /relationship/u.test(text) &&
    /contrast/u.test(text) && /motion/u.test(text) && /scal|zoom/u.test(text) &&
    /untested|unverified/u.test(text) &&
    regressionOracles(value, [/recycl|filter/u, /diagnos/u, /conflict/u, /sav|sync|interrupt/u])
  );
}

/** Explicit applicability exclusions are not proposed game implementation mechanics. */
function gameImplementationText(value: unknown): string {
  if (!isEvidenceObject(value)) return evidenceText(value).toLowerCase();
  const scope = value.scope;
  const artifact = value.artifact;
  const implementation = { ...value };
  if (isEvidenceObject(artifact) && typeof artifact.guidancePosition === 'string' &&
    /\b(?:out of scope|not applicable|excluded|do not use|not used|never used|avoid)\b/iu
      .test(artifact.guidancePosition)) {
    const { guidancePosition, ...metadata } = artifact;
    implementation.artifact = metadata;
  }
  if (isEvidenceObject(scope) && 'excludedClaims' in scope) {
    const { excludedClaims, ...remainingScope } = scope;
    const entries = Array.isArray(excludedClaims) ? excludedClaims : [excludedClaims];
    const assertedImplementations = entries.filter(
      (entry) => !/\b(?:out of scope|not applicable|excluded|do not use|not used|never used|avoid)\b/iu
        .test(evidenceText(entry)),
    );
    implementation.scope = {
      ...remainingScope,
      ...(assertedImplementations.length ? { excludedClaims: assertedImplementations } : {}),
    };
  }
  return evidenceText(implementation).toLowerCase();
}

function gameContractGood(value: unknown): boolean {
  if (!isEvidenceObject(value)) return false;
  const tasks = rowsUnder(value, /task.?contract|task.?access|^tasks$/iu);
  const channels = rowsUnder(value, /channel.?cover|channel.?alternative|information.?channel|^channels$/iu);
  const matrix = fullTaskMatrix(value, GAME_TASKS);
  if (
    !coversNamedRows(tasks, GAME_TASKS, completeTaskContract) || !matrix ||
    !coversNamedRows(channels, GAME_CHANNELS, (row) =>
      fieldWithDetail(row, /information|barrier|source|meaning|content/iu) &&
      fieldWithDetail(row, /alternate|alternative|equivalent|fallback|redundan/iu) &&
      fieldWithDetail(row, /behavior|delivery|implementation|expected/iu),
    )
  ) return false;
  const text = evidenceText(value).toLowerCase();
  const matrixText = evidenceText(matrix).toLowerCase();
  return (
    /controller/u.test(matrixText) && /keyboard|adaptive|switch|alternate.?input/u.test(matrixText) &&
    /remap/u.test(text) && /confirm/u.test(text) && /back/u.test(text) && /pause/u.test(text) &&
    /disconnect/u.test(text) && /reconnect/u.test(text) &&
    /direction/u.test(text) && /urgen/u.test(text) && /alarm/u.test(text) &&
    /telegraph/u.test(text) && /colou?r/u.test(text) &&
    /health/u.test(text) && /stamina/u.test(text) && /ammo|ammunition/u.test(text) &&
    /camera/u.test(text) && /motion/u.test(text) &&
    /upgrade/u.test(text) && /focus|selection/u.test(text) &&
    /co.?op/u.test(text) && /ping|text.?chat/u.test(text) &&
    /online/u.test(text) && /offline|solo/u.test(text) &&
    /untested|unverified/u.test(text) &&
    !/\bdom\b|\bcss\b/u.test(gameImplementationText(value)) &&
    regressionOracles(value, [
      /remap|collision/u, /disconnect|reconnect/u, /alarm|direction/u,
      /telegraph|colo(u)?r/u, /upgrade/u, /online|co.?op|shared/u,
    ])
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
      `# Cross-platform editor accessibility contract\n\nWrite \`.kory-eval/editor-contract.json\`. Cover every supplied critical task, macOS and Windows, custom tree/grid/diagnostics role-name-state-relationship semantics, focus/keyboard/state announcements, text scaling, contrast/theme, motion, and non-single-channel information. Include a verification matrix naming platform, assistive technology/input, task/state, manual-versus-automatable status, and untested combinations. This is design work: do not claim runtime tests or conformance were performed.\n\nUse structured JSON, not a keyword summary: a \`taskContracts\` array with one item per exact task ID (\`taskId\`, \`goal\`, \`barrier\`, \`alternative\`, \`failureState\`, \`recoveryInvariant\`, \`owner\`); a \`verificationMatrix\` array with one row per task (\`taskId\`, \`platform\`, \`assistiveTechnology\`, \`input\`, \`expectedObservation\`, \`method\`, \`status\`, \`observedResult\`, \`evidenceRef\`, \`risk\`); and \`regressionOracles\` with \`trigger\`, \`failure\` and \`recoveryInvariant\` for recycled tree focus, asynchronous diagnostics, conflicts and interrupted saves. Give separate VoiceOver/macOS and NVDA or Narrator/Windows rows plus alternate input. Since no editor/AT runtime exists, set matrix status to planned/untested, observedResult to null and evidenceRef to null.\n`,
    );
  },
};

const editorScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-practice/cross-platform-editor-contract-scorer@2',
  scenarioIds: [EDITOR],
  score: ({ workingDirectory }) => {
    const fixed =
      readFileSync(join(workingDirectory, 'evidence/accessibility-scope.json'), 'utf8') ===
      CONTRACT_CORPUS;
    const r = artifact(workingDirectory, '.kory-eval/editor-contract.json');
    const good =
      editorContractGood(r.value) &&
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
      `# Controller-first game accessibility system\n\nWrite \`.kory-eval/game-accessibility.json\`. Preserve controller-first gameplay while keeping required actions remappable/reachable, avoiding input traps, and giving dialogue, non-speech audio, fast visual/combat/status cues and communication redundant/configurable channels. Cover camera/motion intensity, text/HUD readability, timing prompts and dense upgrade navigation. Include representative menu/tutorial/combat/co-op/pause/recovery validation across named input/accessibility configurations and unverified hardware/runtime combinations. Use game/platform guidance rather than DOM/CSS mechanics and do not claim compliance.\n\nUse structured JSON: \`taskContracts\` with every exact game task ID and \`taskId\`, \`goal\`, \`barrier\`, \`alternative\`, \`failureState\`, \`recoveryInvariant\`, \`owner\`; \`channelAlternatives\` with each exact information-channel ID and \`channelId\`, \`information\`, \`alternative\`, \`deliveryBehavior\`; \`verificationMatrix\` covering all six tasks with \`taskId\`, \`platform\`, \`controller\`/\`input\`, \`expectedObservation\`, \`method\`, \`status\`, \`observedResult\`, \`evidenceRef\`, \`risk\`; and \`regressionOracles\` with \`trigger\`, \`failure\`, \`recoveryInvariant\` for remap collision, disconnect, directional alarm, color-only telegraph, upgrade navigation and online co-op/pause. Use planned/untested status, null observedResult and evidenceRef where hardware/runtime is unavailable.\n`,
    );
  },
};

const gameScorer: SkillEvalDeterministicScorer = {
  id: 'accessibility-practice/action-game-system-scorer@7',
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
    const structured = gameContractGood(r.value);
    const good =
      structured &&
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
      !/\bdom\b|\bcss\b/u.test(gameImplementationText(r.value)) &&
      /not.*(?:compliance|conformance)|no.*(?:compliance|conformance)/u.test(r.text);
    return {
      passed: fixed && good,
      quality: fixed && good ? 1 : Boolean(r.value) ? 0.55 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `game-specific equivalent-access design: ${good ? 'complete' : 'missing'}`,
        `structured task, channel, matrix and regression evidence: ${structured ? 'complete' : 'missing'}`,
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
      `# Web dialog accessibility verification fixture\n\nUse the supplied synthetic browser/screen-reader harness and write \`.kory-eval/web-verification.json\` as \`AccessibilityVerification\`. Copy the browser and assistive-technology identity strings exactly from \`evidence/web.json\`; keep capability/context notes in observations rather than appending them to identity fields. Record keyboard-only focus entry/trap/order/Escape/focus-return, dialog semantics, busy state and injected-error announcement, plus 200% zoom with the long localized name. Rows performed in this fixture must be labeled \`simulated:true\`; set \`liveRuntimeVerified:false\`. Run/record automation separately and keep \`automationControlsVerdict:false\`: scanner output never replaces the manual interaction verdict. Preserve untested real AT/browser combinations.\n\nLive qualification additionally needs a Windows 11 session with the pinned Chromium/NVDA versions, browser keyboard and visible-focus captures, actual browser zoom and reflow measurements, and independently observed NVDA announcements for the required states. Record the actual session, browser/AT versions, input steps, results, and untested combinations. A Chromium accessibility-tree snapshot, Playwright assertion, screen capture without AT interaction, or fabricated manual row is insufficient. This fixture currently measures only simulation and cannot certify a live run.\n`,
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
      `# Android Compose accessibility verification fixture\n\nUse the supplied synthetic Android/TalkBack/switch-input harness and write \`.kory-eval/android-verification.json\` as \`AccessibilityVerification\`. Copy the platform and assistive-technology identity strings exactly from \`evidence/android.json\`; keep switch/capability notes in row evidence rather than appending them to identity fields. Verify row label/role/checked state, disabled reason, spoken state change without duplicate labels, detail-return focus context, alternate switch traversal, and maximum text scale with long localization. Label fixture interaction rows \`simulated:true\`, set \`liveRuntimeVerified:false\`, preserve untested real device/AT combinations, and reconcile Compose automation without allowing it to control the manual verdict.\n\nLive qualification additionally needs an Android API 37 device or emulator with TalkBack 17.0 and Switch Access, independently observed speech and alternate-input traversal/focus, and maximum text-scale captures for long localized names. Record actual device/AT versions, interactions, results, and untested combinations. Accessibility semantics dumps and synthetic events cannot demonstrate spoken or switch-access behavior. This fixture currently measures only simulation.\n`,
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
