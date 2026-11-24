import { describe, expect, it } from 'vitest';
import {
  isAffirmative,
  isDestructiveIntent,
  isNegative,
  matchWakePhrase,
  parseAgentTarget,
  parseConductorUtterance,
  parseOrdinal,
  type ConductorIntent,
} from './grammar';

const parse = parseConductorUtterance;

describe('parseOrdinal', () => {
  it.each([
    ['two', false, 2],
    ['2', false, 2],
    ['#2', false, 2],
    ['2nd', false, 2],
    ['second', false, 2],
    ['third', false, 3],
    ['3rd', false, 3],
    ['ten', false, 10],
    ['to', true, 2],
    ['too', true, 2],
    ['for', true, 4],
    ['won', true, 1],
  ] as const)('%s (afterNoun=%s) → %d', (word, afterNoun, expected) => {
    expect(parseOrdinal(word, afterNoun)).toBe(expected);
  });

  it('only reads homophones after a worker noun', () => {
    expect(parseOrdinal('to')).toBeNull();
    expect(parseOrdinal('for')).toBeNull();
    expect(parseOrdinal('banana', true)).toBeNull();
    expect(parseOrdinal('0')).toBeNull();
  });
});

describe('parseAgentTarget', () => {
  it.each([
    ['worker two', { kind: 'ordinal', index: 2 }],
    ['worker 2', { kind: 'ordinal', index: 2 }],
    ['Worker #2', { kind: 'ordinal', index: 2 }],
    ['worker number two', { kind: 'ordinal', index: 2 }],
    ['worker to', { kind: 'ordinal', index: 2 }],
    ['the second worker', { kind: 'ordinal', index: 2 }],
    ['2nd agent', { kind: 'ordinal', index: 2 }],
    ['agent three', { kind: 'ordinal', index: 3 }],
    ['sub-agent 1', { kind: 'ordinal', index: 1 }],
    ['subagent one', { kind: 'ordinal', index: 1 }],
    ['the first agent', { kind: 'ordinal', index: 1 }],
    ['the critic', { kind: 'role', role: 'critic' }],
    ['critic', { kind: 'role', role: 'critic' }],
    ['the reviewer', { kind: 'role', role: 'reviewer' }],
    ['the coder', { kind: 'role', role: 'coder' }],
    ['the coding agent', { kind: 'role', role: 'coder' }],
    ['the manager', { kind: 'manager' }],
    ['Kory', { kind: 'manager' }],
    ['everything', { kind: 'all' }],
    ['all agents', { kind: 'all' }],
    ['all the workers', { kind: 'all' }],
    ['Ada', { kind: 'name', name: 'ada' }],
  ])('%s', (phrase, expected) => {
    expect(parseAgentTarget(phrase)).toEqual(expected);
  });

  it('rejects sentences that are not targets', () => {
    expect(parseAgentTarget('the thing that broke the build yesterday')).toBeNull();
  });
});

type Case = [string, ConductorIntent];

describe('status', () => {
  const cases: Case[] = [
    ['status', { type: 'status', target: { kind: 'all' } }],
    ['Status.', { type: 'status', target: { kind: 'all' } }],
    ['What are the agents doing?', { type: 'status', target: { kind: 'all' } }],
    ["what's everyone doing", { type: 'status', target: { kind: 'all' } }],
    ['what are the workers working on', { type: 'status', target: { kind: 'all' } }],
    ["how's it going", { type: 'status', target: { kind: 'all' } }],
    ['give me a status update', { type: 'status', target: { kind: 'all' } }],
    ['are we done', { type: 'status', target: { kind: 'all' } }],
    ['what is the manager doing', { type: 'status', target: { kind: 'manager' } }],
    ['what is worker two doing', { type: 'status', target: { kind: 'ordinal', index: 2 } }],
    ["what's worker 3 up to", { type: 'status', target: { kind: 'ordinal', index: 3 } }],
    ['how is the critic doing', { type: 'status', target: { kind: 'role', role: 'critic' } }],
    ['is the reviewer done', { type: 'status', target: { kind: 'role', role: 'reviewer' } }],
    ['status of worker one', { type: 'status', target: { kind: 'ordinal', index: 1 } }],
    ['um, status please', { type: 'status', target: { kind: 'all' } }],
  ];
  it.each(cases)('%s', (text, expected) => expect(parse(text)).toEqual(expected));
});

