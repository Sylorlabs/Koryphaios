import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-accessibility-fixtures';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';

const EDITOR = 'accessibility-practice-full-task-cross-platform-editor';
const GAME = 'accessibility-practice-full-task-game-system';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'kory-a11y-design-regression-'));
  roots.push(root);
  const scenario = { id } as SkillEvalScenarioV3;
  const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((row) => row.matches(scenario));
  const scorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((row) => row.scenarioIds.includes(id));
  if (!materializer || !scorer) throw new Error(`Fixture for ${id} missing`);
  await materializer.materialize(root, scenario);
  const score = async (file: string, artifact: unknown) => {
    writeFixtureFile(root, `.kory-eval/${file}`, JSON.stringify(artifact));
    return scorer.score({ workingDirectory: root, scenario } as Parameters<typeof scorer.score>[0]);
  };
  return { score };
}

const editorCases = [
  [
    'open-project',
    'Fifty thousand lazy entries load progressively',
    'Keep the project load progress announced while keyboard access to the tree remains possible',
  ],
  [
    'navigate-project',
    'Filtering recycles selected virtualized tree rows and moves focus',
    'Keep logical selection separate from DOM focus and announce the new focused surviving row',
  ],
  [
    'edit',
    'An unsaved dirty document may be hidden by asynchronous state transitions',
    'Announce dirty and pending sync state without moving keyboard caret or losing local edits',
  ],
  [
    'search',
    'Asynchronous search filters can recycle the selected tree row',
    'Return focus to the search filter and announce result count when the previous row is removed',
  ],
  [
    'diagnostics',
    'Asynchronous diagnostics may arrive while focus stays in the editor',
    'Expose diagnostic role name state relationships and announce the new severity and source location',
  ],
  [
    'command-discovery',
    'Palette selection changes can hide available actions',
    'Expose command name role disabled state and keyboard completion without pointer reliance',
  ],
  [
    'conflict-resolution',
    'Merge conflict replaces the focused editor while edits remain unsaved',
    'Offer cancel and undo through keyboard input and restore caret focus and local dirty state',
  ],
  [
    'interruption-recovery',
    'Save interrupts after local write but before sync confirmation',
    'On restart restore unsaved local edits and distinguish pending sync from remote confirmed state',
  ],
] as const;

function editorArtifact() {
  return {
    scope:
      'Native macOS VoiceOver and Windows NVDA semantics; WCAG web guidance does not establish native conformance. Real runtime not verified; all combinations untested.',
    design:
      'Virtualized tree and diagnostics grid expose role, name, state and relationship; focus versus selection is explicit. Text scaling and contrast themes preserve actions with reduced motion and non-color state cues.',
    taskContracts: editorCases.map(([taskId, barrier, alternative]) => ({
      taskId,
      goal: `Finish ${taskId} using keyboard or alternative input with an equivalent preserved user outcome.`,
      barrier,
      alternative,
      failureState: `Failure if ${taskId} silently loses focus or state and the user cannot complete the operation.`,
      recoveryInvariant: `Recovery after ${taskId} restores logical context, announces the state and preserves all user edits.`,
      owner: 'Desktop interaction engineering and accessibility QA',
    })),
    verificationMatrix: editorCases.map(([taskId], index) => ({
      taskId,
      platform: index % 2 ? 'Windows 11 (proposed)' : 'macOS (proposed)',
      assistiveTechnology: index % 2 ? 'NVDA (planned)' : 'VoiceOver (planned)',
      input:
        index % 2
          ? 'keyboard and switch alternative input'
          : 'keyboard and voice control alternative input',
      expectedObservation: `A ${taskId} success or recovery result announces names, focus transitions and error state.`,
      method: 'Operator-driven assistive technology interaction and keyboard focus trace',
      status: 'untested',
      observedResult: null,
      evidenceRef: null,
      risk: 'Runtime and screen-reader interaction not yet observed on real machines',
    })),
    regressionOracles: [
      {
        trigger: 'Filter a 50,000 row lazy tree until a selected row recycles',
        failure: 'Focus points at an unrelated file after recycling',
        recoveryInvariant: 'The surviving file selection remains reachable and announced',
      },
      {
        trigger: 'Inject asynchronous diagnostics while typing at a document caret',
        failure: 'Diagnostic appears without accessible severity or steals focus',
        recoveryInvariant: 'Caret stays in editor while actionable diagnostics can be visited',
      },
      {
        trigger: 'Open merge conflict with unsaved edits and cancel with keyboard',
        failure: 'Conflict dialog traps input or destroys local edits',
        recoveryInvariant: 'Cancel restores caret and unsaved dirty edits',
      },
      {
        trigger: 'Interrupt a save before sync confirmation then restart',
        failure: 'False saved state hides missing edits',
        recoveryInvariant: 'Local edits survive, sync state remains pending and is announced',
      },
    ],
    untested: ['macOS VoiceOver hardware and real editor', 'Windows NVDA and Narrator hardware'],
  };
}

