/**
 * Progressive-disclosure content for the human-experience branch. These
 * playbooks are intentionally independent of a rendering stack or delivery
 * medium; the resolver decides when their parent skill is relevant.
 */
export type ExperienceSkillName =
  | 'human-experience'
  | 'user-research'
  | 'interaction-design'
  | 'information-architecture'
  | 'visual-interface-design'
  | 'content-error-design'
  | 'accessibility-practice'
  | 'usability-evaluation'
  | 'developer-experience';

export interface ExperienceSkillPlaybook {
  title: string;
  content: string;
}

export const EXPERIENCE_SKILL_PLAYBOOKS: Record<ExperienceSkillName, ExperienceSkillPlaybook> = {
  'human-experience': {
    title: 'Human experience practice',
    content: `Start by naming the people affected, their goals, operating context, capabilities, stakes, and the actual medium. “User” is rarely one audience: distinguish primary operators, occasional users, administrators, support staff, developers, bystanders, and people affected by an automated decision. Inspect existing behavior before proposing a replacement. Record what is observed, what was requested, what is inferred, and what remains unknown.

Frame the work as a journey rather than a screen or endpoint. Map entry, orientation, setup, ordinary use, progress, handoff, interruption, degraded operation, failure, recovery, return, and exit. Identify the few moments where misunderstanding, delay, irreversible action, exclusion, or loss of trust would be expensive. Choose child practices because of the decision at hand: research for uncertainty about people or context; interaction design for behavior; information architecture for findability; visual design for hierarchy; content for comprehension; accessibility for equitable operation; evaluation for evidence.

Make experience requirements testable. State the task, conditions, success signal, recovery expectation, and evidence source. Use the confirmed input, output, and runtime constraints of the product; do not translate every problem into browser UI. A command-line tool, voice flow, device, game, API, and document can each have a human experience.

Reject attractive but unsupported redesigns, invented personas, isolated happy paths, visual polish that conceals ambiguity, and claims that a design is intuitive without observing use. Deliver a concise decision record, selected disciplines and rationale, journey/state coverage, and explicit uncertainty. Verify the consequential journey in the real runtime or a faithful prototype, then report both what worked and what was not tested.`,
  },
  'user-research': {
    title: 'User research practice',
    content: `Begin with a decision that research could change. Write the uncertainty, the affected groups, the consequence of being wrong, and the minimum evidence needed. Choose a method that fits the question: contextual observation for actual practice, interviews for language and rationale, diary methods for longitudinal work, surveys for bounded descriptive questions, artifact or support-log analysis for existing behavior, and prototype sessions for prospective choices. Do not use a survey to substitute for observing complex work.

Recruit for meaningful variation in role, experience, access needs, environment, geography, organization, incentives, and risk. Convenience participants and internal colleagues can be useful proxies only when labelled as such. Prepare neutral prompts, realistic tasks, consent and recording boundaries, and a plan for sensitive data. During sessions, ask people to show their normal work; do not teach the intended path, defend a design, treat pauses as agreement, or convert one vivid comment into a general rule.

Separate raw observations, participant interpretations, researcher inferences, and recommendations. Look deliberately for contradictions and disconfirming cases. Synthesize by behavior, need, context, barrier, and confidence—not demographic stereotype. Quote sparingly and accurately; never fabricate quotes, personas, prevalence, or consensus. Preserve unknowns and explain where evidence cannot generalize.

Turn findings into decisions with traceable links: finding, implication, proposed change, risk, and validation needed. A useful output includes method and sample boundaries, task evidence, themes with counterexamples, prioritized opportunities, and open questions. Validate consequential decisions with a second method or follow-up observation when feasible. Research is complete when it reduces the stated uncertainty enough to make a responsible decision, not when a slide deck looks persuasive.`,
  },
  'interaction-design': {
    title: 'Interaction design practice',
    content: `Design behavior before arranging controls. Define the user goal, entry conditions, permissions, relevant system state, available actions, constraints, consequences, and exit conditions. Model state transitions explicitly, especially where data changes, automation acts, cost is incurred, or a person can lose work. Confirm actual inputs and outputs first: pointer, touch, keyboard, controller, voice, command line, hardware control, assistive technology, asynchronous event, or API client each need different interaction contracts.

For every consequential flow, specify initial, empty, loading or processing, partial, unavailable, invalid, blocked, success, failure, cancellation, interruption, reconnection, restoration, and undo or correction states. Make feedback timely, proportional, understandable, and tied to the action that caused it. Prevent errors when practical; when prevention conflicts with expert speed, expose a safe escape hatch. Make destructive or irreversible actions legible before commitment and offer recovery that matches the real system capability—never promise undo that does not exist.

Use progressive disclosure to reduce unnecessary decisions without hiding vital state. Keep action labels tied to outcomes rather than implementation. Do not use a confirmation dialog as the default answer to unclear interaction design, nor rely on hover, color, timing, or a single gesture as the only path.

Verify with a real runtime or a faithful prototype using representative tasks and interruption cases. Inspect whether people can predict results, recognize state, correct mistakes, and resume work. Deliver a task/state model, input and feedback contract, recovery rules, and evidence from the tested flows. Call out unverified edge states instead of treating the happy path as completion.`,
  },
  'information-architecture': {
    title: 'Information architecture practice',
    content: `Treat information architecture as a model of a domain, not decoration for a navigation bar. Inventory real objects, content, actions, relationships, lifecycle states, terminology, permissions, audiences, and volumes. Observe the terms people use and the routes they take today. Separate a product’s internal storage model from the concepts people must find and understand; a database-normalized structure is not automatically a usable one.

Organize around meaningful tasks and domain relationships. Use a hierarchy only where one primary home is truthful; use facets, cross-links, search, saved views, contextual actions, or alternate entry points when people approach the same thing differently. Define labels that are specific, stable, and distinguishable. Avoid organization by team ownership, implementation detail, clever metaphors, and ambiguous buckets such as “Other” when a clearer concept exists.

Specify navigation, orientation, local context, search behavior, filtering, sorting, empty results, permissions, deep links, history, migration, growth, localization, and offline or degraded constraints as applicable to the medium. A terminal command hierarchy, API resource model, settings surface, documentation set, and physical control panel can all require architecture. Do not assume global navigation or search is available or appropriate.

Test findability with representative tasks and realistic wording: where would someone start, what label would they choose, how would they recover from a wrong route, and can they recognize the destination? Measure observable success and confusion rather than voting on a sitemap. Deliver a concept inventory, relationship model, organization rationale, labels and alternate paths, plus findability results and known growth risks.`,
  },
  'visual-interface-design': {
    title: 'Visual interface design practice',
    content: `First confirm that a visual interface is part of the task and learn its viewing conditions: device or surface, scale, distance, lighting, density, platform conventions, content variability, identity constraints, access needs, and motion capability. Inspect the existing design language and reusable tokens before inventing new ones. A visual direction should clarify purpose, priority, relationship, state, and trust; it is not an excuse to apply a fashionable style.

Build a hierarchy from content and task importance. Establish type roles, spacing rhythm, alignment, grouping, contrast, color meaning, imagery policy, elevation or boundaries, and responsive or resizable behavior appropriate to the medium. Use a small, coherent set of visual signals repeatedly. Reserve emphasis for meaningful differences: current state, risk, primary action, status, and error. Test representative complete states, not a pristine empty mockup: long and localized text, sparse and dense data, selected and disabled controls, errors, progress, empty results, and degraded conditions.

Use color, shape, text, placement, and semantics together so that no single visual cue carries essential meaning. Respect contrast, text scaling, reduced motion, and platform requirements. Motion should explain state or preserve orientation; avoid animation that delays action or merely decorates. Do not manufacture dashboards, people, activity, or metrics to make a design look alive.

Reject generic card grids, ornamental gradients, glass effects, arbitrary shadows, excessive rounded containers, and copied “premium” patterns unless evidence shows they serve this product. Verify rendered output at relevant sizes and environments. Deliver the visual rationale, component/token changes, representative state matrix, and unresolved compromises rather than claiming polish from screenshots alone.`,
  },
  'content-error-design': {
    title: 'Content and error design practice',
    content: `Write for a decision and an action. Identify who is reading, what they are trying to do, what they already know, what happened, urgency, risk, vocabulary, and the next useful step. Use the terminology people encounter in the domain, not internal object names or vague product slogans. Keep labels concrete and outcomes visible; a person should not need to activate a control to learn its consequence.

Design language as a complete state system: orientation, instructions, unavailable capability, empty result, in-progress work, partial completion, warning, confirmation, permission request, offline or degraded operation, failure, recovery, and success. For an error, explain what failed in plain terms, the impact, what can be done now, and any identifier or diagnostic detail needed for support—without exposing secrets, private data, or unsafe implementation detail. Pair a useful action with the message when a real action exists; do not use “try again” as a substitute for diagnosis.

Avoid blame, false reassurance, cute language during distress, unexplained codes, passive ambiguity, all-caps urgency, and instructions that merely repeat nearby labels. Do not hide a serious error behind a toast that disappears before it can be read. Preserve accurate uncertainty: “may not have saved” is better than claiming a save failed or succeeded without evidence.

Review content in the real context, including constrained surfaces, localization expansion, assistive output, and interrupted work. Test comprehension with representative readers or a justified proxy; grammar approval alone is not validation. Deliver a state/content inventory, terminology decisions, recovery copy, diagnostic privacy review, and evidence of whether people understood the required action.`,
  },
  'accessibility-practice': {
    title: 'Accessibility practice',
    content: `Start with the actual product surface and its applicable obligations, standards, and user environments. Accessibility is not a browser-only checklist: inspect the semantics, alternatives, interaction model, hardware, operating system services, documentation, command interface, device constraints, and support workflow that people really use. Identify perceptual, motor, cognitive, speech, language, environmental, and temporary-access constraints relevant to the task, without assuming a single “average” user.

Make each critical task perceivable, understandable, operable, and robust through more than one channel where needed. Do not require color, position, sound, fine motor precision, memorization, strict timing, motion, or one input method as the only way to succeed. Preserve programmatic meaning and state when the medium supports assistive technologies. Ensure focus or equivalent orientation, input feedback, errors, time limits, media alternatives, zoom or scale, and motion behavior match the platform rather than imposing web mechanics on every system.

Use automated checks to catch repeatable defects, but treat a clean scanner as a narrow signal. Manually exercise representative workflows with alternative input and relevant assistive technology or platform services. Include realistic content, validation errors, dynamic updates, dense states, and recovery—not just a static home screen. When specialist testing is unavailable, state the limit and avoid claiming conformance.

Prioritize barriers by task criticality, frequency, harm, and availability of workaround. Fix root semantics and interaction contracts before cosmetic patches. Deliver the applicable standard and scope, test matrix, issues with reproduction and impact, remediations, retest evidence, and untested combinations. Never claim universal accessibility or compliance beyond the evidence.`,
  },
  'usability-evaluation': {
    title: 'Usability evaluation practice',
    content: `Define the decision before choosing an evaluation method. State the representative audience or justified proxy, realistic tasks, environment, success criteria, measures, and what result would change the plan. Use moderated task sessions when behavior and reasoning matter, a cognitive walkthrough when knowledgeable inspection is appropriate, heuristic review for structured expert critique, telemetry or support evidence for deployed behavior, and comparative studies only when the alternatives and measures are genuinely comparable.

Write tasks in the participant’s goal language, with enough context to be realistic but without disclosing the intended path. Observe completion, time or effort where meaningful, errors, recovery, assistance, comprehension, confidence, and trust. Do not coach someone through the design, turn every hesitation into a defect, or treat a convenience sample as population statistics. Record the conditions under which findings apply; a noisy field setting, assistive technology, novice user, and expert administrator can reveal different failures.

Synthesize evidence into distinct findings with task, observation, likely cause, scope, confidence, severity, and suggested next validation. Prioritize by harm, irreversibility, frequency, task criticality, and availability of workaround—not by which criticism sounds strongest. Preserve contradictory observations and separate observed problems from hypotheses about causes.

Retest consequential changes using the same task conditions where possible. A useful report names participants or proxy limits, method, tasks, raw outcome summary, severity rationale, changes made, and retest result. Avoid declaring an interface “usable,” “intuitive,” or statistically representative when the evidence only supports a narrower conclusion.`,
  },
  'developer-experience': {
    title: 'Developer experience practice',
    content: `Treat developer experience as the complete journey of a person integrating, operating, debugging, changing, upgrading, and removing a technical product. Identify their roles, existing knowledge, runtime constraints, security boundaries, language or protocol conventions, and failure costs. Inspect the actual interface—API, SDK, command, configuration, language feature, build tool, documentation, examples, logs, and migration path—before optimizing a local snippet.

Design around coherent domain concepts and composable primitives. Make states, ownership, lifecycle, side effects, concurrency, limits, and failure behavior explicit. Defaults should be evidence-backed, safe for the common case, inspectable, and reversible where possible; an escape hatch should be deliberate, documented, and not silently undermine safety. Prefer predictable naming and behavior over clever brevity. Keep configuration discoverable and validate it near the source of the mistake.

Design diagnostics as part of the interface: identify the failed operation, relevant location or resource, likely cause when justified, safe corrective action, and diagnostic context without leaking secrets. Supply runnable, maintained examples that show setup, ordinary use, failure handling, teardown, and version assumptions. Avoid examples that hide essential permissions, dependencies, cleanup, or production constraints.

Evaluate first use, repeat use, debugging, upgrade, rollback, and removal with representative developers or a faithful clean-environment exercise. Measure whether someone can form a correct mental model, complete a realistic task, find an answer, and recover from a mistake. Deliver a journey map, interface contract, examples and diagnostics review, compatibility and migration plan, plus evidence and known friction. Do not equate fewer lines or a fast demo with ergonomic design.`,
  },
};
