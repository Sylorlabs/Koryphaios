/**
 * Full-task scenarios whose acceptance contract depends on an environment that
 * the current built-in evaluator cannot faithfully provide.
 *
 * This inventory lives in its own module with no imports so the promotion gate
 * can read it without pulling the fixture registry (and its cycle back into
 * `skill-evaluations`) into the evaluator.
 */

export interface ExternalEnvironmentGate {
  scenarioIds: readonly string[];
  skill: string;
  blocker: string;
}

export const EXTERNAL_ENVIRONMENT_GATES: readonly ExternalEnvironmentGate[] = [
  {
    skill: 'computer-use',
    scenarioIds: [
      'computer-use-full-task-authorized-export',
      'computer-use-full-task-revocation-race',
    ],
    blocker:
      'Requires a real supported desktop session with the first party computer use adapter, sacrificial authorized and denied targets, native observation and interaction, permission and identity race injection, model image transport, and recorded native action results; fake adapters or source only simulation cannot certify live desktop behavior.',
  },
  {
    skill: 'csharp-dotnet-engineering',
    scenarioIds: [
      'csharp-dotnet-engineering-full-task-1-individual',
      'csharp-dotnet-engineering-full-task-2-individual',
    ],
    blocker:
      'Requires a real .NET build/runtime evaluator for async-disposal and JSON-compatibility behavior; no faithful .NET harness is registered.',
  },
  {
    skill: 'desktop-electron-tauri',
    scenarioIds: [
      'desktop-electron-tauri-full-task-1-individual',
      'desktop-electron-tauri-full-task-2-individual',
    ],
    blocker:
      'Requires an actual Electron/Tauri desktop runtime with window, IPC, dialog, lifecycle, and native-boundary evidence; a headless concept substitute is insufficient.',
  },
  {
    skill: 'embedded-interface',
    scenarioIds: [
      'embedded-interface-full-task-1-individual',
      'embedded-interface-full-task-2-individual',
    ],
    blocker:
      'Requires the declared embedded display/input runtime and representative device-state evidence; no faithful embedded-interface harness is registered.',
  },
  {
    skill: 'factual-research',
    scenarioIds: [
      'factual-research-full-task-1-individual',
      'factual-research-full-task-2-individual',
    ],
    blocker:
      'Requires live public-web retrieval from the declared authoritative sources with freshness/provenance evidence; a sealed or invented snapshot would change the task.',
  },
  {
    skill: 'frontend-engineering',
    scenarioIds: ['frontend-engineering-full-task-confirmed-native'],
    blocker:
      'Requires the declared native application runtime and rendered interaction evidence; the repository-only frontend harness cannot stand in for a native surface.',
  },
  {
    skill: 'game-spatial-interface',
    scenarioIds: [
      'game-spatial-interface-full-task-1-individual',
      'game-spatial-interface-full-task-2-individual',
    ],
    blocker:
      'Requires a real VR/AR spatial runtime with input, occlusion, placement, recovery, and rendered-state evidence; no faithful device harness is registered.',
  },
  {
    skill: 'go-engineering',
    scenarioIds: ['go-engineering-full-task-1-individual', 'go-engineering-full-task-2-individual'],
    blocker:
      'Requires a real Go build/runtime evaluator for goroutine/context and interface-nil behavior; no faithful Go harness is registered.',
  },
  {
    skill: 'gpu-compute',
    scenarioIds: ['gpu-compute-full-task-1-individual', 'gpu-compute-full-task-2-individual'],
    blocker:
      'Requires the declared GPU/CUDA-capable runtime with kernel execution, memory, synchronization, and profiling evidence; CPU simulation is not equivalent.',
  },
  {
    skill: 'integration-fault-testing',
    scenarioIds: ['integration-fault-testing-full-task-1', 'integration-fault-testing-full-task-2'],
    blocker:
      'Requires the declared live dependency/fault-injection environment (including PostgreSQL and Toxiproxy-class failure injection); no faithful integration harness is registered.',
  },
  {
    skill: 'ios-swiftui',
    scenarioIds: ['ios-swiftui-full-task-1-individual', 'ios-swiftui-full-task-2-individual'],
    blocker:
      'Requires an iOS simulator/device SwiftUI runtime with navigation, scene restoration, cancellation, and rendered/accessibility evidence; compilation alone is insufficient.',
  },
  {
    skill: 'kotlin-engineering',
    scenarioIds: [
      'kotlin-engineering-full-task-1-individual',
      'kotlin-engineering-full-task-2-individual',
    ],
    blocker:
      'Requires a real Kotlin compiler/runtime evaluator for coroutine lifetime and sealed-JSON compatibility behavior; no faithful Kotlin harness is registered.',
  },
  {
    skill: 'literature-research',
    scenarioIds: [
      'literature-research-full-task-1-individual',
      'literature-research-full-task-2-individual',
    ],
    blocker:
      'Requires live scholarly-source discovery/retrieval with publication/version provenance; a closed corpus would remove the research behavior being evaluated.',
  },
  {
    skill: 'market-competitive-research',
    scenarioIds: [
      'market-competitive-research-full-task-1-individual',
      'market-competitive-research-full-task-2-individual',
    ],
    blocker:
      'Requires live market/public-web evidence with dated source provenance and cross-source reconciliation; static synthetic claims are not an equivalent task.',
  },
  {
    skill: 'native-interface',
    // The macOS/AppKit arm now has a faithful harness (skill-eval-native-interface-runtime.ts):
    // a real key window, a real responder chain, and a toolkit capture. The iOS arm still
    // needs a booted simulator lifecycle run, so it stays gated on its own.
    scenarioIds: ['native-interface-full-task-mobile-recovery'],
    blocker:
      'Requires a representative mobile native runtime with platform interaction, accessibility, lifecycle, and rendered-state evidence; the iOS arm has no faithful harness registered.',
  },
  {
    skill: 'nextjs-engineering',
    scenarioIds: [
      'nextjs-engineering-full-task-1-individual',
      'nextjs-engineering-full-task-2-individual',
    ],
    blocker:
      'Requires a real Next.js application build/server plus browser execution for server/client cache and Server Action behavior; source-only simulation is insufficient.',
  },
  {
    skill: 'novel-ui-toolkit',
    scenarioIds: [
      'novel-ui-toolkit-full-task-1-individual',
      'novel-ui-toolkit-full-task-2-individual',
    ],
    blocker:
      'Requires an actual rendered custom-toolkit runtime with input, virtualization, focus, semantics, and accessibility evidence; data-structure simulation cannot certify the UI.',
  },
  {
    skill: 'performance-debugging',
    scenarioIds: ['performance-debugging-full-task-1', 'performance-debugging-full-task-2'],
    blocker:
      'Requires the declared reproducible workload plus real profiler/resource/heap evidence before and after a causal fix; synthetic timing numbers cannot establish performance causality.',
  },
  {
    skill: 'performance-testing',
    scenarioIds: ['performance-testing-full-task-1'],
    blocker:
      'Requires the declared versioned service plus k6-compatible controlled load environment, isolated warmup/repetitions, service and generator resource accounting, and deterministic response oracle; no faithful service-load harness is registered.',
  },
  {
    skill: 'php-engineering',
    scenarioIds: [
      'php-engineering-full-task-1-individual',
      'php-engineering-full-task-2-individual',
    ],
    blocker:
      'Requires a real PHP runtime evaluator for request-worker state and strict JSON boundary behavior; no faithful PHP harness is registered.',
  },
  {
    skill: 'property-fuzz-differential-testing',
    scenarioIds: [
      'property-fuzz-differential-testing-full-task-1-individual',
      'property-fuzz-differential-testing-full-task-2-individual',
    ],
    blocker:
      'Requires the declared property-testing frameworks, generated campaigns, shrinking/replay evidence, and independent oracle execution; fixed concept vectors are not a substitute.',
  },
  {
    skill: 'react-engineering',
    scenarioIds: [
      'react-engineering-full-task-1-individual',
      'react-engineering-full-task-2-individual',
    ],
    blocker:
      'Requires a real React render/browser harness for effects, list identity, interaction, and user-visible state evidence; reducer-level simulation is insufficient.',
  },
  {
    skill: 'react-native-expo',
    scenarioIds: [
      'react-native-expo-full-task-1-individual',
      'react-native-expo-full-task-2-individual',
    ],
    blocker:
      'Requires an actual React Native/Expo device or simulator runtime for AppState, safe-area, keyboard, lifecycle, and rendered interaction evidence.',
  },
  {
    skill: 'research',
    scenarioIds: ['research-full-task-1-individual', 'research-full-task-2-individual'],
    blocker:
      'Requires the declared dated authoritative/community source corpus or live retrieval with exact provenance; the required historical snapshots are not captured locally and must not be fabricated.',
  },
  {
    skill: 'simulation-device-testing',
    scenarioIds: ['simulation-device-testing-full-task-1', 'simulation-device-testing-full-task-2'],
    blocker:
      'Requires the declared Zephyr/STM32 or PX4 HITL/SITL-class simulator/device environment and injected fault evidence; no faithful target simulator is registered.',
  },
  {
    skill: 'speech-audio-ai',
    scenarioIds: [
      'speech-audio-ai-full-task-1-individual',
      'speech-audio-ai-full-task-2-individual',
    ],
    blocker:
      'Requires actual speech/audio assets, model/runtime inference, measured outputs, and representative listening/error evidence; text-only scoring cannot certify the full task.',
  },
  {
    skill: 'video-production',
    scenarioIds: [
      'video-production-full-task-1-individual',
      'video-production-full-task-2-individual',
    ],
    blocker:
      'Requires actual media sources, timeline/render/export output, technical measurements, and representative visual/listening review; text artifacts are insufficient.',
  },
  {
    skill: 'visual-verification',
    scenarioIds: ['visual-verification-full-task-2'],
    blocker:
      'Requires real browser/native capture at declared states/viewports plus visual/accessibility inspection evidence; synthetic state descriptions cannot replace rendered verification.',
  },
  {
    skill: 'vue-engineering',
    scenarioIds: [
      'vue-engineering-full-task-1-individual',
      'vue-engineering-full-task-2-individual',
    ],
    blocker:
      'Requires a real Vue application/runtime plus browser execution for watcher, route, computed, and v-model ownership behavior; source-only simulation is insufficient.',
  },
] as const;

