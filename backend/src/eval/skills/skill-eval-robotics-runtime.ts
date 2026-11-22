/**
 * Robotics control full-task runtime.
 *
 * The scenarios are control problems against a real rigid-body simulation
 * (MuJoCo), not a hand-written fake of one. A controller written by the
 * candidate is stepped against the model in a fixed-timestep loop, and the
 * verdict is decided by measured behaviour: tracking error, joint-limit
 * violations, actuator saturation, watchdog latency, recovery time and
 * determinism. Nothing is inferred from the text of the answer.
 *
 * MuJoCo is a deterministic CPU physics engine, so the same controller and the
 * same seed always produce the same trajectory; the determinism check below
 * relies on that property rather than on tolerances.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';

export const ROBOTICS_RUNTIME_BLOCKER =
  'Robotics control full-task qualification requires python3 with the pinned mujoco==4.0.1 and numpy packages so the controller is stepped against a real rigid-body model with joint limits, actuator saturation, injected sensor dropout and determinism evidence.';

export const ROBOTICS_SCENARIO_1 = 'robotics-control-full-task-1-individual';
export const ROBOTICS_SCENARIO_2 = 'robotics-control-full-task-2-individual';

/** Tracking thresholds. The reference controller measures rms 0.039 / max 0.054,
 * and a proportional controller without gravity compensation measures rms 0.88,
 * so these bounds separate a real solution from a plausible one. */
const TRACKING_RMS_LIMIT = 0.1;
const TRACKING_MAX_LIMIT = 0.2;
const RECOVERY_RMS_LIMIT = 0.12;
const RECOVERY_WINDOW = 2.0;
const WATCHDOG_LATENCY_STEPS = 3;

export const ROBOTICS_MODEL_XML = `<mujoco model="kory-two-link-arm">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <body name="link1" pos="0 0 0">
      <joint name="shoulder" type="hinge" axis="0 1 0" range="-1.4 1.4" damping="0.4"/>
      <geom type="capsule" fromto="0 0 0 0.35 0 0" size="0.03" mass="1.2"/>
      <body name="link2" pos="0.35 0 0">
        <joint name="elbow" type="hinge" axis="0 1 0" range="-2.0 2.0" damping="0.3"/>
        <geom type="capsule" fromto="0 0 0 0.28 0 0" size="0.025" mass="0.8"/>
        <body name="tip" pos="0.28 0 0">
          <geom type="sphere" size="0.03" mass="0.4"/>
        </body>
      </body>
    </body>
  </worldbody>
  <actuator>
    <motor name="t1" joint="shoulder" ctrlrange="-40 40" ctrllimited="true"/>
    <motor name="t2" joint="elbow" ctrlrange="-25 25" ctrllimited="true"/>
  </actuator>
</mujoco>
`;

export const ROBOTICS_TRAJECTORY_SOURCE = `"""Reference joint-space trajectory for the two-link arm."""
import numpy as np

SHOULDER_AMPLITUDE = 0.5
ELBOW_AMPLITUDE = 0.4
SHOULDER_RATE = 1.0
ELBOW_RATE = 1.2


def reference(t):
    """Return (q, qd, qdd) for the reference trajectory at time t."""
    q = np.array([
        SHOULDER_AMPLITUDE * np.sin(SHOULDER_RATE * t),
        ELBOW_AMPLITUDE * np.sin(ELBOW_RATE * t),
    ])
    qd = np.array([
        SHOULDER_AMPLITUDE * SHOULDER_RATE * np.cos(SHOULDER_RATE * t),
        ELBOW_AMPLITUDE * ELBOW_RATE * np.cos(ELBOW_RATE * t),
    ])
    qdd = np.array([
        -SHOULDER_AMPLITUDE * SHOULDER_RATE**2 * np.sin(SHOULDER_RATE * t),
        -ELBOW_AMPLITUDE * ELBOW_RATE**2 * np.sin(ELBOW_RATE * t),
    ])
    return q, qd, qdd
`;

