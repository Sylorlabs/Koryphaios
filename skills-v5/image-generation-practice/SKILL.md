---
name: image-generation-practice
description: Design image-generation workflows around composition, subject fidelity, style, constraints, iteration, provenance, and deliverable quality. Use when the request specifically requires image generation, generate an image, text to image, edit generated image.
---

# Image Generation Practice

## Responsibility

Translate the intended use into subject, composition, camera/view, lighting, palette, material, typography constraints, aspect ratio, negative constraints, and required fidelity. Iterate on the visual discrepancy with the highest impact rather than stacking contradictory adjectives. Preserve source/consent boundaries for edits involving supplied assets.

Verification focus: Inspect output at delivery resolution for anatomy/geometry, text accuracy, edge artifacts, repeated patterns, perspective, brand/style consistency, and task specific fidelity; compare variants against the intended use rather than prompt literalism.

Failure boundaries: Do not claim exact likeness or trademark/style fidelity without evidence, hide obvious generation artifacts under effects, or keep expanding prompts when the composition itself is wrong.

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