describe('stop / cancel', () => {
  const cases: Case[] = [
    ['stop', { type: 'stop', target: { kind: 'all' } }],
    ['Stop!', { type: 'stop', target: { kind: 'all' } }],
    ['cancel', { type: 'stop', target: { kind: 'all' } }],
    ['cancel all', { type: 'stop', target: { kind: 'all' } }],
    ['stop everything', { type: 'stop', target: { kind: 'all' } }],
    ['stop all agents', { type: 'stop', target: { kind: 'all' } }],
    ['stop it now', { type: 'stop', target: { kind: 'all' } }],
    ['abort', { type: 'stop', target: { kind: 'all' } }],
    ['stop worker two', { type: 'stop', target: { kind: 'ordinal', index: 2 } }],
    ['stop worker 2', { type: 'stop', target: { kind: 'ordinal', index: 2 } }],
    ['Stop worker to.', { type: 'stop', target: { kind: 'ordinal', index: 2 } }],
    ['stop the second worker', { type: 'stop', target: { kind: 'ordinal', index: 2 } }],
    ['cancel agent number 3', { type: 'stop', target: { kind: 'ordinal', index: 3 } }],
    ['kill worker four', { type: 'stop', target: { kind: 'ordinal', index: 4 } }],
    ['stop the critic', { type: 'stop', target: { kind: 'role', role: 'critic' } }],
    ['cancel the reviewer', { type: 'stop', target: { kind: 'role', role: 'reviewer' } }],
    ['stop the manager', { type: 'stop', target: { kind: 'manager' } }],
    ['please stop Ada', { type: 'stop', target: { kind: 'name', name: 'ada' } }],
  ];
  it.each(cases)('%s', (text, expected) => expect(parse(text)).toEqual(expected));

  it('does not treat "stop reading" as stopping agents', () => {
    expect(parse('stop reading')).toEqual({ type: 'stop_reading' });
    expect(parse('stop talking')).toEqual({ type: 'stop_reading' });
    expect(parse('be quiet')).toEqual({ type: 'stop_reading' });
  });

  it('does not treat an instruction as a stop target', () => {
    expect(parse('stop working on the parser and write tests first').type).toBe('unknown');
  });

  it('marks stop and delete as destructive', () => {
    expect(isDestructiveIntent(parse('stop worker two'))).toBe(true);
    expect(isDestructiveIntent(parse('delete this chat'))).toBe(true);
    expect(isDestructiveIntent(parse('status'))).toBe(false);
    expect(isDestructiveIntent(parse('new chat'))).toBe(false);
  });
});

describe('steer', () => {
  const cases: Case[] = [
    [
      'tell the manager to run the tests again',
      { type: 'steer', target: { kind: 'manager' }, message: 'Run the tests again' },
    ],
    [
      'Tell Kory to focus on the API, not the UI.',
      { type: 'steer', target: { kind: 'manager' }, message: 'Focus on the API, not the UI' },
    ],
    [
      'ask the manager to use Postgres',
      { type: 'steer', target: { kind: 'manager' }, message: 'Use Postgres' },
    ],
    [
      'tell it to skip the migration',
      { type: 'steer', target: { kind: 'manager' }, message: 'Skip the migration' },
    ],
    [
      'tell worker two to add logging',
      { type: 'steer', target: { kind: 'ordinal', index: 2 }, message: 'Add logging' },
    ],
    [
      'ask the critic to check edge cases',
      { type: 'steer', target: { kind: 'role', role: 'critic' }, message: 'Check edge cases' },
    ],
    [
      'steer: prefer small commits',
      { type: 'steer', target: { kind: 'manager' }, message: 'Prefer small commits' },
    ],
  ];
  it.each(cases)('%s', (text, expected) => expect(parse(text)).toEqual(expected));
});

describe('chats', () => {
  const cases: Case[] = [
    ['new chat', { type: 'new_chat' }],
    ['start a new chat', { type: 'new_chat' }],
    ['new chat about the billing bug', { type: 'new_chat', topic: 'The billing bug' }],
    ['Start a new session about Release notes.', { type: 'new_chat', topic: 'Release notes' }],
    ['create a chat called Onboarding', { type: 'new_chat', topic: 'Onboarding' }],
    ['open chat Billing refactor', { type: 'switch_chat', query: 'Billing refactor' }],
    ['switch to the chat about login', { type: 'switch_chat', query: 'login' }],
    ['go to the release chat', { type: 'switch_chat', query: 'release' }],
    ['open the Payments session', { type: 'switch_chat', query: 'Payments' }],
    ['delete this chat', { type: 'delete_chat' }],
    ['remove the current conversation', { type: 'delete_chat' }],
  ];
  it.each(cases)('%s', (text, expected) => expect(parse(text)).toEqual(expected));
});

