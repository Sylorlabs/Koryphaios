import { expect, test } from 'bun:test';
import { exactRecord, strictJson, validateAdjudication } from './reviewer-json';

const score = {
  passed: true,
  quality: 0.8,
  verification: 0.7,
  integrityFailure: false,
  evidence: ['observed only'],
};
const review = { artifactA: score, artifactB: score, preference: 'tie', rationale: ['equal'] };

test('strict parser preserves legal primitive/array/object values and escaped delimiters', () => {
  for (const value of [
    null,
    true,
    false,
    1,
    -2.5e3,
    'quote"\\\n新',
    [],
    {},
    [{ value: '[]{}:,', nested: [null, false] }],
  ]) {
    const text = JSON.stringify(value);
    expect(strictJson(` \n\t${text}\r `)).toEqual(value);
  }
  expect(strictJson('{"constructor":1,"__proto__":2}')).toEqual(
    JSON.parse('{"constructor":1,"__proto__":2}'),
  );
});

for (const text of [
  '',
  'undefined',
  'NaN',
  'Infinity',
  '+1',
  '01',
  '.2',
  '1.',
  '1e',
  '{',
  '[',
  '{"x":1,}',
  '[1,]',
  '{x:1}',
  '{"x" 1}',
  '[1 2]',
  'true false',
  'null trailing',
  '{"x":1,"x":2}',
  '{"x":1,"\\u0078":2}',
  '[{"x":1,"x":2}]',
  '"raw\nnewline"',
  '"\\x20"',
  '"unterminated',
  '﻿{}',
  '['.repeat(22) + '0' + ']'.repeat(22),
]) {
  test(`strict parser rejects malformed/duplicate/excess-depth JSON ${JSON.stringify(text).slice(0, 55)}`, () => {
    expect(() => strictJson(text)).toThrow();
  });
}

test('exactRecord validates own fields without mutating caller schema', () => {
  const keys = Object.freeze(['b', 'a']);
  expect(exactRecord({ a: 1, b: 2 }, keys)).toEqual({ a: 1, b: 2 });
  expect(keys).toEqual(['b', 'a']);
  for (const value of [null, [], {}, { a: 1 }, { a: 1, b: 2, tool: {} }]) {
    expect(() => exactRecord(value, keys)).toThrow();
  }
});

test('adjudication validates exact supported scores without rewriting output', () => {
  expect(() => validateAdjudication(JSON.stringify(review, null, 2))).not.toThrow();
  for (const field of ['artifactA', 'artifactB']) {
    for (const bad of [
      { ...score, passed: 'true' },
      { ...score, quality: -0.1 },
      { ...score, verification: 1.1 },
      { ...score, evidence: [1] },
      { ...score, integrityFailure: null },
      { ...score, tool: 'hidden' },
    ]) {
      expect(() => validateAdjudication(JSON.stringify({ ...review, [field]: bad }))).toThrow();
    }
  }
  expect(() =>
    validateAdjudication(JSON.stringify({ ...review, preference: 'unknown' })),
  ).toThrow();
  expect(() => validateAdjudication(JSON.stringify({ ...review, rationale: [1] }))).toThrow();
  expect(() => validateAdjudication(JSON.stringify({ ...review, error: 'hidden' }))).toThrow();
  expect(() => validateAdjudication(JSON.stringify(review).replace('0.8', '1e999'))).toThrow();
});
