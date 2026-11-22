# image-generation-practice: real image-model runtime

Status: **ready**. Coverage `{positive: 5, negative: 5, ambiguous: 3, adversarial: 3, full-task: 2, regression: 0}`, zero gate reasons.
Skill version 5.2.2. Fixture runtime `backend/src/eval/skills/skill-eval-imagegen-runtime.ts`. Tests `backend/src/kory/__tests__/skill-eval-imagegen-runtime.test.ts` (5/5).

## What the package was before

`image-generation-practice` 5.1.0 was one of the packages that could not be qualified on this host: both of its full-task scenarios were served by `skill-eval-external-environment-boundaries.ts`, which materializes a workspace that refuses to render and scores zero. Nothing measured an image. The scenarios referenced synthetic fixtures (`product-hero-iteration`, `editorial-character-consistency`) that never existed as materializers.

This work replaced the refusal with a real generation loop against a live image model and graded the bytes that came back.

## Model selection, measured

Logfare exposes 32 models, 5 of them image capable: `flux-2-dev`, `flux-2-klein-4b`, `flux-2-klein-9b`, `flux-1-schnell`, `sdxl-lightning`. Probing `POST /v1/images/generations` found two properties that shape the whole fixture:

| Property | Measurement |
| --- | --- |
| Canvas control | only `sdxl-lightning` honours `size`; `flux-1-schnell` and `flux-2-klein-*` always return 1024x1024 |
| Availability | `flux-2-dev` and `flux-2-klein-9b` returned 503 on every attempt during this work |
| Determinism | identical prompt, seed and size produce different bytes (177540 vs 126499), so no byte-equality assertion is possible |
| Response encoding | JPEG in `data[0].b64_json`, converted with `/usr/bin/sips` for the PNG decoder |

Fixed model: `flux-2-klein-4b` at 1024x1024. It is the only available model that follows a flat, few-colour brief. Measured contrast at identical prompt, seed 501 and canvas:

| Model | palette (95% coverage) | background share | border share |
| --- | --- | --- | --- |
| `flux-2-klein-4b` | 5 | 0.90 | 0.00 |
| `sdxl-lightning` | 802 | 0.21 | 0.79 |

That contrast is the fixture's central lesson and it is disclosed in `brief/examples.json`, not hidden.

## Measurement

The scorer decodes the returned image and measures it in process:

- `paletteColors95`: distinct 5-bit colour buckets covering 95% of the frame
- `backgroundShare`: pixels within 40 levels of the brief background
- `accentShare`: pixels within 48 levels of the brief accent
- `cornerMaxSpread`: largest luma range inside any 24x24 corner patch
- `subjectBorderShare`: non-background pixels inside the outer 10% border
- `forbiddenShare`: pixels within 40 levels of the forbidden colour
- `subjectCentroidX` / `subjectCentroidY`: mean position of non-background pixels

Thresholds and their measured margins:

| Constraint | Limit | Qualified renders | Unqualified renders |
| --- | --- | --- | --- |
| paletteColors95 | <= 12 | 2 to 7 | 24 to 2975 |
| backgroundShare | >= 0.60 | 0.82 to 0.95 | 0.07 to 0.69 |
| accentShare | >= 0.03 | 0.045 to 0.216 | 0.000 |
| cornerMaxSpread | <= 20 | 3 to 9 | 3 to 246 |
| subjectBorderShare | <= 0.10 | 0.00 to 0.05 | 0.03 to 0.98 |
| forbiddenShare | <= 0.01 | 0.000 | 0.000 |

No threshold was moved after a candidate failed. The two threshold changes made during this work were corrections to the fixture's own design, both recorded below.

## Scenarios

**Scenario 1, brand hero variants.** The workspace carries `brief/brand.json` (palette, identity descriptor, thresholds, allowed models), `brief/examples.json` (measurements from real renders, including failing ones), `generation/spec.json` (starter, fails), and `tools/check-spec.mjs` (shape validation only; it cannot render). The scorer renders the candidate's spec and grades six checks: `contract`, `render`, `palette`, `layout`, `accent`, `variant-budget`.

