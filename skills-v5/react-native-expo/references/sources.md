# Source map

Source curation for `react-native-expo`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Expo development builds introduction**: https://docs.expo.dev/develop/development-builds/introduction/?buildenv=build-with-eas
  - Adopted: a development build is the application's own native runtime and is the correct boundary for custom native libraries and configuration.
  - Conditional: Expo Go remains useful for JavaScript-only work that stays within its fixed native library set.
  - Limit: success in a development build does not by itself establish production signing, store configuration, or release behavior.
- **Expo development-build FAQ**: https://docs.expo.dev/develop/development-builds/faq/
  - Adopted: Expo Go is not a production-grade proof boundary for custom native modules, and adding native libraries can require a new native build.
  - Conditional: a rebuild is needed when native code or configuration changes, not for every JavaScript edit.
  - Limit: the FAQ does not determine whether a particular third-party library is correct or supported on every platform.
- **Using development builds**: https://docs.expo.dev/develop/development-builds/use-development-builds/
  - Adopted: rebuild the development client when native dependencies change so JavaScript and native capability stay aligned.
  - Conditional: reuse the existing client when the installed native runtime already contains the required capability.
  - Limit: rebuild success does not establish OTA compatibility.
- **EAS Update runtime versions**: https://docs.expo.dev/eas-update/runtime-versions/
  - Adopted: use `runtimeVersion` as the compatibility boundary between an update and the installed native runtime; native changes require a compatible build lineage.
  - Conditional: the project's chosen runtime-version policy controls how compatibility is encoded.
  - Limit: matching runtime versions cannot prove application-level correctness after an update.
- **Expo documentation index**: https://docs.expo.dev/
  - Verified: 2026-10-03.
  - Preserved use: universal Expo application, EAS workflow, Expo Router, SDK module, example, build, and deployment discovery.

Report Expo Go, development-build, simulator or emulator, physical-device, and production-build evidence separately because they prove different boundaries.