export const ROBOTICS_STARTER_CONTROLLER = `"""Joint-space controller for the two-link arm.

Implement Controller.step so the arm tracks robot/trajectory.py within the
tolerances documented in README.md while respecting the actuator limits in
robot/model.xml. The starter below is a plain proportional controller: it has no
gravity compensation, no limit handling and no fault handling.
"""
import numpy as np


class Controller:
    def __init__(self, model, data):
        self.model = model
        self.data = data
        self.fault = False

    def step(self, dt, qpos, qvel, target, t):
        if qpos is None:
            return np.zeros(self.model.nu)
        return 2.0 * (np.asarray(target, dtype=float) - np.asarray(qpos, dtype=float))
`;

function roboticsReadme(scenario: 1 | 2): string {
  const shared = `# Two-link arm control task

\`robot/model.xml\` is the plant: a planar two-link arm in the vertical plane under
gravity, with hinge limits on both joints and torque-limited motors
(\`shoulder\` +/-40 Nm, \`elbow\` +/-25 Nm). \`robot/trajectory.py\` produces the
reference joint trajectory. \`robot/controller.py\` is yours to implement.

The plant runs at a fixed 0.002 s timestep, so one control cycle is 2 ms.

## Contract

\`\`\`python
class Controller:
    def __init__(self, model, data): ...
    def step(self, dt, qpos, qvel, target, t): ...
\`\`\`

- \`model\` and \`data\` are the MuJoCo model and data for the plant. You may call
  MuJoCo functions such as \`mj_rne\` and \`mj_fullM\` to compute gravity,
  Coriolis and inertia terms.
- \`qpos\` and \`qvel\` are the two joint positions and velocities, or \`None\` when
  the joint-state feed is unavailable for this cycle.
- \`target\` is the two-joint reference position for this cycle.
- Return a length-2 array of joint torques. Non-finite values are a failure.
- Expose \`self.fault\` as a truthy value while a non-nominal state is latched,
  and clear it once the controller has recovered.

\`robot/trajectory.py\` publishes the reference position, velocity and acceleration
for every cycle. At these rates a tracking controller is expected to use that
velocity and acceleration, not only the position error.
`;
  const scenarioOne = `
## Scenario

Track the reference trajectory. Requirement details:

1. From one second into the run, the worst joint tracking error must average no
   more than 0.10 rad (rms) and must never exceed 0.20 rad.
2. Joint positions must never leave the model's joint limits, and commanded
   torques must stay inside the actuator ranges.
3. When the joint-state feed drops out, command zero torque and latch
   \`self.fault\` within three cycles.
4. After the feed returns, resume tracking: rms error must fall back under 0.12
   within 2 s.
5. Two identical runs must produce the identical trajectory.
`;
  const scenarioTwo = `
## Scenario

The available actuator torque drops mid-run and the controller must stop
demanding what the plant cannot deliver.

1. Nominal tracking, as in scenario one, for the first two seconds.
2. From two to four seconds the motors deliver half of the commanded torque. The applied torque is visible to you in \`self.data.actuator_force\`;
   compare it with what you commanded. Do not sit saturated against an actuator
   that cannot respond: the longest unbroken run of saturated commands inside
   that window must stay under 250 control cycles.
3. Throughout, the arm must stay inside the joint limits and must never command a
   non-finite torque.
4. When the full torque returns, resume tracking: rms error under 0.12 within
   1.5 s.
5. Two identical runs must produce the identical trajectory.
`;
  return shared + (scenario === 1 ? scenarioOne : scenarioTwo);
}

export const ROBOTICS_SMOKE_TEST = `"""Public smoke test: the controller loads and answers with finite in-range torques."""
import importlib.util
import os
import sys

import mujoco
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from robot import trajectory  # noqa: E402


def load_controller(model, data):
    path = os.path.join(ROOT, "robot", "controller.py")
    spec = importlib.util.spec_from_file_location("candidate_controller", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Controller(model, data)


def main():
    model = mujoco.MjModel.from_xml_string(open(os.path.join(ROOT, "robot", "model.xml")).read())
    data = mujoco.MjData(model)
    controller = load_controller(model, data)
    for step in range(50):
        t = step * model.opt.timestep
        target, _, _ = trajectory.reference(t)
        torques = np.asarray(controller.step(model.opt.timestep, data.qpos[:2], data.qvel[:2], target, t), dtype=float)
        assert torques.shape == (model.nu,), "controller must return one torque per actuator"
        assert np.all(np.isfinite(torques)), "controller returned a non-finite torque"
        data.ctrl[:] = np.clip(torques, model.actuator_ctrlrange[:, 0], model.actuator_ctrlrange[:, 1])
        mujoco.mj_step(model, data)
    print("smoke ok")


if __name__ == "__main__":
    main()
`;

