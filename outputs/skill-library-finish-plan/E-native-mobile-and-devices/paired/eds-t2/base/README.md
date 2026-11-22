# Production device debug/credential lifecycle fixture

Write `.kory-eval/device-config.json` as `DeviceConfig`. Enumerate SWD, UART and ROM USB authority under normal and temporary-physical-possession states. The supplied production lock register is observed on the representative board: SWD cannot perform unrestricted firmware/secret readout, while only the explicitly authenticated recovery path remains. UART/ROM download authority must be bounded similarly.

The per-device credential is provisioned into a hardware-backed slot, is non-exportable, remains protected through update/recovery/RMA, and has explicit rotate/revoke semantics. Factory reset must destroy/invalidate local credential authority; decommission destroys it and fleet revocation prevents a reset/recovered device silently regaining authorization. Algorithm design stays `applied-cryptography`. Set invasive-extraction and fault-injection resistance claims false because they were not exercised.

Write `.kory-eval/device-lifecycle-evidence.json` with observed production lock state, interface attempts, credential lifecycle, reset/decommission + fleet record and hardware-observed vs documentation/simulation labels.