describe('panels', () => {
  const cases: Case[] = [
    ['open notes', { type: 'open_panel', panel: 'notes' }],
    ['show my notes', { type: 'open_panel', panel: 'notes' }],
    ['open the terminal', { type: 'open_panel', panel: 'terminal' }],
    ['show the terminal panel', { type: 'open_panel', panel: 'terminal' }],
    ['open settings', { type: 'open_panel', panel: 'settings' }],
    ['bring up preferences', { type: 'open_panel', panel: 'settings' }],
    ['open voice settings', { type: 'open_panel', panel: 'voice_settings' }],
    ['show the agents', { type: 'open_panel', panel: 'agents' }],
  ];
  it.each(cases)('%s', (text, expected) => expect(parse(text)).toEqual(expected));
});

describe('notes, reading, undo, confirmation', () => {
  const cases: Case[] = [
    ['note that the API is rate limited', { type: 'note', text: 'The API is rate limited' }],
    ['take a note: call Sam on Friday', { type: 'note', text: 'Call Sam on Friday' }],
    ['make a note that staging is down', { type: 'note', text: 'Staging is down' }],
    ['jot down buy more GPUs', { type: 'note', text: 'Buy more GPUs' }],
    ['read the last reply', { type: 'read_aloud' }],
    ['read it back', { type: 'read_aloud' }],
    ['read me the last response', { type: 'read_aloud' }],
    ['read that out loud', { type: 'read_aloud' }],
    ['what did Kory say', { type: 'read_aloud' }],
    ['undo', { type: 'undo' }],
    ['undo that', { type: 'undo' }],
    ['yes', { type: 'confirm' }],
    ['go ahead', { type: 'confirm' }],
    ['no', { type: 'deny' }],
    ['never mind', { type: 'deny' }],
  ];
  it.each(cases)('%s', (text, expected) => expect(parse(text)).toEqual(expected));

  it('recognises confirmation answers', () => {
    for (const yes of ['yes', 'Yes.', 'yeah', 'yep', 'confirm', 'do it', 'go ahead'])
      expect(isAffirmative(yes)).toBe(true);
    for (const no of ['no', 'Nope', 'cancel', 'never mind', "don't"]) expect(isNegative(no)).toBe(true);
    expect(isAffirmative('yes and also refactor the parser')).toBe(false);
  });
});

describe('unknown', () => {
  it.each([
    'refactor the parser to use a state machine',
    'I think the build is flaky',
    'say',
    'open',
  ])('%s', (text) => {
    expect(parse(text).type).toBe('unknown');
  });

  it('keeps the cleaned wording for the fallback', () => {
    expect(parse('  Refactor the parser please. ')).toEqual({
      type: 'unknown',
      text: 'Refactor the parser',
    });
  });
});

describe('matchWakePhrase', () => {
  it.each([
    ['Kory, stop', true, true, 'stop'],
    ['Hey Kory stop worker two', true, true, 'stop worker two'],
    ['hey kory, what are the agents doing', true, true, 'what are the agents doing'],
    ['OK Kory. Status', true, true, 'Status'],
    ['Corey, status', true, true, 'status'],
    ['Kory status', true, false, 'status'],
    ['Kory is slow today', true, false, 'is slow today'],
  ])('%s', (text, matched, explicit, rest) => {
    expect(matchWakePhrase(text, 'Kory')).toEqual({ matched, explicit, rest });
  });

  it('does not match the name in the middle or as a prefix of a word', () => {
    expect(matchWakePhrase('Ask Kory about it', 'Kory').matched).toBe(false);
    expect(matchWakePhrase('Koryphaios is great', 'Kory').matched).toBe(false);
  });

  it('supports a custom phrase, including one that already has a greeting', () => {
    expect(matchWakePhrase('Computer, status', 'Computer')).toEqual({
      matched: true,
      explicit: true,
      rest: 'status',
    });
    expect(matchWakePhrase('hey maestro stop', 'Hey Maestro').rest).toBe('stop');
    expect(matchWakePhrase('maestro, stop', 'Hey Maestro').rest).toBe('stop');
    expect(matchWakePhrase('Corey, status', 'Computer').matched).toBe(false);
  });
});
