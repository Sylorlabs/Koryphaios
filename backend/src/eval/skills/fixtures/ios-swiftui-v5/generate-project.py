"""Deterministic, dependency-free Xcode project for the fixed iOS evaluator.

Executed when authoring the fixture. Its generated pbxproj and shared scheme are
checked in and subsequently verified byte-for-byte by the native runner.
"""

from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROJECT = ROOT / "KoryIOSFixture.xcodeproj"
APP_SOURCES = [
    "KoryApp.swift", "NavigationSupport.swift", "DocumentSupport.swift",
    "DetailFeature.swift", "DocumentFeature.swift",
]
TEST_SOURCES = ["IOSNativeUITests.swift"]


def key(name: str) -> str:
    return sha256(("kory-ios-v5/" + name).encode()).hexdigest()[:24].upper()


def object_at(name: str, value: str) -> str:
    return f"\t\t{key(name)} /* {name} */ = {{\n{value}\n\t\t}};"


objects = []

for name in APP_SOURCES + TEST_SOURCES:
    folder = "Sources" if name in APP_SOURCES else "evaluator"
    objects.append(object_at("ref-" + name, "\t\t\tisa = PBXFileReference;\n"
                             "\t\t\tlastKnownFileType = sourcecode.swift;\n"
                             f"\t\t\tpath = {folder}/{name};\n"
                             "\t\t\tsourceTree = \"<group>\";"))
    objects.append(object_at("build-" + name, "\t\t\tisa = PBXBuildFile;\n"
                             f"\t\t\tfileRef = {key('ref-' + name)};"))

for target, typ, filename in [
    ("app", "wrapper.application", "KoryIOSFixture.app"),
    ("uitests", "wrapper.cfbundle", "KoryIOSUITests.xctest"),
]:
    objects.append(object_at("product-" + target,
                             "\t\t\tisa = PBXFileReference;\n"
                             f"\t\t\texplicitFileType = {typ};\n"
                             f"\t\t\tpath = {filename};\n"
                             "\t\t\tsourceTree = BUILT_PRODUCTS_DIR;"))

objects.append(object_at("main-group", "\t\t\tisa = PBXGroup;\n"
                         "\t\t\tchildren = (\n" +
                         "".join(f"\t\t\t\t{key('ref-' + source)},\n" for source in APP_SOURCES + TEST_SOURCES) +
                         f"\t\t\t\t{key('products-group')},\n"
                         "\t\t\t);\n\t\t\tsourceTree = \"<group>\";"))
objects.append(object_at("products-group", "\t\t\tisa = PBXGroup;\n"
                         f"\t\t\tchildren = ({key('product-app')}, {key('product-uitests')});\n"
                         "\t\t\tname = Products;\n\t\t\tsourceTree = \"<group>\";"))

for target, sources in [("app", APP_SOURCES), ("uitests", TEST_SOURCES)]:
    objects.append(object_at("sources-" + target, "\t\t\tisa = PBXSourcesBuildPhase;\n"
                             "\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n" +
                             "".join(f"\t\t\t\t{key('build-' + source)},\n" for source in sources) +
                             "\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;"))

objects.append(object_at("test-proxy", "\t\t\tisa = PBXContainerItemProxy;\n"
                         f"\t\t\tcontainerPortal = {key('project')};\n"
                         "\t\t\tproxyType = 1;\n"
                         f"\t\t\tremoteGlobalIDString = {key('target-app')};\n"
                         "\t\t\tremoteInfo = KoryIOSFixture;"))
objects.append(object_at("test-dependency", "\t\t\tisa = PBXTargetDependency;\n"
                         f"\t\t\ttarget = {key('target-app')};\n"
                         f"\t\t\ttargetProxy = {key('test-proxy')};"))

for target, producttype, name in [
    ("app", "com.apple.product-type.application", "KoryIOSFixture"),
    ("uitests", "com.apple.product-type.bundle.ui-testing", "KoryIOSUITests"),
]:
    deps = f"{key('test-dependency')}" if target == "uitests" else ""
    objects.append(object_at("target-" + target,
                             "\t\t\tisa = PBXNativeTarget;\n"
                             f"\t\t\tbuildConfigurationList = {key('config-list-' + target)};\n"
                             f"\t\t\tbuildPhases = ({key('sources-' + target)});\n"
                             f"\t\t\tbuildRules = ();\n\t\t\tdependencies = ({deps});\n"
                             f"\t\t\tname = {name};\n"
                             f"\t\t\tproductName = {name};\n"
                             f"\t\t\tproductReference = {key('product-' + target)};\n"
                             f"\t\t\tproductType = \"{producttype}\";"))

