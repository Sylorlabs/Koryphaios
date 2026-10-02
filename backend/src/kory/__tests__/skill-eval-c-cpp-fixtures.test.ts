import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  C_CPP_NATIVE_FIXTURES,
  C_CPP_SKILL_EVAL_MATERIALIZERS,
} from '../skill-eval-c-cpp-fixtures';
import {
  nativeFixturePreflight,
  scoreNativeFixture,
  type NativeFixture,
} from '../skill-eval-native-runner';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';

// These solutions calibrate the evaluator only. They must not be copied into
// a live-model subject's fixture or counted as skill/no-skill observations.
const cppControl = `#include "registry.hpp"
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>
struct Registry::Impl { std::mutex mutex; std::map<Handle, std::shared_ptr<Listener>> listeners; Handle next=1; bool closed=false; };
Registry::Registry():impl_(std::make_unique<Impl>()){}
Registry::~Registry()=default;
Registry::Handle Registry::add(std::shared_ptr<Listener> listener){
  if(!listener)throw std::invalid_argument("null listener");
  std::lock_guard lock(impl_->mutex);if(impl_->closed)throw std::logic_error("closed registry");
  auto handle=impl_->next++;impl_->listeners.emplace(handle,std::move(listener));return handle;
}
bool Registry::remove(Handle handle){std::shared_ptr<Listener> removed;{std::lock_guard lock(impl_->mutex);auto found=impl_->listeners.find(handle);if(found==impl_->listeners.end())return false;removed=std::move(found->second);impl_->listeners.erase(found);}return true;}
void Registry::dispatch(int value){std::vector<std::shared_ptr<Listener>> snapshot;{std::lock_guard lock(impl_->mutex);for(const auto& entry:impl_->listeners)snapshot.push_back(entry.second);}for(const auto& listener:snapshot)listener->onEvent(value);}
void Registry::shutdown(){std::map<Handle,std::shared_ptr<Listener>> removed;{std::lock_guard lock(impl_->mutex);impl_->closed=true;removed.swap(impl_->listeners);}}
`;
const cppRegression = `#include "registry.hpp"
#include <memory>
struct Probe : Listener { void onEvent(int) override {} };
int main(){Registry registry;auto probe=std::make_shared<Probe>();std::weak_ptr<Probe> weak=probe;auto id=registry.add(probe);probe.reset();if(weak.expired())return 1;if(!registry.remove(id))return 2;return weak.expired()?0:3;}
`;
const cControl = `#include "frame.h"
int frame_size32(uint32_t length,uint32_t* total){if(!total||length>UINT32_MAX-6)return 0;*total=length+6;return 1;}
frame_status decode_frame(const uint8_t* bytes,size_t available,frame_view* output){
  if(!output||(!bytes&&available))return FRAME_INVALID;
  if(available<6)return FRAME_NEED_MORE;
  if(bytes[0]!=0x4b||bytes[1]!=0x59)return FRAME_INVALID;
  uint32_t length=(uint32_t)bytes[2]|((uint32_t)bytes[3]<<8)|((uint32_t)bytes[4]<<16)|((uint32_t)bytes[5]<<24);
  if((uintmax_t)length>(uintmax_t)(available-6))return FRAME_NEED_MORE;
  frame_view valid={bytes+6,length,(size_t)length+6};*output=valid;return FRAME_OK;
}
`;
const cRegression = `#include "frame.h"
int main(void){uint32_t total=123;if(frame_size32(UINT32_MAX,&total)||total!=123)return 1;const uint8_t bytes[]={0x4b,0x59,255,255,255,255};frame_view output={0,0,0};return decode_frame(bytes,sizeof bytes,&output)==FRAME_NEED_MORE?0:2;}
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixtureRoot(fixture: NativeFixture, source?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-native-control-'));
  roots.push(root);
  const materializer = C_CPP_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.id.includes(`/${fixture.language}-native`),
  )!;
  await materializer.materialize(root, { id: fixture.id } as never);
  if (source) writeFixtureFile(root, Object.keys(fixture.initialSources)[0]!, source);
  writeFixtureFile(
    root,
    `tests/regression.${fixture.language === 'c' ? 'c' : 'cpp'}`,
    fixture.language === 'c' ? cRegression : cppRegression,
  );
  return root;
}

describe('actual native C and C++ evaluators', () => {
  for (const fixture of C_CPP_NATIVE_FIXTURES) {
    const preflight = nativeFixturePreflight(fixture);
    const runtimeTest = test.skipIf(preflight.reasons.length > 0);
    test(`${fixture.language}: preflight records actual compiler and each configured mode`, () => {
      expect(preflight.version).toMatch(/clang|unavailable|ENOENT/iu);
      if (!preflight.reasons.length) {
        expect(preflight.runs.filter((run) => run.phase.startsWith('preflight-run-'))).toHaveLength(
          fixture.modes.length,
        );
        expect(preflight.runs.every((run) => run.status === 0)).toBe(true);
      }
    });
    runtimeTest(
      `${fixture.language}: unchanged defect fails native behavioral checks`,
      async () => {
        const result = scoreNativeFixture(await fixtureRoot(fixture), fixture);
        expect(result.passed, result.evidence.join('\n')).toBe(false);
        expect(result.integrityFailure).toBe(false);
        expect(result.evidence).toContain('optimized: fail');
      },
      60_000,
    );
    runtimeTest(
      `${fixture.language}: missing candidate regression is a task failure, not tampering`,
      async () => {
        const root = await fixtureRoot(fixture);
        const regression = `tests/regression.${fixture.language === 'c' ? 'c' : 'cpp'}`;
        rmSync(join(root, regression));
        const result = scoreNativeFixture(root, fixture);
        expect(result.passed).toBe(false);
        expect(result.integrityFailure).toBe(false);
        expect(result.evidence).toContain(`Missing candidate regression coverage: ${regression}`);
        const outside = join(root, 'outside-regression.txt');
        writeFileSync(outside, 'int main(void) { return 0; }');
        symlinkSync(outside, join(root, regression));
        expect(scoreNativeFixture(root, fixture).integrityFailure).toBe(true);
        expect(readFileSync(outside, 'utf8')).toBe('int main(void) { return 0; }');
      },
    );
    runtimeTest(
      `${fixture.language}: valid control passes compiled clients and a real failing regression baseline`,
      async () => {
        const root = await fixtureRoot(fixture, fixture.language === 'c' ? cControl : cppControl);
        const result = scoreNativeFixture(root, fixture);
        expect(result.passed, result.evidence.join('\n')).toBe(true);
        expect(result.integrityFailure).toBe(false);
        const report = JSON.parse(readFileSync(join(root, fixture.reportPath), 'utf8'));
        expect(report.evidenceKind).toBe('actual-local-native-runtime');
        expect(report.sourceFingerprint).toHaveLength(64);
        expect(report.checks).toHaveLength(fixture.modes.length + 2);
        expect(report.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
      },
      60_000,
    );
    runtimeTest(
      `${fixture.language}: an alternative implementation is accepted without source-shape scoring`,
      async () => {
        const alternative =
          fixture.language === 'c'
            ? cControl
                .replace('length>UINT32_MAX-6', '(uint64_t)length+6>UINT32_MAX')
                .replace(
                  '(uintmax_t)length>(uintmax_t)(available-6)',
                  '(uint64_t)length+6>(uint64_t)available',
                )
            : cppControl
                .replaceAll('<map>', '<unordered_map>')
                .replaceAll('std::map<', 'std::unordered_map<');
        const result = scoreNativeFixture(await fixtureRoot(fixture, alternative), fixture);
        expect(result.passed, result.evidence.join('\n')).toBe(true);
      },
      60_000,
    );
    runtimeTest(
      `${fixture.language}: a success-only regression cannot satisfy the negative control`,
      async () => {
        const root = await fixtureRoot(fixture, fixture.language === 'c' ? cControl : cppControl);
        writeFixtureFile(
          root,
          `tests/regression.${fixture.language === 'c' ? 'c' : 'cpp'}`,
          'int main(void) { return 0; }\n',
        );
        const result = scoreNativeFixture(root, fixture);
        expect(result.passed).toBe(false);
        expect(result.evidence).toContain('regression-broken: fail');
      },
      60_000,
    );
    test(`${fixture.language}: fixed-header tampering and symlink evidence are rejected`, async () => {
      const root = await fixtureRoot(fixture);
      const header = Object.keys(fixture.fixedFiles).find((path) => path.startsWith('include/'))!;
      writeFileSync(join(root, header), '// contract removed\n');
      expect(scoreNativeFixture(root, fixture).integrityFailure).toBe(true);
      writeFileSync(join(root, header), fixture.fixedFiles[header]!);
      const source = Object.keys(fixture.initialSources)[0]!;
      const outside = join(root, 'outside-source.txt');
      writeFileSync(outside, fixture.initialSources[source]!);
      rmSync(join(root, source));
      symlinkSync(outside, join(root, source));
      expect(scoreNativeFixture(root, fixture).integrityFailure).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe(fixture.initialSources[source]);
    });
  }
  const cpp = C_CPP_NATIVE_FIXTURES[0]!;
  test.skipIf(nativeFixturePreflight(cpp).reasons.length > 0)(
    'C++: retaining every removed listener is rejected as a lifetime leak',
    async () => {
      const leaky = cppControl
        .replace(
          'std::mutex mutex;',
          'std::vector<std::shared_ptr<Listener>> leaked; std::mutex mutex;',
        )
        .replace(
          'removed=std::move(found->second);',
          'impl_->leaked.push_back(found->second);removed=std::move(found->second);',
        );
      const result = scoreNativeFixture(await fixtureRoot(cpp, leaky), cpp);
      expect(result.passed).toBe(false);
      expect(result.evidence.join('\n')).toContain('removed listener released without leaking');
    },
    60_000,
  );
});
