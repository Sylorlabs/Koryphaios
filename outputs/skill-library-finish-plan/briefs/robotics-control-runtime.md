# robotics-control: a real simulator instead of a declared refusal

`robotics-control` was one of thirteen packages whose full-task scenarios were
declared unenforceable. Its blocker was the only one in that group whose own text
allowed a faithful simulator, so this is the one I built rather than declared.

## The harness

`backend/src/eval/skills/skill-eval-robotics-runtime.ts` (moved there by the
concurrent `kory/` to `eval/skills/` refactor) steps a candidate controller
against a real MuJoCo plant: a planar two-link arm in the vertical plane under
gravity, hinge limits on both joints, torque-limited motors, a 2 ms fixed
timestep. MuJoCo 4.0.1 runs on CPU and is deterministic, so the same controller
produces the same trajectory every time, which the determinism check relies on
instead of a tolerance.

The candidate's job is real control work: `Controller.step(dt, qpos, qvel,
target, t)` against a reference trajectory that publishes position, velocity and
acceleration. Nothing about the verdict reads the text of the answer.

| Scenario | What it measures |
|---|---|
| `full-task-1` tracking | rms <= 0.10 rad and worst <= 0.20 rad after one second, zero joint-limit violations, watchdog latching zero torque within 3 cycles of the joint-state feed dropping out, recovery to rms <= 0.12 within 2 s, identical trajectory on two runs |
| `full-task-2` derating | the same tracking before the fault, no unbroken saturated command run longer than 250 cycles while the actuators deliver half torque, joint limits respected throughout, recovery within 2 s of full torque returning, identical trajectory on two runs |

## It discriminates, which is the only thing that makes it evidence

- Shipped starter, a proportional controller with no gravity compensation:
  scenario 1 rms 0.879 and 308 limit violations; scenario 2 rms 0.763 and 1035
  limit violations. It fails tracking, limits, watchdog and recovery.
- Computed-torque reference controller (gravity, Coriolis and inertia terms plus
  reference velocity and acceleration): scenario 1 rms 0.0075 with 0 violations
  and recovery 0.011; scenario 2 rms 0.0039, longest saturated run 0, recovery
  0.020. It passes every check.

Both arms are pinned by
`backend/src/kory/__tests__/skill-eval-robotics-runtime.test.ts`: the starter must
fail, the reference must pass, and the registered scorers must cover exactly the
two robotics scenarios.

## Calibration was measured, not chosen

The 0.10 rad bound sits between a controller that compensates the modelled
dynamics and uses the reference feedforward (0.004 to 0.008 rad) and one that
only closes a position loop (0.15 rad with gravity compensation, 0.76 to 0.88
without). The first reference attempt also showed why the derate must be half
strength rather than a fifth: at 0.2 gear the plant is genuinely under-actuated,
the arm physically reaches a joint limit, and no controller could have kept the
safety invariant. At 0.5 gear a competent controller holds and recovers, and the
naive one still fails.

## Evidence

- Routing: 5 positive, 5 negative, 3 ambiguous, 3 adversarial, precision and
  recall 1.00.
- Full-task: 7 passing candidate runs of 36 at the final contract, both scenarios
  covered, 0 open regressions.
- Blind review: persisted (`robotics-control`, reviewer deepseek-v4.1-flash-1017).
- Gate: `status ready`, coverage
  `{positive:5, negative:5, ambiguous:3, adversarial:3, full-task:2, regression:0}`,
  zero reasons.
- Skill version 5.1.1 to 5.2.1: the scenario prompts and requirements now describe
  the actual repository task, and the skill gained the paragraph that says a
  tracking controller is not an error gain (compensate the modelled dynamics, use
  the reference feedforward, clamp to the actuator envelope, treat a derated
  actuator as a state to detect rather than to fight). That paragraph measurably
  moved candidates from a proportional controller to a real one.

## One adapter limit worth recording

The Logfare reviewer spends its whole completion budget on a sealed assignment
whose candidate artifact is a full source file and returns
`finish_reason=length` with empty content, which is why the first review attempt
emitted nothing. `scripts/kory-logfare-stateless-reviewer.ts` now honours
`KORY_LOGFARE_REVIEWER_MAX_TOKENS` (default unchanged at 4096); at 16000 the same
assignment returns a complete adjudication.
