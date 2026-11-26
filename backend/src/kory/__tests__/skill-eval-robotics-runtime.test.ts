import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, afterEach, test } from 'bun:test';
import {
  ROBOTICS_CONTROL_SCORERS,
  roboticsMaterialize,
  roboticsRuntimeReadiness,
  runRoboticsScenario,
  type RoboticsRuntimeResult,
} from '../../eval/skills/skill-eval-robotics-runtime';

/**
 * The robotics fixture is only worth anything if it separates a real controller
 * from a plausible one, so every scenario is measured twice: the shipped starter
 * must fail, and a genuine controller must pass the identical checks.
 */
const REFERENCE_CONTROLLER = `import mujoco
import numpy as np


class Controller:
    """Computed-torque tracking with joint-limit clamping and derating discipline."""

    def __init__(self, model, data):
        self.model = model
        self.data = data
        self.kp = np.array([900.0, 675.0])
        self.kd = np.array([70.0, 56.0])
        self.fault = False
        self.derated = 0
        self.held = False
        self.calm = 0
        self.zero = np.zeros(model.nu)

    def step(self, dt, qpos, qvel, target, t):
        limit = self.model.actuator_ctrlrange[:, 1]
        if qpos is None or not np.all(np.isfinite(qpos)) or not np.all(np.isfinite(qvel)):
            self.fault = True
            self.derated = 0
            return self.zero
        q = np.asarray(qpos, dtype=float)
        qd = np.asarray(qvel, dtype=float)
        from robot import trajectory

        q_des, qd_des, qdd_des = trajectory.reference(t)
        if float(np.max(self.model.actuator_gear[:, 0])) < 0.99:
            self.derated += 1
        else:
            self.derated = 0
        if self.derated > 50:
            self.held = True
            self.calm = 0
        if self.held:
            self.calm += 1
            hold = 22.0 * (q_des - q) - 5.0 * qd
            if self.calm > 100:
                self.held = False
            return np.clip(hold, -0.5 * limit, 0.5 * limit)
        bias = np.zeros(self.model.nv)
        mujoco.mj_rne(self.model, self.data, 0, bias)
        mass = np.zeros((self.model.nv, self.model.nv))
        mujoco.mj_fullM(self.model, self.data, mass)
        acc = qdd_des + self.kp * (q_des - q) + self.kd * (qd_des - qd)
        return np.clip((mass @ acc + bias)[: self.model.nu], -limit, limit)
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function materialize(scenario: 1 | 2, controller?: string): string {
  const root = mkdtempSync(join(tmpdir(), `kory-robotics-${scenario}-`));
  roots.push(root);
  roboticsMaterialize(root, scenario);
  if (controller) writeFileSync(join(root, 'robot', 'controller.py'), controller);
  return root;
}

function detail(result: RoboticsRuntimeResult): string {
  return result.checks.map((check) => `${check.id}=${check.passed}`).join(' ');
}

// mujoco/numpy are heavy native Python deps no CI image carries; the readiness
// probe is the designed gate, and the scenario assertions only mean anything
// when the runtime can actually execute.
const roboticsBlockers = roboticsRuntimeReadiness();

describe('robotics control full-task runtime', () => {
  test('the runtime reports readiness only when mujoco and numpy import', () => {
    const blockers = roboticsRuntimeReadiness();
    expect(Array.isArray(blockers)).toBe(true);
    if (blockers.length) expect(blockers[0]).toContain('mujoco');
  }, 120_000);

  test.skipIf(roboticsBlockers.length > 0)('the shipped starter fails tracking, limits, watchdog and recovery on scenario one', () => {
    const result = runRoboticsScenario(materialize(1), 1);
    expect(result.passed).toBe(false);
    const failed = result.checks.filter((check) => !check.passed).map((check) => check.id);
    expect(failed).toContain('tracking');
    expect(failed).toContain('joint-limits');
    expect(failed).toContain('watchdog');
    expect(detail(result)).toContain('contract=true');
  }, 600_000);

  test.skipIf(roboticsBlockers.length > 0)('a computed-torque controller passes every scenario one check', () => {
    const result = runRoboticsScenario(materialize(1, REFERENCE_CONTROLLER), 1);
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      'contract',
      'tracking',
      'joint-limits',
      'determinism',
      'watchdog',
      'recovery',
    ]);
  }, 600_000);

  test.skipIf(roboticsBlockers.length > 0)('the shipped starter fails scenario two', () => {
    const result = runRoboticsScenario(materialize(2), 2);
    expect(result.passed).toBe(false);
    const failed = result.checks.filter((check) => !check.passed).map((check) => check.id);
    expect(failed).toContain('tracking');
    expect(failed).toContain('joint-limits');
  }, 600_000);

  test.skipIf(roboticsBlockers.length > 0)('a controller that respects actuator derating passes scenario two', () => {
    const result = runRoboticsScenario(materialize(2, REFERENCE_CONTROLLER), 2);
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      'contract',
      'tracking',
      'joint-limits',
      'determinism',
      'saturation-discipline',
      'derate-recovery',
    ]);
  }, 600_000);

  test('the scorers are registered for exactly the two robotics scenarios', () => {
    expect(ROBOTICS_CONTROL_SCORERS.map((scorer) => scorer.scenarioIds).flat()).toEqual([
      'robotics-control-full-task-1-individual',
      'robotics-control-full-task-2-individual',
    ]);
  });
});
