import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  nativeFixturePreflight,
  scoreNativeFixture,
  type NativeFixture,
} from './skill-eval-native-runner';

export const CPP_CALLBACK_SCENARIO = 'c-cpp-systems-engineering-full-task-1-individual';
export const C_FRAME_SCENARIO = 'c-cpp-systems-engineering-full-task-2-individual';

const registryHeader = `#ifndef KORY_REGISTRY_HPP
#define KORY_REGISTRY_HPP
#include <cstdint>
#include <memory>
struct Listener {
  virtual ~Listener() = default;
  virtual void onEvent(int value) = 0;
};
class Registry {
  struct Impl;
  std::unique_ptr<Impl> impl_;
public:
  using Handle = std::uint64_t;
  Registry();
  ~Registry();
  Registry(const Registry&) = delete;
  Registry& operator=(const Registry&) = delete;
  Handle add(std::shared_ptr<Listener> listener);
  bool remove(Handle handle);
  void dispatch(int value);
  void shutdown();
};
#endif
`;
const brokenRegistry = `#include "registry.hpp"
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>
struct Registry::Impl { std::mutex mutex; std::map<Handle, Listener*> listeners; Handle next = 1; bool closed = false; };
Registry::Registry() : impl_(std::make_unique<Impl>()) {}
Registry::~Registry() = default;
Registry::Handle Registry::add(std::shared_ptr<Listener> listener) {
  if (!listener) throw std::invalid_argument("null listener");
  std::lock_guard lock(impl_->mutex);
  if (impl_->closed) throw std::logic_error("closed registry");
  const auto handle = impl_->next++;
  impl_->listeners[handle] = listener.get();
  return handle;
}
bool Registry::remove(Handle handle) { std::lock_guard lock(impl_->mutex); return impl_->listeners.erase(handle) != 0; }
void Registry::dispatch(int value) {
  std::vector<Listener*> snapshot;
  { std::lock_guard lock(impl_->mutex); for (const auto& entry : impl_->listeners) snapshot.push_back(entry.second); }
  for (auto* listener : snapshot) listener->onEvent(value);
}
void Registry::shutdown() { std::lock_guard lock(impl_->mutex); impl_->closed = true; impl_->listeners.clear(); }
`;
const registrySmoke = `#include "registry.hpp"
#include <memory>
struct Counter : Listener { int count = 0; void onEvent(int value) override { count += value; } };
int main() { Registry registry; auto counter = std::make_shared<Counter>(); const auto handle = registry.add(counter); registry.dispatch(3); if (counter->count != 3) return 1; if (!registry.remove(handle)) return 2; registry.dispatch(4); return counter->count == 3 ? 0 : 3; }
`;

