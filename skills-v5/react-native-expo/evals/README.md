# React Native/Expo evaluation readiness

Both declared device scenarios currently resolve to external-environment gates,
not executable Expo applications. The materializer emits `BLOCKED.md` and the
gate scorer returns `passed: false`, quality `0`, and verification `0`. Installing
device tools alone cannot replace the missing app fixtures and native interaction
evaluator.

## Focused diagnostics

From the repository root:

```sh
bun run backend/src/kory/skill-eval-react-native-expo-readiness.ts
bun test backend/src/kory/__tests__/skill-eval-react-native-expo-readiness.test.ts
```

The diagnostic explicitly invokes bounded `xcrun simctl` and `adb devices -l`
probes using the current PATH and developer-tools environment. It does not boot
targets, install an app, or execute scenario interactions. `adb` may start its
normal host daemon. Its exit status means the diagnostic ran, not that either
scenario is ready. It is a standalone diagnostic, not a replacement for the
registered fail-closed gate. Unit tests inject command responses and establish
diagnostic behavior only.

Preserve command failures separately from successful empty enumerations. A
missing `simctl` in the selected developer tools does not prove Xcode is absent
from the machine. A missing `adb` on PATH does not prove no Android SDK is
installed. A connected Android target does not prove boot completion or app
readiness; an available booted iOS simulator does not prove an Expo build is
installed or compatible. These probes do not enumerate physical iOS devices.

## Evidence still needed

| Scenario                  | Missing executable environment and observations                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appstate-upload-resume`  | Expo app with picker, navigation, upload adapter, persisted resume metadata, delayed/offline responses and upload-ID instrumentation; native background/foreground, navigation-away, picker denial/cancel and retry observations showing one logical upload. |
| `safe-area-keyboard-form` | Expo checkout app with native inputs and validation; small iOS/Android screens, actual keyboard show/hide/next/submit, rotation and large-font interactions, focus/error context and payment failure recovery observations.                                  |

For each platform, record the Expo SDK and native build identity, target/OS,
executed sequence, logs and relevant native captures. Cross-platform claims
require both platforms. Paired same-model skill/no-skill runs must start from the
same snapshot and retain their actual artifacts. Static package quality, tool
enumeration, and mocked JS state transitions do not supply AppState, safe-area,
keyboard, lifecycle, or rendered-interaction results.
