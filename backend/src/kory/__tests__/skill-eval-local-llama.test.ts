import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { osSandboxEnabled } from '../../security/os-sandbox';
import { createLocalLlamaTextPatchSkillEvalExecutor, qwenInstructPrompt } from '../skill-eval-local-llama';

const PINNED_SHA = 'c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940';

function withEnv<T>(values: Record<string, string>, action: () => T): T {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('local llama evaluator fail-closed selection', () => {
  it('frames an isolated Qwen instruct turn with the assistant prefix open', () => {
    expect(qwenInstructPrompt('Make answer.txt')).toBe(
      '<|im_start|>user\nMake answer.txt\n<|im_end|>\n<|im_start|>assistant\n',
    );
  });

  it('refuses to construct when host sandbox confinement is disabled', () => {
    withEnv({ KORYPHAIOS_OS_SANDBOX: '0' }, () => {
      expect(() => createLocalLlamaTextPatchSkillEvalExecutor())
        .toThrow('OS-enforced sandbox is unavailable');
    });
  });

  it.skipIf(!osSandboxEnabled())('refuses an absent completion executable before selecting a model', () => {
    withEnv({ KORY_SKILL_EVAL_LLAMA_BINARY: '/nonexistent/kory-llama-executable' }, () => {
      expect(() => createLocalLlamaTextPatchSkillEvalExecutor())
        .toThrow('configured executable is not accessible');
    });
  });

  it.skipIf(!osSandboxEnabled())('rejects spoofable or mismatched model declarations without loading a model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kory-llama-negative-'));
    const executable = join(dir, 'llama-completion-stub');
    try {
      writeFileSync(executable,
        '#!/bin/sh\nprintf "%s\\n" "version: 0.5.0 (build 11146, commit 7fe450e19)" >&2\n',
        { mode: 0o700 });
      chmodSync(executable, 0o700);
      const base = {
        KORY_SKILL_EVAL_LLAMA_BINARY: executable,
        KORY_SKILL_EVAL_LLAMA_MODEL_PATH: join(dir, 'untrusted.gguf'),
      };
      withEnv({ ...base, KORY_SKILL_EVAL_LLAMA_MODEL_SHA256: '0'.repeat(64) }, () => {
        expect(() => createLocalLlamaTextPatchSkillEvalExecutor())
          .toThrow('model checksum does not match the pinned Qwen GGUF artifact');
      });
      withEnv({ ...base, KORY_SKILL_EVAL_LLAMA_MODEL_SHA256: PINNED_SHA }, () => {
        expect(() => createLocalLlamaTextPatchSkillEvalExecutor())
          .toThrow('model file is unavailable');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