for target in ["project", "app", "uitests"]:
    settings = {
        "project": "SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 18.0; "
                   "TARGETED_DEVICE_FAMILY = \"1,2\"; ALWAYS_SEARCH_USER_PATHS = NO;",
        "app": "PRODUCT_NAME = KoryIOSFixture; GENERATE_INFOPLIST_FILE = NO; "
               "INFOPLIST_FILE = evaluator/Info.plist; "
               "PRODUCT_BUNDLE_IDENTIFIER = com.kory.iosfixture; "
                "SUPPORTED_PLATFORMS = iphonesimulator; SWIFT_VERSION = 5.0; "
                "CODE_SIGNING_ALLOWED = NO;",
        "uitests": "PRODUCT_NAME = KoryIOSUITests; GENERATE_INFOPLIST_FILE = YES; "
                   "PRODUCT_BUNDLE_IDENTIFIER = com.kory.iosfixture.tests; "
                   "SUPPORTED_PLATFORMS = iphonesimulator; SWIFT_VERSION = 5.0; "
                   "TEST_TARGET_NAME = KoryIOSFixture; CODE_SIGNING_ALLOWED = NO;",
    }[target]
    objects.append(object_at("config-" + target,
                             "\t\t\tisa = XCBuildConfiguration;\n"
                             f"\t\t\tbuildSettings = {{ {settings} }};\n"
                             "\t\t\tname = Debug;"))
    objects.append(object_at("config-list-" + target,
                             "\t\t\tisa = XCConfigurationList;\n"
                             f"\t\t\tbuildConfigurations = ({key('config-' + target)});\n"
                             "\t\t\tdefaultConfigurationIsVisible = 0;\n"
                             "\t\t\tdefaultConfigurationName = Debug;"))

objects.append(object_at("project", "\t\t\tisa = PBXProject;\n"
                         "\t\t\tattributes = { LastUpgradeCheck = 2700; };\n"
                         f"\t\t\tbuildConfigurationList = {key('config-list-project')};\n"
                         "\t\t\tcompatibilityVersion = \"Xcode 16.0\";\n"
                         "\t\t\tdevelopmentRegion = en;\n\t\t\thasScannedForEncodings = 0;\n"
                         f"\t\t\tmainGroup = {key('main-group')};\n"
                         f"\t\t\tproductRefGroup = {key('products-group')};\n"
                         "\t\t\tprojectDirPath = \"\";\n\t\t\tprojectRoot = \"\";\n"
                         f"\t\t\ttargets = ({key('target-app')}, {key('target-uitests')});"))

pbxproj = ("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n"
           "\tobjects = {\n" + "\n".join(objects) + "\n\t};\n"
           f"\trootObject = {key('project')};\n}}\n")
path = PROJECT / "project.pbxproj"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(pbxproj)

scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.7">
  <BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES">
    <BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
      <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{key('target-app')}" BuildableName="KoryIOSFixture.app" BlueprintName="KoryIOSFixture" ReferencedContainer="container:KoryIOSFixture.xcodeproj"/>
    </BuildActionEntry></BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{key('target-uitests')}" BuildableName="KoryIOSUITests.xctest" BlueprintName="KoryIOSUITests" ReferencedContainer="container:KoryIOSFixture.xcodeproj"/></TestableReference></Testables>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{key('target-app')}" BuildableName="KoryIOSFixture.app" BlueprintName="KoryIOSFixture" ReferencedContainer="container:KoryIOSFixture.xcodeproj"/></BuildableProductRunnable>
  </LaunchAction>
</Scheme>
'''
scheme_path = PROJECT / "xcshareddata/xcschemes/KoryIOSFixture.xcscheme"
scheme_path.parent.mkdir(parents=True, exist_ok=True)
scheme_path.write_text(scheme)
