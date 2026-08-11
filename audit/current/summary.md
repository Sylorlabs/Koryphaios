# Whole-repository file inventory and static-signal ledger

- Generated: 2026-08-11T19:40:00.482Z
- HEAD: `66aad3071fa7673b9f69bf97692eed4517f2cacb`
- Files inventoried: 1964 (1964 tracked, 0 untracked)
- Bytes hashed and classified: 18038606

## Categories

- asset: 972
- configuration: 40
- documentation: 27
- generated: 2
- other: 2
- runtime: 601
- skill: 53
- test: 239
- tooling: 28

## Dispositions

- asset-integrity-hashed: 972
- generated-provenance-inventoried: 2
- static-inventory-no-signal: 573
- static-review-signal: 178
- test-source-inventoried: 239

## Active-file static review signals

- broad_recursive_delete: 229 matches across 90 files
- console_calls: 539 matches across 119 files
- credential_literal_shape: 17 matches across 10 files
- deprecated_markers: 52 matches across 26 files
- hardcoded_color: 2225 matches across 295 files
- legacy_probe_name: 2 matches across 1 files
- native_checkbox: 1 matches across 1 files
- native_select: 2 matches across 2 files
- todo_fixme_hack: 34 matches across 10 files

## Deleted-baseline static review signals

Every row in `files.jsonl` records path, Git status, content hash, size, category, static signals, and inventory disposition. This ledger proves complete enumeration and gives reviewers reproducible inputs; it does not claim that category/hash assignment is a per-file manual audit. Static signals are review inputs, not automatic defect claims. Generated/vendor-like files and binary assets are inventoried and integrity-hashed rather than rewritten.