/** Scenario to the reason no registered evaluator can execute it. */
export const EXTERNAL_ENVIRONMENT_BLOCKED_SCENARIOS: ReadonlyMap<string, string> = new Map(
  EXTERNAL_ENVIRONMENT_GATES.flatMap((gate) =>
    gate.scenarioIds.map((scenarioId) => [scenarioId, gate.blocker] as const),
  ),
);

/**
 * The blocker for a scenario that only has the fail-closed environment gate.
 *
 * Whether a scenario is actually gated is decided by the dispatch contract, not
 * by this inventory: a real-runtime materializer registered ahead of the gate
 * supersedes it for that scenario. This map only supplies the explanation once
 * dispatch has already established that the gate is what would run.
 */
export function externalEnvironmentBlockerFor(scenarioId: string): string | null {
  return EXTERNAL_ENVIRONMENT_BLOCKED_SCENARIOS.get(scenarioId) ?? null;
}

/**
 * Drop the external environment placeholder once a real evaluator covers the same
 * scenario. The placeholder exists to name the absence of an evaluator; it is not an
 * evaluator, so keeping it after one is registered would double the artifact and, worse,
 * make the campaign and the promotion gate compute different contract hashes for the
 * same scenario, which silently excludes every run of the real harness.
 */
export function dropExternalEnvironmentPlaceholders(ids: readonly string[]): string[] {
  const real = ids.filter((id) => !id.includes('/external-environment-gate'));
  return real.length ? real : [...ids];
}