function callbackHarness(receipt: string): string {
  return `#include "registry.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <functional>
#include <future>
#include <iostream>
#include <mutex>
#include <set>
#include <stdexcept>
#include <thread>
#include <vector>
using namespace std::chrono_literals;
static void require(bool condition, const char* claim) { if (!condition) { std::cerr << claim << '\\n'; std::exit(91); } }
struct Probe : Listener {
  std::function<void(int)> callback;
  std::atomic<int>* deaths;
  int marker = 1729;
  Probe(std::function<void(int)> cb, std::atomic<int>* d) : callback(std::move(cb)), deaths(d) {}
  ~Probe() override { if (deaths) deaths->fetch_add(1); }
  void onEvent(int value) override { callback(value); require(marker == 1729, "listener lifetime after callback"); }
};
struct Gate {
  std::mutex mutex; std::condition_variable changed; bool entered = false, released = false;
  void block() { std::unique_lock lock(mutex); entered = true; changed.notify_all(); changed.wait(lock, [&] { return released; }); }
  bool await() { std::unique_lock lock(mutex); return changed.wait_for(lock, 2s, [&] { return entered; }); }
  void release() { std::lock_guard lock(mutex); released = true; changed.notify_all(); }
};
static void ownership() {
  std::atomic<int> deaths{0}, sum{0}; Registry registry;
  auto probe = std::make_shared<Probe>([&](int value) { sum += value; }, &deaths); std::weak_ptr<Probe> weak = probe;
  const auto handle = registry.add(probe); probe.reset();
  require(!weak.expired(), "registered listener retains an owner");
  registry.dispatch(7); require(sum == 7, "first callback");
  require(registry.remove(handle), "remove existing handle"); require(!registry.remove(handle), "remove is idempotent");
  require(weak.expired() && deaths == 1, "removed listener released without leaking");
  registry.dispatch(11); require(sum == 7, "removed listener not admitted again");
}
static void admitted_removal_and_independence(bool closing) {
  Gate gate; std::atomic<int> deaths{0}, sum{0}; Registry registry, unrelated;
  auto probe = std::make_shared<Probe>([&](int value) { gate.block(); sum += value; }, &deaths); std::weak_ptr<Probe> weak = probe;
  const auto handle = registry.add(probe); probe.reset();
  std::thread dispatch([&] { registry.dispatch(9); });
  const bool entered = gate.await(); if (!entered) { gate.release(); dispatch.join(); require(false, "callback entered"); }
  auto change = std::async(std::launch::async, [&] { if (closing) registry.shutdown(); else require(registry.remove(handle), "concurrent remove"); });
  auto independent = std::async(std::launch::async, [&] { auto item = std::make_shared<Probe>([](int) {}, nullptr); auto id = unrelated.add(item); unrelated.dispatch(1); require(unrelated.remove(id), "unrelated remove"); });
  const bool changeReady = change.wait_for(750ms) == std::future_status::ready;
  const bool independentReady = independent.wait_for(750ms) == std::future_status::ready;
  const bool held = !weak.expired(); gate.release(); dispatch.join(); change.get(); independent.get();
  require(changeReady, "unregister or shutdown must not wait for user callback");
  require(independentReady, "unrelated registry blocked behind a global callback lock");
  require(held && weak.expired() && deaths == 1 && sum == 9, "snapshot owns admitted callback until completion");
  registry.dispatch(4); require(sum == 9, "closed or removed callbacks stay absent");
  if (closing) {
    bool rejected = false; try { registry.add(std::make_shared<Probe>([](int) {}, nullptr)); } catch (const std::logic_error&) { rejected = true; }
    require(rejected, "shutdown rejects new registrations"); registry.shutdown();
  }
}
static void reentrant_and_throwing() {
  Registry registry; Registry::Handle handle = 0; std::atomic<int> deaths{0}, calls{0};
  auto probe = std::make_shared<Probe>([&](int) { ++calls; require(registry.remove(handle), "self remove"); registry.dispatch(8); }, &deaths);
  handle = registry.add(probe); probe.reset(); registry.dispatch(1); require(calls == 1 && deaths == 1, "self removal releases snapshot");
  auto throwing = std::make_shared<Probe>([](int) { throw std::runtime_error("callback failure"); }, &deaths); auto id = registry.add(throwing); throwing.reset();
  bool threw = false; try { registry.dispatch(0); } catch (const std::runtime_error&) { threw = true; }
  require(threw, "callback error preserved"); require(registry.remove(id), "registry remains usable after callback error"); require(deaths == 2, "throwing callback released");
  bool rejected = false; try { registry.add(nullptr); } catch (const std::invalid_argument&) { rejected = true; } require(rejected, "null callback rejected");
}
static void concurrent_churn() {
  Registry registry; std::atomic<int> deaths{0}, calls{0}; std::atomic<bool> stop{false}; std::mutex mutex; std::set<Registry::Handle> handles;
  std::thread dispatch([&] { while (!stop.load()) registry.dispatch(1); });
  std::vector<std::thread> writers;
  for (int worker = 0; worker < 4; ++worker) writers.emplace_back([&] {
    for (int i = 0; i < 128; ++i) {
      auto probe = std::make_shared<Probe>([&](int value) { calls.fetch_add(value); }, &deaths);
      const auto id = registry.add(probe); { std::lock_guard lock(mutex); require(handles.insert(id).second && id != 0, "unique nonzero handle"); }
      registry.dispatch(1); require(registry.remove(id), "concurrent handle removal");
    }
  });
  for (auto& writer : writers) writer.join(); stop = true; dispatch.join(); registry.shutdown();
  require(handles.size() == 512 && deaths == 512 && calls >= 512, "churn releases all owners and delivers registered callbacks");
}
int main() {
  ownership(); admitted_removal_and_independence(false); admitted_removal_and_independence(true); reentrant_and_throwing(); concurrent_churn();
  std::atomic<int> deaths{0}; { Registry registry; registry.add(std::make_shared<Probe>([](int) {}, &deaths)); } require(deaths == 1, "registry destruction releases listener");
  std::cout << ${JSON.stringify(receipt)} << '\\n';
}
`;
}