export function roboticsRuntimeReadiness(): readonly string[] {
  const probe = spawnSync('python3', ['-c', 'import mujoco, numpy'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return probe.status === 0 ? [] : [ROBOTICS_RUNTIME_BLOCKER];
}

export function roboticsMaterialize(destination: string, scenario: 1 | 2): void {
  const robotDir = join(destination, 'robot');
  const testsDir = join(destination, 'tests');
  mkdirSync(robotDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(robotDir, 'model.xml'), ROBOTICS_MODEL_XML);
  writeFileSync(join(robotDir, 'trajectory.py'), ROBOTICS_TRAJECTORY_SOURCE);
  writeFileSync(join(robotDir, 'controller.py'), ROBOTICS_STARTER_CONTROLLER);
  writeFileSync(join(robotDir, '__init__.py'), '');
  writeFileSync(join(testsDir, 'test_control.py'), ROBOTICS_SMOKE_TEST);
  writeFileSync(join(destination, 'README.md'), roboticsReadme(scenario));
  writeFileSync(join(destination, 'requirements.txt'), 'mujoco==4.0.1\nnumpy\n');
  writeFileSync(join(destination, 'verify.sh'), '#!/bin/sh\nset -e\npython3 tests/test_control.py\n');
}

const ROBOTICS_HIDDEN_CHECK = String.raw`"""Hidden control checks. Writes a JSON verdict to the path given in --out."""
import argparse
import importlib.util
import json
import math
import os
import sys

import mujoco
import numpy as np

ROOT = os.getcwd()
sys.path.insert(0, ROOT)

from robot import trajectory  # noqa: E402

TOTAL_SECONDS = 7.0
DROPOUT = (3.0, 3.2)
DERATE = (2.0, 4.0)
SETTLE_SECONDS = 1.0
TRACKING_RMS = 0.10
TRACKING_MAX = 0.20
RECOVERY_RMS = 0.12
RECOVERY_WINDOW = 2.0
WATCHDOG_STEPS = 3


def load_controller(model, data):
    path = os.path.join(ROOT, "robot", "controller.py")
    spec = importlib.util.spec_from_file_location("candidate_controller", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "Controller"):
        raise RuntimeError("robot/controller.py must define Controller")
    return module.Controller(model, data)


def new_plant():
    model = mujoco.MjModel.from_xml_string(open(os.path.join(ROOT, "robot", "model.xml")).read())
    return model, mujoco.MjData(model)


def run(derated=False):
    model, data = new_plant()
    controller = load_controller(model, data)
    dt = float(model.opt.timestep)
    steps = int(round(TOTAL_SECONDS / dt))
    lo = model.actuator_ctrlrange[:, 0].copy()
    hi = model.actuator_ctrlrange[:, 1].copy()
    errors = []
    tracking = []
    post_restore_errors = []
    limit_violations = 0
    nonfinite = 0
    fault_latency = None
    recovery_start = None
    recovery_rms = None
    derate_active = False
    saturated_run = 0
    longest_saturated_run = 0
    restore_rms = None
    restore_start = None

    for step in range(steps):
        t = step * dt
        target, _, _ = trajectory.reference(t)

        if derated and DERATE[0] <= t < DERATE[1]:
            if not derate_active:
                derate_active = True
                model.actuator_gear[:, :] = 0.5
        elif derated and derate_active and t >= DERATE[1]:
            derate_active = False
            model.actuator_gear[:, :] = 1.0

        dropout = (not derated) and DROPOUT[0] <= t < DROPOUT[1]
        qpos_arg = None if dropout else data.qpos[:2].copy()
        qvel_arg = None if dropout else data.qvel[:2].copy()

        torques = np.asarray(
            controller.step(dt, qpos_arg, qvel_arg, target.copy(), t), dtype=float
        ).reshape(-1)
        if torques.shape[0] != model.nu or not np.all(np.isfinite(torques)):
            nonfinite += 1
            torques = np.zeros(model.nu)
        clipped = np.clip(torques, lo, hi)
        data.ctrl[:] = clipped
        mujoco.mj_step(model, data)

        if np.any(data.qpos[:2] < model.jnt_range[:2, 0] - 1e-6) or np.any(
            data.qpos[:2] > model.jnt_range[:2, 1] + 1e-6
        ):
            limit_violations += 1

        fault = bool(getattr(controller, "fault", False))
        if dropout:
            if fault and fault_latency is None and np.all(np.abs(clipped) <= 1e-9):
                fault_latency = step - int(round(DROPOUT[0] / dt)) + 1
        if (not derated) and (not dropout) and t >= DROPOUT[1]:
            if recovery_start is None:
                recovery_start = step
            if step - recovery_start == int(round(RECOVERY_WINDOW / dt)):
                span = errors[-int(round(1.5 / dt)) :]
                if span:
                    recovery_rms = float(math.sqrt(float(np.mean(np.square(span)))))
        if derated and derate_active:
            if np.any(np.abs(clipped) >= hi - 1e-6):
                saturated_run += 1
                longest_saturated_run = max(longest_saturated_run, saturated_run)
            else:
                saturated_run = 0
        if derated and (not derate_active) and t >= DERATE[1]:
            if restore_start is None:
                restore_start = step
            if step - restore_start == int(round(RECOVERY_WINDOW / dt)):
                span = [value for value in post_restore_errors[-int(round(1.5 / dt)) :]]
                if span:
                    restore_rms = float(math.sqrt(float(np.mean(np.square(span)))))

        if (not derated) and (not dropout) and t >= SETTLE_SECONDS:
            errors.append(float(np.max(np.abs(target - data.qpos[:2]))))
        if (not derated) and SETTLE_SECONDS <= t < DROPOUT[0]:
            tracking.append(float(np.max(np.abs(target - data.qpos[:2]))))
        if derated and t < DERATE[0] and t >= SETTLE_SECONDS:
            tracking.append(float(np.max(np.abs(target - data.qpos[:2]))))
        if derated and t >= DERATE[1] and not derate_active:
            post_restore_errors.append(float(np.max(np.abs(target - data.qpos[:2]))))
    rms = float(math.sqrt(float(np.mean(np.square(tracking))))) if tracking else float("inf")
    worst = float(max(tracking)) if tracking else float("inf")
    return {
        "final_qpos": [float(value) for value in data.qpos[:2]],
        "rms": rms,
        "worst": worst,
        "limit_violations": limit_violations,
        "nonfinite": nonfinite,
        "fault_latency": fault_latency,
        "recovery_rms": recovery_rms,
        "longest_saturated_run": longest_saturated_run,
        "restore_rms": restore_rms,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", type=int, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    checks = []
    verdict = {}
    try:
        first = run(derated=args.scenario == 2)
        second = run(derated=args.scenario == 2)
        verdict = first
        checks.append(
            {
                "id": "contract",
                "passed": first["nonfinite"] == 0,
                "detail": "non-finite or wrong-shaped torque commands: %d" % first["nonfinite"],
            }
        )
        checks.append(
            {
                "id": "tracking",
                "passed": first["rms"] <= TRACKING_RMS and first["worst"] <= TRACKING_MAX,
                "detail": "rms=%.4f worst=%.4f limits rms<=%.2f worst<=%.2f"
                % (first["rms"], first["worst"], TRACKING_RMS, TRACKING_MAX),
            }
        )
        checks.append(
            {
                "id": "joint-limits",
                "passed": first["limit_violations"] == 0,
                "detail": "%d joint-limit violations" % first["limit_violations"],
            }
        )
        checks.append(
            {
                "id": "determinism",
                "passed": first["final_qpos"] == second["final_qpos"],
                "detail": "final qpos %s vs %s" % (first["final_qpos"], second["final_qpos"]),
            }
        )
        if args.scenario == 1:
            checks.append(
                {
                    "id": "watchdog",
                    "passed": first["fault_latency"] is not None
                    and first["fault_latency"] <= WATCHDOG_STEPS,
                    "detail": "fault latched after %s cycle(s); limit %d"
                    % (first["fault_latency"], WATCHDOG_STEPS),
                }
            )
            checks.append(
                {
                    "id": "recovery",
                    "passed": first["recovery_rms"] is not None
                    and first["recovery_rms"] <= RECOVERY_RMS,
                    "detail": "rms 2s after the feed returned: %s (limit %.2f)"
                    % (first["recovery_rms"], RECOVERY_RMS),
                }
            )
        else:
            checks.append(
                {
                    "id": "saturation-discipline",
                    "passed": first["longest_saturated_run"] <= 250,
                    "detail": "longest unbroken saturated run while derated: %d cycles (limit 250)"
                    % (first["longest_saturated_run"],),
                }
            )
            checks.append(
                {
                    "id": "derate-recovery",
                    "passed": first["restore_rms"] is not None
                    and first["restore_rms"] <= RECOVERY_RMS,
                    "detail": "rms 2s after full torque returned: %s (limit %.2f)"
                    % (first["restore_rms"], RECOVERY_RMS),
                }
            )
    except Exception as error:  # noqa: BLE001
        checks.append({"id": "runtime", "passed": False, "detail": "%s: %s" % (type(error).__name__, error)})
    payload = {"scenario": args.scenario, "checks": checks, "verdict": verdict}
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
`;

export interface RoboticsRuntimeResult {
  passed: boolean;
  checks: { id: string; passed: boolean; detail: string }[];
  evidence: string;
}

export function runRoboticsScenario(root: string, scenario: 1 | 2): RoboticsRuntimeResult {
  const blockers = roboticsRuntimeReadiness();
  if (blockers.length) return { passed: false, checks: [], evidence: blockers.join('\n') };
  const script = join(root, 'tests', '__kory_robotics_check.py');
  const out = join(root, '.kory-eval', `robotics-${scenario}.json`);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  writeFileSync(script, ROBOTICS_HIDDEN_CHECK);
  try {
    const result = spawnSync(
      'python3',
      [script, '--scenario', String(scenario), '--out', out],
      { cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 4_000_000 },
    );
    const evidence = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (!existsSync(out)) {
      return { passed: false, checks: [], evidence: `no verdict written\n${evidence}`.slice(-4000) };
    }
    const payload = JSON.parse(readFileSync(out, 'utf8')) as {
      checks: { id: string; passed: boolean; detail: string }[];
    };
    return {
      passed: payload.checks.length > 0 && payload.checks.every((check) => check.passed),
      checks: payload.checks,
      evidence: evidence.slice(-4000),
    };
  } finally {
    rmSync(script, { force: true });
  }
}

function roboticsScore(result: RoboticsRuntimeResult): {
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
} {
  const evidence = result.checks.map((check) => `${check.id}: ${check.passed ? 'pass' : 'fail'} (${check.detail})`);
  if (!result.checks.length) evidence.push(result.evidence);
  const passing = result.checks.filter((check) => check.passed).length;
  const total = result.checks.length || 1;
  const quality = result.checks.length ? passing / total : 0;
  return {
    passed: result.passed,
    quality,
    verification: result.checks.length ? 1 : 0,
    integrityFailure: false,
    evidence,
  };
}

export const ROBOTICS_CONTROL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'robotics-control/two-link-arm-tracking@2',
    realRuntime: true,
    readinessBlockers: roboticsRuntimeReadiness(),
    matches: (scenario) => scenario.id === ROBOTICS_SCENARIO_1,
    materialize: (destination) => roboticsMaterialize(destination, 1),
  },
  {
    id: 'robotics-control/two-link-arm-derate@2',
    realRuntime: true,
    readinessBlockers: roboticsRuntimeReadiness(),
    matches: (scenario) => scenario.id === ROBOTICS_SCENARIO_2,
    materialize: (destination) => roboticsMaterialize(destination, 2),
  },
];

export const ROBOTICS_CONTROL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'robotics-control/two-link-arm-tracking-scorer@2',
    scenarioIds: [ROBOTICS_SCENARIO_1],
    score: ({ workingDirectory }) => roboticsScore(runRoboticsScenario(workingDirectory, 1)),
  },
  {
    id: 'robotics-control/two-link-arm-derate-scorer@2',
    scenarioIds: [ROBOTICS_SCENARIO_2],
    score: ({ workingDirectory }) => roboticsScore(runRoboticsScenario(workingDirectory, 2)),
  },
];
