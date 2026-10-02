# Source map

`computer-vision` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Vision behavior depends on framework/runtime version, camera geometry, preprocessing and task metric conventions. Refresh the selected framework or provider documentation when those details change, and preserve exact model/preprocess/postprocess identity in evaluation artifacts.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **TorchVision object detection finetuning tutorial**: https://docs.pytorch.org/tutorials/intermediate/torchvision_tutorial.html
  - Scope: current PyTorch/TorchVision object-detection and instance-segmentation tutorial as available 2026-09-05.
  - Use: custom dataset target structure, boxes/masks, transfer-learning workflow and detection evaluation integration.
  - Verified: 2026-09-05; refresh after 30 days.
- **TorchVision transforms v2 end-to-end detection/segmentation example**: https://docs.pytorch.org/vision/stable/auto_examples/transforms/plot_transforms_e2e.html
  - Scope: TorchVision 0.28 stable documentation as available 2026-09-05.
  - Use: joint spatial transformations of images, bounding boxes and masks; prevents image-only augmentation that leaves targets geometrically invalid.
  - Verified: 2026-09-05; refresh after 30 days.
- **OpenCV 4.13 geometric image transformations**: https://docs.opencv.org/4.13.0/da/d54/group__imgproc__transform.html
  - Scope: OpenCV 4.13 image-processing transform reference.
  - Use: resize, affine/perspective mapping, interpolation and pixel-coordinate transformation behavior.
  - Verified: 2026-09-05; refresh after 90 days.
- **OpenCV 4.13 camera calibration**: https://docs.opencv.org/4.13.0/d4/d94/tutorial_camera_calibration.html
  - Scope: OpenCV 4.13 camera-calibration tutorial.
  - Use: lens distortion, intrinsics/extrinsics and pixel-to-world geometry assumptions for camera-dependent perception systems.
  - Verified: 2026-09-05; refresh after 90 days.
- **COCO detection evaluation**: https://cocodataset.org/#detection-eval
  - Scope: COCO object-detection evaluation reference.
  - Use: IoU-aware AP/AR conventions and size-aware detection evaluation. Treat COCO conventions as a metric family, not a universal product threshold.
  - Verified: 2026-09-05; refresh after 365 days.
- **NIST AI Risk Management Framework**: https://www.nist.gov/itl/ai-risk-management-framework
  - Scope: NIST AI RMF materials as available 2026-09-05.
  - Use: lifecycle risk measurement, representative testing, transparency and deployment-condition governance for material vision systems.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Pin the camera/image-formation and model preprocessing/postprocessing contract before comparing outputs. Resolution, orientation, channel order, crop/letterbox, normalization, calibration and thresholds can materially change predictions without a weight change.
- Split by dependency. Nearby video frames, burst captures, crops from one source image, repeated scenes, subjects, devices and derived augmentations can invalidate a random image-level holdout.
- Transform spatial targets with the image. Bounding boxes, masks and keypoints must follow geometric resize/crop/flip/affine/perspective operations under explicit coordinate/interpolation rules.
- Match metrics to the task. Detection AP/AR, segmentation IoU/Dice, classification confusion/calibration and tracking association metrics answer different questions; do not flatten them into generic accuracy.
- Choose operating thresholds on development data and verify unchanged on an untouched set. Report false-positive/false-negative tradeoffs and required deployment slices, not only a best aggregate metric.
- Evaluate the field distribution: camera/device, lighting, blur, scale, object size, occlusion, background, material/weather and other known conditions. A critical slice can block promotion despite aggregate improvement.
- Verify export/runtime parity on the target hardware. Include preprocessing and postprocessing in latency/memory/throughput evidence and test numerical/quantization/export changes on representative fixtures.
- Preserve source-linked failure examples and annotation provenance so geometry bugs, annotation defects, preprocessing mismatch and genuine model failures remain distinguishable and regressible.