const frameHeader = `#ifndef KORY_FRAME_H
#define KORY_FRAME_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef enum { FRAME_OK = 0, FRAME_NEED_MORE = 1, FRAME_INVALID = 2 } frame_status;
typedef struct { const uint8_t* payload; uint32_t length; size_t consumed; } frame_view;
int frame_size32(uint32_t payload_length, uint32_t* total);
frame_status decode_frame(const uint8_t* bytes, size_t available, frame_view* output);
#ifdef __cplusplus
}
#endif
#endif
`;
const brokenFrame = `#include "frame.h"
int frame_size32(uint32_t payload_length, uint32_t* total) {
  if (!total) return 0;
  *total = payload_length + UINT32_C(6);
  return 1;
}
frame_status decode_frame(const uint8_t* bytes, size_t available, frame_view* output) {
  if (!output || (!bytes && available)) return FRAME_INVALID;
  if (available < 6) return FRAME_NEED_MORE;
  if (bytes[0] != 0x4b || bytes[1] != 0x59) return FRAME_INVALID;
  uint32_t length = (uint32_t)bytes[2] | ((uint32_t)bytes[3] << 8) | ((uint32_t)bytes[4] << 16) | ((uint32_t)bytes[5] << 24);
  uint32_t total = length + UINT32_C(6);
  if (available < total) return FRAME_NEED_MORE;
  output->payload = bytes + 6; output->length = length; output->consumed = total;
  return FRAME_OK;
}
`;
const frameSmoke = `#include "frame.h"
int main(void) { const uint8_t bytes[] = {0x4b,0x59,1,0,0,0,42}; frame_view view; if (decode_frame(bytes, sizeof bytes, &view) != FRAME_OK) return 1; return view.length == 1 && view.consumed == 7 && view.payload == bytes + 6 && view.payload[0] == 42 ? 0 : 2; }
`;
function frameHarness(receipt: string): string {
  return `#include "frame.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void require(int condition, const char* claim) { if (!condition) { fprintf(stderr, "%s\\n", claim); exit(91); } }
static uint32_t random_state = UINT32_C(0x51f2a431);
static uint32_t next_random(void) { random_state ^= random_state << 13; random_state ^= random_state >> 17; random_state ^= random_state << 5; return random_state; }
static void header(uint8_t* data, uint32_t length) { data[0]=0x4b; data[1]=0x59; data[2]=(uint8_t)length; data[3]=(uint8_t)(length>>8); data[4]=(uint8_t)(length>>16); data[5]=(uint8_t)(length>>24); }
static void test_decode(const uint8_t* input, size_t available) {
  frame_view output = { (const uint8_t*)"unchanged", 77, 88 }, original = output;
  frame_status expected;
  uint32_t length = 0;
  if (!input && available) expected = FRAME_INVALID;
  else if (available < 6) expected = FRAME_NEED_MORE;
  else if (input[0] != 0x4b || input[1] != 0x59) expected = FRAME_INVALID;
  else {
    length = (uint32_t)input[2] | ((uint32_t)input[3]<<8) | ((uint32_t)input[4]<<16) | ((uint32_t)input[5]<<24);
    expected = (uint64_t)length + UINT64_C(6) <= (uint64_t)available ? FRAME_OK : FRAME_NEED_MORE;
  }
  const frame_status actual = decode_frame(input, available, &output);
  require(actual == expected, "decode status differs from wide-arithmetic reference");
  if (expected != FRAME_OK) require(output.payload == original.payload && output.length == original.length && output.consumed == original.consumed, "failure changed output");
  else { require(output.payload == input+6 && output.length == length && output.consumed == (size_t)length+6, "zero-copy view or consumed count changed"); if (length) require(output.payload[length-1] == input[6+length-1], "payload end out of bounds"); }
}
int main(void) {
  require(CHAR_BIT == 8 && sizeof(uint32_t) == 4, "wire-format width");
  test_decode(NULL, 0); test_decode(NULL, 1); require(decode_frame(NULL, 0, NULL) == FRAME_INVALID, "missing output rejected");
  for (uint32_t i = 0; i < 32; ++i) {
    const uint32_t length = UINT32_MAX-i; uint32_t total=123;
    const int ok = frame_size32(length, &total); const int expected = (uint64_t)length+6 <= UINT32_MAX;
    require(ok == expected && (ok ? total == length+6 : total == 123), "32-bit size overflow or failed-output mutation");
  }
  require(frame_size32(1,NULL) == 0, "null size output");
  for (unsigned sample = 0; sample < 1024; ++sample) {
    uint32_t length = next_random() % 1025; size_t count = (size_t)length+6;
    uint8_t* bytes = (uint8_t*)malloc(count); require(bytes != NULL, "test allocation"); header(bytes,length);
    for (uint32_t j=0;j<length;++j) bytes[6+j]=(uint8_t)next_random();
    test_decode(bytes,count); uint32_t size=0; require(frame_size32(length,&size) && size == count, "ordinary 32-bit size");
    const size_t cut = next_random() % count;
    uint8_t* short_bytes = (uint8_t*)malloc(cut ? cut : 1); require(short_bytes != NULL,"truncation allocation"); memcpy(short_bytes,bytes,cut); test_decode(short_bytes,cut); free(short_bytes);
    header(bytes,UINT32_MAX-(sample%6)); test_decode(bytes,count); free(bytes);
  }
  for (size_t count=0;count<6;++count) { uint8_t* bytes=(uint8_t*)malloc(count ? count : 1); require(bytes!=NULL,"short header"); memset(bytes,0,count); if(count)bytes[0]=0x4b; test_decode(bytes,count); free(bytes); }
  uint8_t joined[17]; header(joined,2); joined[6]=17;joined[7]=18;header(joined+8,3);joined[14]=19;joined[15]=20;joined[16]=21;
  frame_view first,second; require(decode_frame(joined,sizeof joined,&first)==FRAME_OK,"first concatenated frame");
  require(decode_frame(joined+first.consumed,sizeof joined-first.consumed,&second)==FRAME_OK && first.consumed+second.consumed==sizeof joined,"concatenated consumed positions");
  uint8_t unaligned[8]={0};header(unaligned+1,1);unaligned[7]=42;test_decode(unaligned+1,7);
  uint8_t empty[6];header(empty,0);test_decode(empty,6);empty[0]=0;test_decode(empty,6);
  puts(${JSON.stringify(receipt)}); return 0;
}
`;
}

