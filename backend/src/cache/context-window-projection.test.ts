import { describe, expect, test } from 'bun:test';
import {
  buildProjectionCheckpointMessage,
  chunkProjectionTranscript,
  planContextWindowProjection,
  projectionMessagesTokenUpperBound,
  type ProjectableContextMessage,
} from './context-window-projection';

const params = {
  sourceContextKey: 'session-1:revision-7:message-last',
  targetModel: 'smaller-256k-model',
  targetWindow: 256_000,
  reservedOutputTokens: 16_384,
  stableOverheadTokens: 12_000,
  universalContextKey: 'workspace:v3:tool-abi:v2',
};

function largeHistory(): ProjectableContextMessage[] {
  return Array.from({ length: 250 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}:` + 'x'.repeat(8_000),
  }));
}

describe('context-window projection', () => {
  test('projects an approximately 500k-token source into a 256k destination budget', () => {
    const messages = largeHistory();
    const sourceTokens = projectionMessagesTokenUpperBound(messages);
    const plan = planContextWindowProjection({ ...params, messages });
    expect(sourceTokens).toBeGreaterThan(490_000);
    expect(plan.required).toBe(true);
    expect(plan.checkpointSourceMessageCount).toBeGreaterThan(0);
    expect(plan.recentTailMessageCount).toBeGreaterThan(0);
    expect(plan.checkpointBudgetTokens + plan.recentTailTokens).toBeLessThanOrEqual(
      plan.targetInputBudget,
    );
    expect(
      plan.targetInputBudget + params.reservedOutputTokens + params.stableOverheadTokens,
    ).toBeLessThan(params.targetWindow);
  });

  test('the same canonical 500k history fits again when switching back to a 1M model', () => {
    const messages = largeHistory();
    const downshift = planContextWindowProjection({ ...params, messages });
    const switchBack = planContextWindowProjection({
      ...params,
      messages,
      targetModel: 'large-1m-model',
      targetWindow: 1_000_000,
    });
    expect(downshift.required).toBe(true);
    expect(switchBack.required).toBe(false);
    expect(switchBack.recentTailMessageCount).toBe(messages.length);
  });

  test('planning is non-destructive and deterministic', () => {
    const messages = largeHistory();
    const before = messages.map((message) => ({ ...message }));
    const first = planContextWindowProjection({ ...params, messages });
    const second = planContextWindowProjection({ ...params, messages });
    expect(messages).toEqual(before);
    expect(second.projectionHash).toBe(first.projectionHash);
    expect(second.checkpointKey).toBe(first.checkpointKey);
  });

  test('checkpoint identity is model-independent for the same source prefix and budget', () => {
    const messages = largeHistory();
    const first = planContextWindowProjection({ ...params, messages });
    const second = planContextWindowProjection({
      ...params,
      messages,
      targetModel: 'different-provider:model',
    });
    expect(second.checkpointKey).toBe(first.checkpointKey);
    expect(second.projectionHash).toBe(first.projectionHash);
  });

  test('a small append reuses the checkpoint and becomes only a recent-tail delta', () => {
    const prefix: ProjectableContextMessage = { role: 'user', content: 'p'.repeat(1_600_000) };
    const tail: ProjectableContextMessage[] = [
      { role: 'assistant', content: 'a'.repeat(12_000) },
      { role: 'user', content: 'b'.repeat(12_000) },
    ];
    const first = planContextWindowProjection({ ...params, messages: [prefix, ...tail] });
    const appended = planContextWindowProjection({
      ...params,
      sourceContextKey: 'session-1:revision-7:new-message',
      messages: [prefix, ...tail, { role: 'assistant', content: 'delta'.repeat(400) }],
    });
    expect(first.required).toBe(true);
    expect(appended.required).toBe(true);
    expect(appended.checkpointKey).toBe(first.checkpointKey);
    expect(appended.sourceHash).not.toBe(first.sourceHash);
    expect(appended.projectionHash).not.toBe(first.projectionHash);
    expect(buildProjectionCheckpointMessage(first, 'same').content).toBe(
      buildProjectionCheckpointMessage(appended, 'same').content,
    );
  });

  test('rewinding inside the recent tail keeps reusable checkpoint identity', () => {
    const prefix: ProjectableContextMessage = { role: 'user', content: 'p'.repeat(1_600_000) };
    const base = [prefix, { role: 'assistant', content: 'tail'.repeat(2_000) }];
    const branch = [...base, { role: 'user', content: 'branch'.repeat(1_000) }];
    const projectedBranch = planContextWindowProjection({ ...params, messages: branch });
    const projectedRewind = planContextWindowProjection({
      ...params,
      sourceContextKey: 'session-1:rewound',
      messages: base,
    });
    expect(projectedRewind.checkpointKey).toBe(projectedBranch.checkpointKey);
    expect(projectedRewind.projectionHash).not.toBe(projectedBranch.projectionHash);
  });

  test('a rewind that changes checkpoint source invalidates only that checkpoint', () => {
    const first = planContextWindowProjection({ ...params, messages: largeHistory() });
    const changed = largeHistory();
    changed[0] = { role: 'user', content: 'different'.repeat(2_000) };
    const second = planContextWindowProjection({
      ...params,
      sourceContextKey: 'session-1:alternate-branch',
      messages: changed,
    });
    expect(second.checkpointKey).not.toBe(first.checkpointKey);
  });

  test('recent tail never starts with an orphaned tool result', () => {
    const messages: ProjectableContextMessage[] = [
      { role: 'user', content: 'old'.repeat(500_000) },
      { role: 'tool', tool_call_id: 'call-1', content: 'tool'.repeat(40_000) },
      { role: 'assistant', content: 'after tool' },
      { role: 'user', content: 'latest question' },
    ];
    const plan = planContextWindowProjection({ ...params, messages });
    expect(plan.required).toBe(true);
    expect(plan.recentTail[0]?.role).not.toBe('tool');
    expect(plan.recentTail.at(-1)?.content).toBe('latest question');
  });

  test('projection transcript chunks stay within the destination summarizer budget', () => {
    const messages: ProjectableContextMessage[] = [
      { role: 'user', content: 'z'.repeat(900_000) },
      { role: 'assistant', content: 'y'.repeat(600_000) },
    ];
    const chunks = chunkProjectionTranscript(messages, 32_000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => Math.ceil(chunk.length / 4) <= 32_000)).toBe(true);
  });

  test('image payloads are redacted from summarizer transcripts', () => {
    const chunks = chunkProjectionTranscript(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            { type: 'image', imageMimeType: 'image/png', imageData: 'A'.repeat(100_000) },
          ],
        },
      ],
      10_000,
    );
    expect(chunks.join('\n')).toContain('image/png attachment retained in canonical history');
    expect(chunks.join('\n')).not.toContain('A'.repeat(100));
  });

  test('audio and video bytes never leak into text summarizer transcripts', () => {
    const chunks = chunkProjectionTranscript(
      [
        {
          role: 'user',
          content: [
            { type: 'audio', mediaMimeType: 'audio/wav', mediaData: 'A'.repeat(100_000) },
            { type: 'video', mediaMimeType: 'video/mp4', mediaData: 'B'.repeat(100_000) },
          ],
        },
      ],
      10_000,
    );
    expect(chunks.join('\n')).toContain('audio/wav attachment retained in canonical history');
    expect(chunks.join('\n')).toContain('video/mp4 attachment retained in canonical history');
    expect(chunks.join('\n')).not.toContain('A'.repeat(100));
    expect(chunks.join('\n')).not.toContain('B'.repeat(100));
  });

  test('a single screenshot never exceeds a 1M-token window', () => {
    // 1.4 MB PNG, base64 expanded, exactly what the composer sends.
    const imageData = 'A'.repeat(Math.ceil((1_400_000 * 4) / 3));
    const message: ProjectableContextMessage = {
      role: 'user',
      content: [{ type: 'image', imageMimeType: 'image/png', imageData }],
    };
    // Clamped image ceiling plus the 7-token role/envelope overhead.
    const tokens = projectionMessagesTokenUpperBound([message]);
    expect(tokens).toBe(4_103);
    expect(tokens).toBeLessThan(1_000_000);

    const plan = planContextWindowProjection({
      ...params,
      targetModel: 'gemini-4-argon',
      targetWindow: 1_000_000,
      messages: [message],
    });
    expect(plan.sourceTokens).toBe(4_103);
    expect(plan.required).toBe(false);
  });

  test('rendered image geometry is billed, not the base64 payload', () => {
    // Identical payload in both, so any difference comes from geometry alone.
    const payload = 'A'.repeat(1_866_667);
    const envelope = 7;
    const small = projectionMessagesTokenUpperBound([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            imageMimeType: 'image/png',
            imageData: payload,
            width: 800,
            height: 600,
          },
        ],
      },
    ]);
    const large = projectionMessagesTokenUpperBound([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            imageMimeType: 'image/png',
            imageData: payload,
            width: 4000,
            height: 3000,
          },
        ],
      },
    ]);
    // 800x600 -> 480k pixels -> ~640 tokens -> clamped up to the floor.
    expect(small).toBe(1_024 + envelope);
    // 4000x3000 -> 12M pixels -> clamped down to the ceiling.
    expect(large).toBe(4_096 + envelope);
    expect(large).toBeLessThan(1_000_000);
  });

  test('a payload-free image block still reserves a full image', () => {
    const tokens = projectionMessagesTokenUpperBound([
      { role: 'user', content: [{ type: 'image', imageMimeType: 'image/png' }] },
    ]);
    // 4096 ceiling plus the role/envelope overhead; a CLI-harness transcript
    // reference is still an image the provider will bill for.
    expect(tokens).toBe(4_103);
  });

  test('a max-size audio or video attachment cannot trip the window guard alone', () => {
    // 15 MB (MAX_CHAT_MEDIA_BYTES) base64-expanded: ~20M characters.
    const mediaData = 'A'.repeat(Math.ceil((15 * 1024 * 1024 * 4) / 3));
    for (const type of ['audio', 'video'] as const) {
      const tokens = projectionMessagesTokenUpperBound([
        { role: 'user', content: [{ type, mediaMimeType: 'video/mp4', mediaData }] },
      ]);
      // Clamped to the per-attachment ceiling plus envelope overhead.
      expect(tokens).toBe(32_768 + 7);
      expect(tokens).toBeLessThan(1_000_000);
    }
  });
});