**Scenario 2, brand asset set.** Three assets from one identity: `hero`, `avatar`, `footer-card`. Eight checks: `contract`, `identity-reuse`, `render-all`, `palette`, `accent`, `composition-hero`, `composition-avatar`, `composition-card`. The composition checks are what separate a real asset set from three copies of one prompt: the avatar must fill more of the frame while staying within 0.20 of centre, and the footer card must put its subject centroid at or below 0.55 of the frame height.

Two variants per target is the budget. The first conforming variant wins, so a candidate gets one recovery attempt per asset and no more.

## Fixture defects found by measurement

1. **The scenario-1 starter satisfied its own contract.** The starter used `sdxl-lightning` with a declared 512x512 canvas, which the sizing model honours, and a prompt long enough to pass the shape rules. The contract now requires an explicitly declared canvas for every variant, which is a real requirement (the brief states the canvas) and makes the starter fail the way a hand-in with no spec would.
2. **A qualified prompt is not enough; placement language has to lead.** Modifier-only phrasing ("low in the frame") returned a centred subject. Measured across seeds, the same request restated as a bottom anchored composition moved the subject centroid from 0.37 to 0.75 to 0.80 of frame height. The threshold stayed at 0.55. Both candidates that failed scenario 2 failed exactly this check at 0.45 to 0.52, which is the discrimination the check exists for.
3. **The skill did not teach either lesson.** Two content additions were made and measured, not guessed: model-to-constraint matching (the 802 colour contrast above) and leading with the placement anchor. Version 5.2.0 to 5.2.1 to 5.2.2, each bump with a real content change.

## Campaign

Executor `logfare-text-patch`, subject `qwen-3.8-27b` with `kimi-k2.7-code` and `glm-5.3-flash` as alternates, `GH_TOKEN` present, no codex. At the final revision `7e259d6f`:

| Run | Result |
| --- | --- |
| scenario 1, with-skill | pass, quality 1.000 |
| scenario 1, without-skill | pass, quality 1.000 |
| scenario 2, with-skill | pass, quality 1.000 |
| scenario 2, without-skill | fail, quality 0.875 (`composition-card`, centroid 0.45) |
| blind review observation, scenario 1 | pass, quality 0.900 |

Blind review `blind-v5-3932afd1daf3854aa9d7` persisted at `2026-11-17T05:46:03.445Z`, reviewer `deepseek-v4.1-flash-1017`, mapping A `without-skill` / B `with-skill`.

## Refusals recorded

- No byte-identical or hash-based image assertion. The service is stochastic with a fixed seed, so any such assertion would be a fabricated check.
- No determinism check. The robotics and hardware harnesses can assert determinism because their plants are deterministic; this service is not.
- No claim that a prompt guarantees an image. Every check is a measurement of a rendered file, and a failed render is reported as a failed render.
- The gate removal for `image-generation-practice` was made only after both scenarios rendered real images and both arms of each pair produced a recordable result.

## Shared files touched

- `backend/src/eval/skills/skill-eval-fixtures.ts`: registered `IMAGEGEN_MATERIALIZERS` and `IMAGEGEN_SCORERS`.
- `backend/src/eval/skills/skill-eval-external-environment-boundaries.ts`: removed the two `image-generation-practice` gate entries.
- `backend/src/kory/__tests__/skill-eval-external-environment-fixtures.test.ts`: gate counts 59 to 57 and 55 to 53, because two scenarios are now served by a real runtime.
- `skills-v5/image-generation-practice/{SKILL.md,kory.json}`: content additions and the version bump.

## Library versus reality

- The provider model list implies every model can satisfy any image brief. It cannot: canvas control and palette discipline are separate capabilities, and only one available model has both.
- The model catalogue names five image models; two of them were unavailable (503) for the whole session, so a package that pinned either would have been blocked by infrastructure rather than by skill.
- The repository had no media evaluator to reuse. The measurement code here is new and is limited to what a JPEG decoder plus simple colour statistics can prove.

## Verification run

- `bun test src/kory/__tests__/skill-eval-imagegen-runtime.test.ts`: 5 pass, 0 fail, including two network tests that assert the starter fails and the qualified spec passes every check on both scenarios.
- `bun test ./src/kory/__tests__/skill-eval-external-environment-fixtures.test.ts`: 0 fail after the count update.
- `evaluateSkillPromotion`: status `ready`, reasons empty, open regressions zero.
- Library inventory after this work: 173 ready, 1 blocked, 8 insufficient-evidence.
