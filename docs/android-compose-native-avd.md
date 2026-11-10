# Android Compose native fixture: dedicated macOS arm64 emulator

This procedure runs the existing Android Compose red/green instrumented tests on
an isolated, named Google Play emulator. It does not run a V5 campaign or write an
evaluation ledger. The emulator uses its own AVD directory and a fixed, checked
ADB serial. Never point these commands at a personal device or another AVD.

## Verified host state (October 10, 2026)

- Android SDK: `/Users/Shared/micah/Library/Android/sdk`; API 37.0,
  build-tools 36.0.0, adb 37.0.1, emulator 37.1.11 installed.
- Java: Android Studio's JDK 25; Gradle: 9.6.0.
- Apple arm64 host with emulator hardware acceleration available and ~124 GiB
  free on the data volume. No connected Android device, installed system image,
  or AVD was found.
- The SDK catalog advertises
  `system-images;android-37.0;google_apis_playstore;arm64-v8a` (revision 6).
- A noninteractive installation attempt **did not install** the package:
  `sdkmanager` requested the new `android-sdk-arm-dbt-license`; the existing
  `android-sdk-license` does not cover it. No new license was accepted. Note that
  `sdkmanager` returned exit status 0 even while reporting `Skipping following
  packages as the license is not accepted`, so always verify the installed image.
- Both `androidComposeNativeReadiness` scenarios report exactly:
  `Exactly one booted Android device is required (or set KORY_SKILL_EVAL_ANDROID_SERIAL): none`.
- The edit scenario app and AndroidJUnitRunner APKs compile successfully with
  the pinned Gradle/JDK/SDK. **No native runtime red/green evidence exists yet.**

## Install (requires a human decision on the new license)

Use the machine's already installed tools. Do **not** run `yes | sdkmanager`,
auto-answer license prompts, or copy a guessed license hash into the SDK.

```sh
export KORY_ANDROID_SDK="$HOME/Library/Android/sdk"
export KORY_ANDROID_JAVA='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
export KORY_ANDROID_GRADLE="$HOME/.gradle/wrapper/dists/gradle-9.6.0-bin/42k10rwplmzkhuboz9kdazi7s/gradle-9.6.0/bin/gradle"
export JAVA_HOME="$KORY_ANDROID_JAVA"
export ANDROID_HOME="$KORY_ANDROID_SDK"
export ANDROID_SDK_ROOT="$KORY_ANDROID_SDK"

# Review and accept the new license interactively only if you agree to it.
"$KORY_ANDROID_SDK/cmdline-tools/20.0/bin/sdkmanager" \
  --sdk_root="$KORY_ANDROID_SDK" --install \
  'system-images;android-37.0;google_apis_playstore;arm64-v8a'

# This must succeed before continuing (the installer exit code alone is insufficient).
test -f "$KORY_ANDROID_SDK/system-images/android-37.0/google_apis_playstore/arm64-v8a/source.properties"
```

The Play Store image is a candidate for accessibility testing, **not proof that
TalkBack or Switch Access is installed, enabled, or usable**. Check the actual
TalkBack package after boot. If absent, stop and install Android Accessibility
Suite through the emulator's Play Store with the account owner's consent. Do not
sideload an unverified APK. Even an enabled TalkBack service plus visible native
nodes does not establish spoken announcements or manual traversal; this harness
does not claim either, and it does not exercise Switch Access.

## Create and boot only the dedicated AVD

Keep the AVD definitions away from `~/.android/avd`. The AVD creation step is
repeatable: it will reuse its named configuration, and it never uses `--force`.

