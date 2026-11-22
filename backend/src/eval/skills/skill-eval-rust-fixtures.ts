import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

const ASYNC_LOCK = 'rust-engineering-full-task-1-individual';
const FFI_LIFETIME = 'rust-engineering-full-task-2-individual';

const ASYNC_SOURCE = `use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IoError;

#[derive(Clone, Default)]
pub struct Service {
    state: Arc<Mutex<HashMap<String, String>>>,
}

impl Service {
    pub async fn apply<F>(&self, key: String, value: String, io: F) -> Result<(), IoError>
    where
        F: Future<Output = Result<(), IoError>> + Send,
    {
        // BUG: a synchronous guard spans the suspension point. The returned future is not Send,
        // and a panic in external work poisons state ownership that external work did not own.
        let mut state = self.state.lock().expect("state lock poisoned");
        io.await?;
        state.insert(key, value);
        Ok(())
    }

    pub fn snapshot(&self) -> HashMap<String, String> {
        self.state.lock().expect("state lock poisoned").clone()
    }
}
`;

const FFI_SOURCE = `use std::mem::align_of;
use std::slice;
use std::sync::Mutex;

const MAX_VALUES: usize = 1_048_576;
static BORROWED: Mutex<(usize, usize)> = Mutex::new((0, 0));

#[no_mangle]
pub unsafe extern "C" fn ingest_values(ptr: *const u32, len: usize) -> bool {
    if len > MAX_VALUES || (ptr.is_null() && len != 0) { return false; }
    if !ptr.is_null() && (ptr as usize) % align_of::<u32>() != 0 { return false; }
    // BUG: the foreign pointer is retained after the callback boundary instead of copying.
    *BORROWED.lock().expect("store poisoned") = (ptr as usize, len);
    true
}

pub fn last_values() -> Vec<u32> {
    let (address, len) = *BORROWED.lock().expect("store poisoned");
    if len == 0 { return Vec::new(); }
    unsafe { slice::from_raw_parts(address as *const u32, len).to_vec() }
}
`;

function runRust(root: string, hiddenSource: string): { passed: boolean; evidence: string } {
  const build = join(root, '.kory-hidden-rust');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  const hidden = '__kory_hidden.rs';
  writeFixtureFile(root, hidden, hiddenSource);
  const library = join(build, 'libkory_fixture.rlib');
  const binary = join(build, 'hidden');
  try {
    const compileLibrary = spawnSync(
      '/opt/homebrew/bin/rustc',
      [
        '--edition=2021',
        '--crate-name',
        'kory_fixture',
        '--crate-type=rlib',
        '-Dwarnings',
        join(root, 'src/lib.rs'),
        '-o',
        library,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_000_000,
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: root, RUST_BACKTRACE: '0' },
      },
    );
    if (compileLibrary.status !== 0)
      return {
        passed: false,
        evidence:
          `rustc library failed\n${compileLibrary.stdout ?? ''}\n${compileLibrary.stderr ?? ''}`.slice(
            -6000,
          ),
      };
    const compileHidden = spawnSync(
      '/opt/homebrew/bin/rustc',
      [
        '--edition=2021',
        join(root, hidden),
        '--extern',
        `kory_fixture=${library}`,
        '-L',
        build,
        '-o',
        binary,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_000_000,
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: root, RUST_BACKTRACE: '0' },
      },
    );
    if (compileHidden.status !== 0)
      return {
        passed: false,
        evidence:
          `rustc hidden checks failed\n${compileHidden.stdout ?? ''}\n${compileHidden.stderr ?? ''}`.slice(
            -6000,
          ),
      };
    const execute = spawnSync(binary, [], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1_000_000,
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: root, RUST_BACKTRACE: '0' },
    });
    return {
      passed: execute.status === 0 && /KORY_RUST_OK/u.test(execute.stdout ?? ''),
      evidence: `${execute.stdout ?? ''}\n${execute.stderr ?? ''}`.slice(-6000),
    };
  } finally {
    rmSync(join(root, hidden), { force: true });
    rmSync(build, { recursive: true, force: true });
  }
}

