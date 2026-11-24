import type { KoryAskUserPayload, KorySessionChangesPayload } from '@koryphaios/shared';

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Missing legacy fields are different from malformed, explicitly supplied identity. */
function validIdentity(value: Record<string, unknown>, key: string): boolean {
  return !own(value, key) || nonempty(value[key]);
}

export function readReview(value: unknown): KorySessionChangesPayload | null {
  if (
    !record(value) ||
    !Array.isArray(value.changes) ||
    !validIdentity(value, 'reviewId') ||
    !validIdentity(value, 'reviewRevision') ||
    (own(value, 'reviewRevision') && !own(value, 'reviewId'))
  )
    return null;
  if (
    !value.changes.every(
      (change) =>
        record(change) &&
        typeof change.path === 'string' &&
        Number.isFinite(change.linesAdded) &&
        Number.isFinite(change.linesDeleted),
    )
  )
    return null;
  return value as unknown as KorySessionChangesPayload;
}

export function sameReview(a: KorySessionChangesPayload, b: KorySessionChangesPayload): boolean {
  return (
    !!a.reviewId &&
    !!a.reviewRevision &&
    a.reviewId === b.reviewId &&
    a.reviewRevision === b.reviewRevision
  );
}

export function isReviewResolution(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    typeof value.status === 'string' &&
    ['accepted', 'rejected', 'terminalized', 'not_pending'].includes(value.status) &&
    validIdentity(value, 'reviewId') &&
    validIdentity(value, 'reviewRevision') &&
    (own(value, 'reviewId') || (!own(value, 'reviewRevision') && value.status === 'not_pending'))
  );
}

export function reviewResolutionMatches(
  current: KorySessionChangesPayload,
  value: unknown,
): boolean {
  if (!isReviewResolution(value)) return false;
  // Only literal identity absence plus not_pending denotes authoritative absence.
  if (!own(value, 'reviewId'))
    return !own(value, 'reviewRevision') && value.status === 'not_pending';
  if (value.reviewId !== current.reviewId) return false;
  return current.reviewRevision || own(value, 'reviewRevision')
    ? value.reviewRevision === current.reviewRevision
    : true;
}

export function readQuestion(value: unknown): KoryAskUserPayload | null {
  if (
    !record(value) ||
    typeof value.question !== 'string' ||
    !Array.isArray(value.options) ||
    !value.options.every((option) => typeof option === 'string') ||
    !validIdentity(value, 'questionId')
  )
    return null;
  return value as unknown as KoryAskUserPayload;
}

export function isQuestionResolution(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    typeof value.status === 'string' &&
    ['answered', 'cancelled', 'superseded', 'not_pending'].includes(value.status) &&
    validIdentity(value, 'questionId') &&
    (own(value, 'questionId') || value.status === 'not_pending')
  );
}

export function questionResolutionMatches(current: KoryAskUserPayload, value: unknown): boolean {
  if (!isQuestionResolution(value)) return false;
  return own(value, 'questionId')
    ? value.questionId === current.questionId
    : value.status === 'not_pending';
}
