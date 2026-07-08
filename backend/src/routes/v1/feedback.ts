import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { deliverFeedback, type FeedbackSubmission } from '../../feedback/delivery';
import { RateLimiter } from '../../security/rate-limit';

const feedbackLimiter = new RateLimiter(5, 60 * 60_000);

export const feedbackRoutes = new Elysia({ prefix: '/api/feedback' }).post(
  '/',
  async ({ request, body, set }) => {
    const session = requireLocalRouteAuth(request, set);
    if (!session) return { ok: false, error: 'Unauthorized' };

    const rateCheck = feedbackLimiter.check(session.id);
    if (!rateCheck.allowed) {
      set.status = 429;
      set.headers['Retry-After'] = String(Math.max(1, Math.ceil(rateCheck.resetIn / 1000)));
      return { ok: false, error: 'Too many feedback reports. Please try again later.' };
    }

    const submission: FeedbackSubmission = {
      category: body.category,
      message: body.message.trim(),
      email: body.email?.trim() || undefined,
      appVersion: body.appVersion?.trim() || undefined,
      platform: body.platform?.trim() || undefined,
      context: body.context?.route ? { route: body.context.route.slice(0, 500) } : undefined,
    };

    if (!submission.message) {
      set.status = 400;
      return { ok: false, error: 'Tell us what happened before sending' };
    }

    const result = await deliverFeedback(submission);
    if (!result.ok) set.status = 502;
    return result;
  },
  {
    body: t.Object({
      category: t.Union([
        t.Literal('bug'),
        t.Literal('idea'),
        t.Literal('question'),
        t.Literal('other'),
      ]),
      message: t.String({ minLength: 1, maxLength: 8_000 }),
      email: t.Optional(t.String({ format: 'email', maxLength: 254 })),
      appVersion: t.Optional(t.String({ maxLength: 50 })),
      platform: t.Optional(t.String({ maxLength: 300 })),
      context: t.Optional(t.Object({ route: t.Optional(t.String({ maxLength: 500 })) })),
    }),
  },
);