export const C_CPP_NATIVE_FIXTURES: readonly NativeFixture[] = [
  {
    id: CPP_CALLBACK_SCENARIO,
    language: 'cpp',
    modes: ['optimized', 'address-undefined', 'thread'],
    fixedFiles: {
      'include/registry.hpp': registryHeader,
      'tests/public.cpp': registrySmoke,
      'README.md': `# Callback registry lifetime and concurrency\n\nRepair src/registry.cpp. The immutable public C++20 API is in include/registry.hpp. add shares ownership, returns a unique nonzero handle, rejects null with invalid_argument and a closed registry with logic_error. remove is idempotent. A dispatch snapshots current registrations: an already admitted callback may finish after removal or shutdown, but later dispatches must not admit it. No registry lock may be held across user callbacks. remove and shutdown must complete while a callback is blocked, and unrelated registries remain independent. Callback exceptions propagate without corrupting state. shutdown closes admission and releases registrations; outstanding dispatch snapshots release on completion. Callers join dispatch threads before destroying the registry object. Do not retain dead listeners permanently.\n\nKeep the header and public example unchanged. Implementation helpers may live in src/. Add tests/regression.cpp with an ordinary int main() that exits zero on success and nonzero when its asserted contract fails. It must pass against your implementation and reproduce a failure against the original source. You may use std::shared_ptr, another valid ownership scheme, or another internal container; preserve the API and behavior.\n\nThe evaluator independently builds a varied concurrent client against your compiled translation units, runs optimized, ASan/UBSan and TSan builds, checks admitted callback ownership, self-removal, exception recovery, shutdown, concurrent churn and progress of unrelated registries. It writes .kory-eval/cpp-native-evidence.json. This is actual local native execution, not a claim of universal race freedom or a general leak audit. No external dependencies or network are needed.\n`,
    },
    initialSources: { 'src/registry.cpp': brokenRegistry },
    harness: callbackHarness,
    reportPath: '.kory-eval/cpp-native-evidence.json',
  },
  {
    id: C_FRAME_SCENARIO,
    language: 'c',
    modes: ['optimized', 'address-undefined'],
    fixedFiles: {
      'include/frame.h': frameHeader,
      'tests/public.c': frameSmoke,
      'README.md': `# Bounded C binary frame decoder\n\nRepair src/frame.c without changing include/frame.h. The wire header is six bytes: magic 0x4b 0x59 followed by a four-byte unsigned little-endian payload length. Success returns a zero-copy payload view and the bytes consumed by exactly one frame, allowing concatenation. Fewer than six bytes means FRAME_NEED_MORE. A complete header with wrong magic means FRAME_INVALID; a valid header with an incomplete payload means FRAME_NEED_MORE. A null output or null input with nonzero available length means FRAME_INVALID. Null input with zero bytes and a valid output means FRAME_NEED_MORE. Failures must not change output fields. Validate available length before reading any header byte or forming an out-of-range pointer. Do not reject valid encodings merely to avoid a boundary case.\n\nframe_size32 is the explicit 32-bit size arithmetic boundary: return 1 and write six plus payload length when representable in uint32_t; otherwise return 0 without modifying the output. A null size output returns 0. The host decoder uses its actual size_t width. This arithmetic exercise is not a native 32-bit build.\n\nKeep the header and public example unchanged. Add tests/regression.c with int main(void), returning zero on success and nonzero on a failed assertion. It must pass against your implementation and expose the original overflow defect. Helpers can live in src/. The evaluator compiles your C11 translation units separately from a client, compares seeded valid, truncation, wraparound, unaligned, empty, maximum-length and concatenated inputs against independent wide arithmetic, and runs optimized and ASan/UBSan binaries. It writes .kory-eval/c-native-evidence.json. No dependency downloads or network are needed.\n`,
    },
    initialSources: { 'src/frame.c': brokenFrame },
    harness: frameHarness,
    reportPath: '.kory-eval/c-native-evidence.json',
  },
];

export const C_CPP_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  C_CPP_NATIVE_FIXTURES.map((fixture) => ({
    id: `c-cpp-systems-engineering/${fixture.language}-native@1`,
    get readinessBlockers() {
      return nativeFixturePreflight(fixture).reasons;
    },
    matches: (scenario) => scenario.id === fixture.id,
    materialize: (destination) => {
      for (const [path, text] of Object.entries({
        ...fixture.fixedFiles,
        ...fixture.initialSources,
      }))
        writeFixtureFile(destination, path, text);
    },
  }));
export const C_CPP_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  C_CPP_NATIVE_FIXTURES.map((fixture) => ({
    id: `c-cpp-systems-engineering/${fixture.language}-native-scorer@2`,
    scenarioIds: [fixture.id],
    score: ({ workingDirectory }) => scoreNativeFixture(workingDirectory, fixture),
  }));
