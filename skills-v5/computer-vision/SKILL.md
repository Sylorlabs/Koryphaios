---
name: computer-vision
description: Engineer visual perception with explicit geometry, labels, transforms, and evaluation. Use when classification, detection, segmentation, tracking, or visual recognition behavior changes; use embedding-systems for representations and image-generation-practice for image synthesis.
---

# Computer Vision

Treat pixels, labels, geometry, preprocessing, model output and deployment camera conditions as one observable contract. A strong aggregate score is insufficient if train/test leakage, invalid spatial transforms or field conditions make it non-predictive.

## Workflow

1. **Define the visual decision and error cost.** Identify the unit of inference (frame, crop, clip, object, pixel, keypoint or track), label ontology, positive/negative policy and downstream action. Distinguish classification, detection, instance/semantic segmentation, keypoints, OCR/perception and tracking before choosing metrics.
2. **Pin image formation and geometry.** Record camera/device, resolution, color/channel order, orientation/EXIF handling, lens/calibration assumptions, crop/resize/letterbox policy and coordinate convention. For multi-camera or metric-geometry tasks, preserve intrinsics/extrinsics and distortion corrections as versioned inputs.
3. **Audit labels and provenance.** Preserve image/video source, capture/session/device identity, annotation revision, annotator or generation provenance and uncertain/ignored regions. Validate boxes, masks, keypoints and class IDs against image bounds and ontology before training or evaluation.
4. **Split by dependency, not filename.** Keep near-duplicate frames, bursts, crops, scenes, subjects, cameras and derived augmentations from leaking across train/validation/final sets. Time- or device-based deployment shifts may require grouped or forward splits instead of random image splits.
5. **Make spatial transforms label-aware.** Apply resize, crop, flip, affine/perspective and other geometric augmentations jointly to images and spatial targets. Reject transforms that invalidate the label semantics. Preserve interpolation, padding, antialiasing and box/mask/keypoint coordinate conventions.
6. **Pin model and preprocessing together.** Record architecture/weights revision, input normalization, resize/crop policy, class mapping and postprocessing such as score thresholds, NMS, mask thresholds or tracker association settings. A weights file without its preprocessing/postprocessing identity is incomplete.
7. **Use task-correct metrics.** Classification may need confusion, precision/recall, calibration and operating thresholds; detection requires IoU-aware AP/AR and size/class slices; segmentation needs per-class IoU/Dice or boundary evidence; tracking needs identity/association and temporal failure evidence. Do not compare unlike metrics as interchangeable accuracy.
8. **Evaluate the deployment distribution.** Slice by lighting, blur, scale, occlusion, background, weather/environment, device/camera, resolution, object size, class frequency and other known operating factors. Include empty scenes, crowded scenes, tiny objects, clipped targets and corrupt/unsupported media where relevant.
9. **Calibrate confidence and abstention.** Select score/decision thresholds on development data and verify them on untouched cases. When false positives and false negatives have different costs, report the chosen operating point rather than only maximum aggregate accuracy.
10. **Verify target-runtime behavior.** Measure preprocessing + inference + postprocessing latency, memory and throughput on the intended hardware/runtime. Check numerical/quantization/export differences on representative fixtures before treating a desktop result as evidence for edge/mobile deployment.
11. **Inspect failures visually and structurally.** Persist overlays or machine-readable examples linking predictions to source IDs, ground truth and slice labels. Separate annotation defects, geometry bugs, preprocessing mismatch and genuine model errors before changing the model.
12. **Promote with reproducible evidence.** Record data/split hashes, model/preprocess/postprocess identity, metrics by slice, target-runtime measurements and rollback artifacts. Preserve failed cases as regressions.

## Boundaries

- `ml-evaluation` owns generic statistical evaluation methodology and uncertainty. This skill owns vision-specific labels, geometry, metrics, slices and visual failure semantics.
- `fine-tuning-training` owns changing model or adapter weights. This skill defines the vision data/preprocess/evaluation contract that such training must satisfy.
- `embedding-systems` owns shared vector-space identity, dimensions and similarity semantics, including multimodal embeddings. This skill owns image/video decoding, transforms, spatial labels and perception behavior.
- `mlops` owns generic model registry, deployment automation and monitoring infrastructure. This skill owns vision-specific runtime preprocessing/postprocessing parity and camera/deployment-condition evidence.
- `image-generation-practice` owns synthesizing or editing images. This skill evaluates perception models; synthetic imagery is only data when its provenance and domain gap are explicitly controlled.
- General UI image rendering, CSS/layout, file conversion or metadata-only edits do not activate this skill unless visual-model behavior is being changed or evaluated.

Use [the maintained source map](references/sources.md) before encoding version-sensitive framework, transform, metric or provider behavior.
