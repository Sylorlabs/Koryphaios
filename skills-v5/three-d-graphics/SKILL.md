---
name: three-d-graphics
description: Engineer real-time and rendered 3D graphics around geometry, transforms, materials, lighting, cameras, animation, performance, and asset pipelines. Use when the request specifically requires 3d graphics, three.js scene, webgl, rendering pipeline 3d.
---

# Three D Graphics

## Responsibility

Establish coordinate systems, units, handedness, transform hierarchy, camera model, mesh topology, materials/color space, lights, shadows, texture budgets, animation ownership, and target GPU/runtime. Keep asset import/export conventions and deterministic transforms explicit.

Verification focus: Inspect representative scenes for geometry/normals, scale, camera clipping, color/gamma, material response, animation interpolation, z-fighting, GPU/CPU frame cost, memory, and fallback behavior on supported hardware.

Failure boundaries: Do not fix coordinate mistakes with scattered magic rotations, mix color spaces, ship unbounded texture/poly budgets, or infer mobile/VR performance from a desktop editor.

## Hierarchy and routing

- Broader skills: game-spatial-interface.
- No narrower bundled child is declared.
- Required skills: visual-verification, performance-verification.

## Preserve transforms and appearance

Trace an asset from authoring coordinates through import, hierarchy, animation, camera, shading, and output. State where scale, handedness, and orientation conversions occur. Verify representative points, normals, and parent transforms rather than fixing individual objects with unexplained offsets.

Distinguish color textures from numerical data textures. Confirm the working space, input transfer functions, tone mapping, and display or export transformation. A roughness or normal map is not a color image to decode with the same transfer function. Avoid repeated output conversion when postprocessing or export already owns it.

Choose geometry, textures, lighting, shadows, and effects within the target frame and memory budgets. Measure representative content and views, including loading, disposal, scene transitions, and sustained use. A desktop preview cannot establish mobile or immersive performance, and average frame time can conceal visible stalls.

Compare the final rendered scene with the intended composition and material response. Check clipping, depth precision, animation continuity, orientation, and resource lifecycle. Keep artistic direction separate from correctness of the transform and color pipeline. An engine's API names are conditional implementation detail, not a required architecture for every renderer.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