```sh
export ANDROID_AVD_HOME="$HOME/.android/kory-compose-native-avds"
export KORY_ANDROID_AVD='KoryComposeNativeApi37'
export KORY_ANDROID_SERIAL='emulator-5580'
export KORY_ANDROID_ADB="$KORY_ANDROID_SDK/platform-tools/adb"
mkdir -p "$ANDROID_AVD_HOME"

if [ ! -f "$ANDROID_AVD_HOME/$KORY_ANDROID_AVD.ini" ]; then
  test ! -e "$ANDROID_AVD_HOME/$KORY_ANDROID_AVD.avd" || exit 1
  "$KORY_ANDROID_SDK/cmdline-tools/20.0/bin/avdmanager" create avd \
    --name "$KORY_ANDROID_AVD" \
    --package 'system-images;android-37.0;google_apis_playstore;arm64-v8a' \
    --device pixel_8 \
    --path "$ANDROID_AVD_HOME/$KORY_ANDROID_AVD.avd" </dev/null
fi

# Refuse to take over ports used by another emulator or process.
if lsof -nP -iTCP:5580 -sTCP:LISTEN | rg -q . || \
   lsof -nP -iTCP:5581 -sTCP:LISTEN | rg -q .; then
  echo 'Emulator port 5580/5581 is already occupied; stop here.' >&2
  exit 1
fi

"$KORY_ANDROID_SDK/emulator/emulator" -avd "$KORY_ANDROID_AVD" \
  -port 5580 -no-window -no-snapshot -no-boot-anim -no-audio -gpu software \
  > /tmp/kory-compose-native-emulator.log 2>&1 &

"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" wait-for-device
for _ in {1..90}; do
  [ "$("$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break
  sleep 2
done
test "$("$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = 1

# Check emulator identity before changing any device settings or installing APKs.
actual_avd=$("$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" emu avd name | tr -d '\r')
test "$actual_avd" = "$(printf '%s\nOK' "$KORY_ANDROID_AVD")" || exit 1
```

The Play Store and Android Accessibility Suite contents have not been verified
on this host. Inspect the package and its real service component before enabling
TalkBack on this **dedicated emulator only**:

```sh
"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell pm list packages com.google.android.marvin.talkback
"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell dumpsys package com.google.android.marvin.talkback | rg 'TalkBackService'
```

Enable TalkBack from Android **Settings > Accessibility > TalkBack**, or set
`enabled_accessibility_services` to the actual service component verified above,
and `accessibility_enabled` to `1`, on `emulator-5580` only. Verify the result:

```sh
"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell settings get secure enabled_accessibility_services
"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell settings get secure accessibility_enabled
"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" shell dumpsys accessibility | rg -i 'TalkBack|Enabled services'
```

## Verify readiness and run local native red/green tests

```sh
cd /Users/Shared/micah/Documents/koryphaios
export KORY_SKILL_EVAL_ANDROID_SDK_ROOT="$KORY_ANDROID_SDK"
export KORY_SKILL_EVAL_ANDROID_JAVA_HOME="$KORY_ANDROID_JAVA"
export KORY_SKILL_EVAL_ANDROID_GRADLE="$KORY_ANDROID_GRADLE"
export KORY_SKILL_EVAL_ANDROID_SERIAL="$KORY_ANDROID_SERIAL"
export KORY_SKILL_EVAL_ANDROID_AVD_NAME="$KORY_ANDROID_AVD"

bun -e 'import { androidComposeNativeReadiness, ANDROID_COMPOSE_NATIVE_SCENARIOS as s } from "./backend/src/kory/skill-eval-android-compose-native-runtime.ts"; console.log({ edit: androidComposeNativeReadiness(s.edit), feed: androidComposeNativeReadiness(s.feed) });'

# Proceed only when BOTH blocker lists are empty. These are independent native
# red/green controls with actual Gradle builds and AndroidJUnitRunner, not a campaign.
KORY_SKILL_EVAL_ANDROID_NATIVE_TESTS=1 bun test \
  backend/src/kory/__tests__/skill-eval-android-compose-native-runtime.test.ts
```

Both native tests must be reported as **passed**, not **skipped**. A passing
Gradle build or a green deterministic unit test cannot stand in for device
proof. Runtime output still notes that TalkBack speech and manual traversal
were not independently observed.

To stop the dedicated emulator, verify its `emu avd name` identity again, then
run `"$KORY_ANDROID_ADB" -s "$KORY_ANDROID_SERIAL" emu kill`. The AVD files
remain isolated under `$ANDROID_AVD_HOME` for a later repeatable run.
