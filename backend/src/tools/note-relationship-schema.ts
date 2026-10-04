import { NOTE_RELATIONSHIP_TYPES } from '@koryphaios/shared';

const id = { type: 'string', minLength: 1, maxLength: 2048 };
const revision = { type: 'integer', minimum: 1 };
export const proposeNoteRelationshipSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fromId: id,
    toId: id,
    type: { type: 'string', enum: [...NOTE_RELATIONSHIP_TYPES] },
    evidence: { type: 'string', minLength: 1, maxLength: 2000 },
    expectedSourceRevision: revision,
    expectedTargetRevision: revision,
    weight: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
  },
  required: [
    'fromId',
    'toId',
    'type',
    'evidence',
    'expectedSourceRevision',
    'expectedTargetRevision',
  ],
};
export const reviewNoteRelationshipSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fromId: id,
    toId: id,
    status: { type: 'string', enum: ['accepted', 'rejected'] },
    expectedRevision: revision,
  },
  required: ['fromId', 'toId', 'status', 'expectedRevision'],
};
