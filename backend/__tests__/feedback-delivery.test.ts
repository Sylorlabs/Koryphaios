import { describe, expect, it, mock } from 'bun:test';
import { deliverFeedback, type FeedbackSubmission } from '../src/feedback/delivery';

const submission: FeedbackSubmission = {
  category: 'bug',
  message: 'The workspace stopped responding after reconnecting.',
  appVersion: '1.0.20',
  platform: 'Linux',
};

describe('feedback delivery', () => {
  it('posts the anonymous report to the configured receiver', async () => {
    const fetchImpl = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(submission);
      return Response.json({ ok: true, id: 'feedback_123' });
    }) as typeof fetch;

    const result = await deliverFeedback(submission, {
      endpoint: 'https://koryphaios.com/api/feedback',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, id: 'feedback_123' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe receiver URLs', async () => {
    const result = await deliverFeedback(submission, { endpoint: 'http://feedback.example.com' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('configured safely');
  });

  it('does not expose receiver response details to the client', async () => {
    const fetchImpl = mock(async () =>
      Response.json({ ok: false, error: 'RESEND_API_KEY is missing' }, { status: 503 }),
    ) as typeof fetch;

    const result = await deliverFeedback(submission, {
      endpoint: 'https://koryphaios.com/api/feedback',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, error: 'Feedback could not be delivered right now' });
  });
});
