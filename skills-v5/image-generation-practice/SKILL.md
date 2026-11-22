---
name: image-generation-practice
description: Design image-generation workflows around composition, subject fidelity, style, constraints, iteration, provenance, and deliverable quality. Use when the request specifically requires image generation, generate an image, text to image, edit generated image.
---

# Image Generation Practice

## Responsibility

Translate the intended use into subject, composition, camera/view, lighting, palette, material, typography constraints, aspect ratio, negative constraints, and required fidelity. Iterate on the visual discrepancy with the highest impact rather than stacking contradictory adjectives. Preserve source/consent boundaries for edits involving supplied assets.

Verification focus: Inspect output at delivery resolution for anatomy/geometry, text accuracy, edge artifacts, repeated patterns, perspective, brand/style consistency, and task specific fidelity; compare variants against the intended use rather than prompt literalism.

Failure boundaries: Do not claim exact likeness or trademark/style fidelity without evidence, hide obvious generation artifacts under effects, or keep expanding prompts when the composition itself is wrong.

A generation request is only as reproducible as the spec behind it. Name the model, the canvas, and a seed per variant, and keep the prompt a statement of what must be true of the frame: background colour, how much of the frame the subject occupies, where it sits, which colours are allowed, which are forbidden, and what must not appear. Colour and layout instructions are followed unevenly across models, so treat palette discipline as a property you ask for explicitly and then measure on the render rather than assume from the words. Prefer few-colour flat vector language when the deliverable has to sit on a known background: photographic language buys texture you did not ask for and a palette nobody can bound. Choose the model against the constraint the deliverable actually has, not against the model list: with one prompt, seed and canvas held constant, a flat-vector instruction returned a five-colour frame on one checkpoint and an eight-hundred-colour frame with 79 percent of its edge covered on a latency-tuned one. When several assets must look like one family, repeat the identity descriptor verbatim in every prompt instead of paraphrasing it, and give each asset its own composition instruction rather than reusing one prompt at different crops. Placement is the instruction that gets averaged away most often: a clause like "low in the frame" inside a long prompt usually returns a centred subject, so when an asset must sit somewhere specific, make the anchor the first thing the prompt states and describe what the rest of the canvas is doing ("bottom-anchored composition: the mark in the lower part of the canvas, the upper two thirds empty background"). Measured on one flat-vector model, that rewording moved the subject centroid from about 0.4 to 0.75 to 0.8 of the frame height across seeds, while the modifier-only phrasing stayed near the centre. Spend the variant budget where the risk is: two seeds per target is enough to recover from an unlucky sample, and regenerating the same prompt ten times is not iteration.

## Execution, provenance, and evidence boundary

Treat a returned image file as the deliverable evidence. A prompt, provider acknowledgement, text description, API response, thumbnail, or placeholder is not an image generation result. If the required generator/edit runtime, source asset, or returned file is unavailable, stop at the plan, state the exact blocker, and mark visual verification unavailable; do not convert a proposed image into a completed artifact.

For each retained candidate and final delivery, keep an asset receipt with the provider/runtime and model identifier, request time, source-asset identifiers and hashes for edits, permission or consent boundary, relevant parameters and seed when exposed, output path and SHA-256, dimensions, format/color mode, and transformations after generation. Record which facts came from the provider response versus the actual file. Preserve the original supplied asset and compare the final file against it when continuity, likeness, layout, or brand elements matter.

Separate file checks from visual checks. A decoder or metadata probe can establish that bytes are readable and dimensions/format are as expected, but it cannot establish composition, legible text, fidelity, or artifact absence. Record inspection at the delivery resolution and crop checks on the actual final file; if those checks could not occur, report them as unavailable rather than inferred. A negative or recovery claim requires actual candidate files and independently recorded comparisons, not renamed files or prompt revisions alone.

## Hierarchy and routing

- Broader skills: visual-interface-design.
- No narrower bundled child is declared.

## Iterate against the deliverable

Translate the brief into a hierarchy of visual requirements: subject identity and action, composition and viewpoint, required content, dimensions, edit boundaries, and delivery use. Separate constraints that must remain exact from preferences that can vary. Use supplied reference material only within its intended scope and permissions.

Choose generation or editing based on what must be retained. Preserve the source asset and compare the actual output with it when continuity, likeness, layout, or brand elements matter. Model support for fidelity controls does not guarantee exact text, recurring characters, or precise placement.

Change the most consequential discrepancy first. A composition problem usually needs a change in framing or structure rather than more style adjectives. Keep useful variants and record what changed so the next iteration is deliberate. Do not hide geometry or text defects with effects or claim a missing preview was inspected.

Inspect the final file at its intended size and crop. Check visible text, edges, transparency, perspective, repeated elements, anatomy where present, and integration into the actual destination. Verify dimensions and format separately from visual quality. Provider limits and parameters belong in current references, not permanent instructions that force every task onto one model or API.

Use [the maintained source map](references/sources.md) for facts that are sensitive to the version in use and source conflicts.