const gameCases = [
  [
    'menu',
    'Forty-item upgrade tree hides focus and prerequisite status',
    'Preserve focused upgrade ID across scrolling, text scaling and return to purchase dialog',
  ],
  [
    'tutorial',
    'Long unreadable tutorial cues disappear during timed prompts',
    'Provide readable captions, adjustable timing, alternate input and screen narration',
  ],
  [
    'combat',
    'A brief red-only telegraph and directionless non-speech alarm hide urgency',
    'Give directional alarm source and urgency through shape, captions and haptic redundant cues',
  ],
  [
    'coop-communication',
    'Voice-only co-op instructions exclude silent players',
    'Supply team text chat and contextual ping communication with acknowledgment',
  ],
  [
    'pause-settings',
    'Shared online combat continues while a player enters the settings menu',
    'Offer an online-safe settings overlay with protected return; offline solo play can pause',
  ],
  [
    'recovery',
    'Controller disconnects during boss combat and remap Confirm conflicts with Back and Pause',
    'Freeze local input where safe, guide reconnect and restore saved binding or undo conflicting remap',
  ],
] as const;

const gameChannels = [
  [
    'dialogue',
    'Spoken narrative dialogue with speaker, content and timing',
    'Adjustable caption text and screen narration with speaker names',
  ],
  [
    'non-speech-audio',
    'Directional non-speech alarm source, urgency and distance',
    'Spatial indicator and caption plus configurable haptic urgency',
  ],
  [
    'visual-events',
    'Brief red-only boss telegraph indicating the attack direction',
    'Persistent shape, pattern and caption cues with adjustable timing',
  ],
  [
    'combat-status',
    'Health stamina and ammunition change rapidly during attack',
    'On-demand readable HUD and configurable critical-state speech',
  ],
  [
    'communication',
    'Online co-op strategy and mission decisions via voice',
    'Contextual ping and text chat with visible acknowledgments',
  ],
] as const;

function gameArtifact() {
  return {
    scope:
      'Controller-first action game; not compliance or a universal conformance verdict. PC and console hardware unverified, runtime untested.',
    design:
      'Remap Confirm, Back and Pause with collision detection and saved rollback. Reconnect after a disconnect. Camera shake and motion can be disabled, upgrade focus and selection survive pagination, text HUD remains readable. Offline solo pause is allowed while online shared time continues.',
    taskContracts: gameCases.map(([taskId, barrier, alternative]) => ({
      taskId,
      goal: `Complete ${taskId} with an equivalent accessible player outcome using the controller or adaptive input.`,
      barrier,
      alternative,
      failureState: `A failed ${taskId} state leaves the player unable to interpret progress, recover or complete the objective.`,
      recoveryInvariant: `Restore context, focus and player control for ${taskId} after reconnect or cancel without losing progress.`,
      owner: 'Gameplay input system and accessibility product owner',
    })),
    channelAlternatives: gameChannels.map(([channelId, information, alternative]) => ({
      channelId,
      information,
      alternative,
      deliveryBehavior: `Present ${channelId} information in configurable redundant visual, audio or haptic cues without one-sense dependence.`,
    })),
    verificationMatrix: gameCases.map(([taskId]) => ({
      taskId,
      platform: 'Unspecified game platform/build; PC or console to be confirmed',
      controller: 'Gamepad controller and keyboard or adaptive input',
      expectedObservation: `The ${taskId} action completes with a perceivable status and recoverable focus.`,
      method: 'Planned game input trace with assistive settings and captured player-visible state',
      status: 'planned',
      observedResult: null,
      evidenceRef: null,
      risk: 'Game device, adaptive controller and co-op runtime not yet available',
    })),
    regressionOracles: [
      {
        trigger: 'Remap Confirm onto Back and Pause in controller settings',
        failure: 'Remap collision strands essential actions',
        recoveryInvariant: 'Restore reachable Back and Pause via conflict undo and default binding',
      },
      {
        trigger: 'Disconnect and reconnect the controller during a timed boss attack',
        failure: 'Input loss causes irreversible player control failure',
        recoveryInvariant:
          'Accessible reconnection path preserves saved bindings and returns player orientation',
      },
      {
        trigger: 'Mute audio during urgent directional non-speech alarm',
        failure: 'Direction and urgency are missing from redundant visual cues',
        recoveryInvariant:
          'Persist direction, source and urgency via caption and spatial indicator',
      },
      {
        trigger: 'Enable colorblind mode during red-only attack telegraph',
        failure: 'Telegraph is undetectable without red color information',
        recoveryInvariant: 'Pattern and timing cues allow an informed reaction',
      },
      {
        trigger: 'Paginate 40-upgrade menu then undo selection',
        failure: 'Upgrade focus or selection jumps to wrong item',
        recoveryInvariant: 'Restore logical selection, prerequisites and context',
      },
      {
        trigger: 'Online co-op player opens pause settings without voice chat',
        failure: 'Shared online time is falsely paused or team communication is lost',
        recoveryInvariant:
          'Text and ping coordination continue; solo offline pause remains available',
      },
    ],
    untested: ['Controller hardware', 'Console narration', 'Real co-op session'],
  };
}