function regression(root: string, patterns: RegExp[]): boolean {
  try {
    const text = readFileSync(join(root, 'tests/regression.md'), 'utf8');
    return patterns.every((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
  } catch {
    return false;
  }
}

function scoreAsync(root: string): SkillEvalDeterministicScore {
  const runtime = runRust(
    root,
    `use kory_fixture::{IoError, Service};
use std::future::{ready, Future};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

struct Noop;
impl Wake for Noop { fn wake(self: Arc<Self>) {} }
fn context() -> Context<'static> {
    let waker = Waker::from(Arc::new(Noop));
    Context::from_waker(Box::leak(Box::new(waker)))
}
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future); let mut cx = context();
    loop { match future.as_mut().poll(&mut cx) { Poll::Ready(value) => return value, Poll::Pending => std::thread::yield_now() } }
}
fn assert_send<T: Send>(_: T) {}
struct Never;
impl Future for Never { type Output = Result<(), IoError>; fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> { Poll::Pending } }

fn main() {
    let service = Service::default();
    assert_send(service.apply("send".into(), "ok".into(), ready(Ok(()))));
    block_on(service.apply("a".into(), "1".into(), ready(Ok(())))).unwrap();
    assert_eq!(service.snapshot().get("a").map(String::as_str), Some("1"));
    assert_eq!(block_on(service.apply("bad".into(), "x".into(), ready(Err(IoError)))), Err(IoError));
    assert!(!service.snapshot().contains_key("bad"));

    let panic_service = service.clone();
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = block_on(panic_service.apply("panic".into(), "x".into(), async { panic!("io panic"); #[allow(unreachable_code)] Ok::<(), IoError>(()) }));
    }));
    assert!(panicked.is_err());
    block_on(service.apply("after".into(), "ok".into(), ready(Ok(())))).unwrap();

    let cancel = service.clone();
    let mut pending = Box::pin(cancel.apply("cancel".into(), "never".into(), Never));
    let mut cx = context(); assert!(matches!(pending.as_mut().poll(&mut cx), Poll::Pending)); drop(pending);
    assert!(!service.snapshot().contains_key("cancel"));

    let shared = Arc::new(Service::default()); let mut threads = Vec::new();
    for i in 0..12 { let s = shared.clone(); threads.push(std::thread::spawn(move || block_on(s.apply(format!("k{i}"), format!("v{i}"), ready(Ok(())))).unwrap())); }
    for thread in threads { thread.join().unwrap(); }
    assert_eq!(shared.snapshot().len(), 12);
    println!("KORY_RUST_OK");
}
`,
  );
  const reg = regression(root, [/send|await|lock|critical/iu, /error|panic|cancel|concurrent/iu]);
  const source = existsSync(join(root, 'src/lib.rs'))
    ? readFileSync(join(root, 'src/lib.rs'), 'utf8')
    : '';
  const noBroadWorkaround = !/unsafe\b|Arc\s*<\s*Mutex\s*<\s*Service/iu.test(source);
  const passed = runtime.passed && reg && noBroadWorkaround;
  return {
    passed,
    quality: passed ? 1 : runtime.passed && noBroadWorkaround ? 0.85 : runtime.passed ? 0.7 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Rust Send/critical-section runtime checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${reg ? 'present' : 'missing'}`,
      `unsafe/broad workaround: ${noBroadWorkaround ? 'absent' : 'present'}`,
      runtime.evidence,
    ],
  };
}

function scoreFfi(root: string): SkillEvalDeterministicScore {
  const runtime = runRust(
    root,
    `use kory_fixture::{ingest_values, last_values};

fn main() {
    let mut values = vec![11_u32, 22, 33];
    assert!(unsafe { ingest_values(values.as_ptr(), values.len()) });
    values.fill(999);
    assert_eq!(last_values(), vec![11, 22, 33], "foreign callback data must be owned before return");
    assert!(unsafe { ingest_values(std::ptr::null(), 0) }); assert!(last_values().is_empty());
    assert!(!unsafe { ingest_values(std::ptr::null(), 1) });
    assert!(!unsafe { ingest_values(values.as_ptr(), 1_048_577) });
    let bytes = [0_u8; 16]; let misaligned = unsafe { bytes.as_ptr().add(1) } as *const u32;
    assert!(!unsafe { ingest_values(misaligned, 1) });
    println!("KORY_RUST_OK");
}
`,
  );
  const reg = regression(root, [/null|zero|oversiz|align/iu, /lifetime|callback|copy|owned/iu]);
  const source = existsSync(join(root, 'src/lib.rs'))
    ? readFileSync(join(root, 'src/lib.rs'), 'utf8')
    : '';
  const noStaticMut = !/static\s+mut\b/u.test(source);
  const unsafeCount = (source.match(/\bunsafe\b/gu) ?? []).length;
  const boundedUnsafe = unsafeCount <= 3;
  const passed = runtime.passed && reg && noStaticMut && boundedUnsafe;
  return {
    passed,
    quality: passed ? 1 : runtime.passed && noStaticMut ? 0.85 : runtime.passed ? 0.7 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Rust FFI ownership/bounds checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${reg ? 'present' : 'missing'}`,
      `static mut absent: ${noStaticMut ? 'yes' : 'no'}`,
      `unsafe surface bounded (${unsafeCount}): ${boundedUnsafe ? 'yes' : 'no'}`,
      runtime.evidence,
    ],
  };
}

export const RUST_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'rust-engineering/async-lock-lifetime@1',
    matches: (scenario) => scenario.id === ASYNC_LOCK,
    materialize: (root) => {
      writeFixtureFile(root, 'src/lib.rs', ASYNC_SOURCE);
      writeFixtureFile(
        root,
        'tests/regression.md',
        'Add Send/no-lock-across-await critical-section plus error, panic, cancellation, and concurrent request regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Rust async lock lifetime\n\nFix Service.apply without changing its public contract. External async work must run without a std::sync::MutexGuard alive. Commit the shared-map mutation in a short non-awaiting critical section only after I/O succeeds. The returned future must be Send; cancellation/error/panic before commit leaves state unchanged and usable.\n',
      );
    },
  },
  {
    id: 'rust-engineering/ffi-owned-slice@1',
    matches: (scenario) => scenario.id === FFI_LIFETIME,
    materialize: (root) => {
      writeFixtureFile(root, 'src/lib.rs', FFI_SOURCE);
      writeFixtureFile(
        root,
        'tests/regression.md',
        'Add null/zero/oversized/alignment vectors and prove callback-lifetime data is copied/owned before later access.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Rust FFI pointer lifetime\n\nPreserve ingest_values as a C ABI boundary. The pointer is valid only for the duration of the call, so persistent state must own a copy. Null+zero is an empty success; null+nonzero, over one million values, or misaligned nonempty pointers are rejected before dereference. Keep unsafe localized and avoid static mut.\n',
      );
    },
  },
];

export const RUST_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'rust-engineering/async-lock-lifetime-scorer@1',
    scenarioIds: [ASYNC_LOCK],
    score: ({ workingDirectory }) => scoreAsync(workingDirectory),
  },
  {
    id: 'rust-engineering/ffi-owned-slice-scorer@1',
    scenarioIds: [FFI_LIFETIME],
    score: ({ workingDirectory }) => scoreFfi(workingDirectory),
  },
];
