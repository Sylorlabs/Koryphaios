# Interactive visual evidence and full task coverage

This reference translates the task specifications in `../evals/tasks/` into a **coverage plan**, not a claim that fixture assets, actual UI, platforms, or evaluation results were inspected. The `fixture://` identifiers in those specs are logical starting states. Find actual inputs from the supplied workspace or task packet when access is permitted; if they are not available, say so without filling in imaginary data.

## Evidence ladder

A visual claim must name the strongest level actually completed:

1. **Design grounded in the source:** inspected content, components, token/schema paths, assets, existing screens or state definitions. Cite the specific supplied path and state. A task prompt alone supports only an intended design.
2. **Valid output:** saved artifact exists, is parseable where required, and retains required keys, types, values, and identifiers. This proves structural completion only.
3. **Rendered check:** launched/opened a real UI or faithful prototype at a recorded theme, platform or emulator, window size, and text scale; inspected an actual frame or capture for hierarchy, clipping, alignment, and contrast. A screenshot by itself does not prove transitions.
4. **Interactive check:** exercised the approved trigger (pointer, keyboard, or other supported input), observed the resulting visual state and restoration/recovery when applicable, and recorded the result and capture or repeatable procedure. A mock that only styles hover, a clickable link to nowhere, or an uninspected preview does not qualify.
5. **Platform check:** exercised the app in the actual target platform or clearly identified emulator, recording native chrome, typography, scrollbar, focus, and scaling behavior. A browser view on one OS does not verify another OS.

Use `observed`, `planned`, `blocked`, or `unverified` per check. Do not promote a lower level to a higher one by inference. If a medium is unavailable, record the missing observation and proposed method without weakening the criterion. Paired candidate/baseline experiments and blind judging belong to the evaluation harness; do not manufacture their reports.

## Matrix fields

Record one row per meaningful **surface × state × condition**, splitting rows when a single result cannot substantiate both conditions:

| Field               | What to capture                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Source              | The supplied fixture/content, existing behavior or component, and required check it supports; identify absent input explicitly. |
| Condition           | Surface, named state, platform, theme, width, text scale, density, and relevant content extreme.                                |
| Trigger             | User action or fixture transition already permitted by the interaction contract; `none` for a purely visual condition.          |
| Expected            | Visible hierarchy, signal, focus/selection treatment, status cue without color, or overflow behavior.                           |
| Method              | File/schema readback, launch and screenshot, actual interaction, native platform check, or planned method.                      |
| Status and evidence | Observation with capture/path and reproducible step, or `planned`/`blocked`/`unverified` with missing dependency.               |

Check visual behavior **during** state transitions: visible interactive affordances, focus continuity, feedback under loading/error, selection legibility, readable status without color or animation, and whether narrow layouts or large text obscure a contracted action. Make visual adjustments within existing behavior; route changes to workflow, navigation, permission, or recovery semantics to their owning discipline.

## Coverage targets from the two task specifications

These are requirements **listed by the scenario specs**, not verified source fixtures or sample output values.

| Scenario                          | Required surface and conditions to plan                                                                                                                                                                                                                                               | Evidence and boundaries                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dense-operations-workspace`      | Existing table and case detail surfaces with real dense and sparse content; primary versus secondary actions; named risk/status severities; normal, focus, selected, error and relevant disabled/empty states; long/localized labels; applicable viewing conditions and themes.       | Inspect actual identity tokens, component/state inventory and content if supplied. Record visual hierarchy, semantic cues without color and justified token use; remove gratuitous card/shadow treatment. Render or use a faithful prototype and check the relevant states. Preserve existing information architecture and interactions. |
| `cross-platform-editor-direction` | Sidebars, search results, diagnostics, central canvas; macOS and Windows adaptations versus shared identity; light and dark; varying window sizes; dense/sparse, focused/selected/diagnostic states; long localized labels and large text; reduced motion if animation is introduced. | Inspect actual screenshots, assets and platform constraints if supplied. Specify reusable typography, density, color, icon, and spacing treatments. Verify platform appearance in the actual medium where possible; label missing native renders unverified. Preserve the approved interaction and content model.                        |

For either scenario, deliver the named artifact for visual direction and the matrix of states and scales in the requested format; preserve schema and tokens from real supplied inputs. The third required artifact, a report on paired experiments, must come from the harness when it runs. A narrative can describe a proposed visual decision but cannot serve as proof of a rendered or interactive check.