test('editor scorer accepts a fully structured, honestly untested native-access contract', async () => {
  const { score } = await fixture(EDITOR);
  const full = editorArtifact();
  expect((await score('editor-contract.json', full)).passed).toBe(true);

  full.taskContracts[3]!.recoveryInvariant = 'Reset';
  expect((await score('editor-contract.json', full)).passed).toBe(false);

  const omitted = editorArtifact();
  omitted.regressionOracles.splice(1, 1);
  expect((await score('editor-contract.json', omitted)).passed).toBe(false);

  const claimedLive = editorArtifact();
  claimedLive.verificationMatrix[0]!.status = 'passed';
  claimedLive.verificationMatrix[0]!.observedResult =
    'NVDA announced a successful live interaction';
  expect((await score('editor-contract.json', claimedLive)).passed).toBe(false);
});

test('game scorer accepts specific multi-channel recovery design and rejects missing channel or false runtime evidence', async () => {
  const { score } = await fixture(GAME);
  const full = gameArtifact();
  const scored = await score('game-accessibility.json', full);
  expect(scored.passed, scored.evidence.join('\n')).toBe(true);

  const explicitExclusions = {
    ...gameArtifact(),
    scope: {
      applicability:
        'Controller-first action game; not compliance or conformance. Actual game runtime unverified, all hardware tests untested.',
      excludedClaims: [
        'DOM and CSS web UI mechanics are out of scope for native game accessibility.',
      ],
    },
  };
  expect((await score('game-accessibility.json', explicitExclusions)).passed).toBe(true);

  const metadataExclusion = {
    ...gameArtifact(),
    artifact: {
      guidancePosition:
        'Game accessibility is based on native interaction; Web DOM and CSS mechanics are out of scope.',
      evidenceLimit: 'The actual game controller and runtime have not been tested.',
    },
  };
  expect((await score('game-accessibility.json', metadataExclusion)).passed).toBe(true);

  const metadataImplementation = {
    ...metadataExclusion,
    artifact: {
      ...metadataExclusion.artifact,
      guidancePosition: 'Implement game accessibility using a DOM tree with CSS styles.',
    },
  };
  expect((await score('game-accessibility.json', metadataImplementation)).passed).toBe(false);

  const actualWebImplementation = {
    ...explicitExclusions,
    design: `${explicitExclusions.design} Build the controller interface with DOM and CSS as the accessibility mechanism.`,
  };
  expect((await score('game-accessibility.json', actualWebImplementation)).passed).toBe(false);

  const mislabelledImplementation = {
    ...explicitExclusions,
    scope: {
      ...explicitExclusions.scope,
      excludedClaims: ['Implement game controls through DOM and CSS mechanics.'],
    },
  };
  expect((await score('game-accessibility.json', mislabelledImplementation)).passed).toBe(false);

  const noChannel = gameArtifact();
  noChannel.channelAlternatives.splice(1, 1);
  expect((await score('game-accessibility.json', noChannel)).passed).toBe(false);

  const noRemapRecovery = gameArtifact();
  noRemapRecovery.regressionOracles.splice(0, 1);
  expect((await score('game-accessibility.json', noRemapRecovery)).passed).toBe(false);

  const inventedHardwareEvidence = gameArtifact();
  inventedHardwareEvidence.verificationMatrix[2]!.status = 'passed';
  inventedHardwareEvidence.verificationMatrix[2]!.observedResult =
    'Live adaptive controller verified';
  expect((await score('game-accessibility.json', inventedHardwareEvidence)).passed).toBe(false);
});
